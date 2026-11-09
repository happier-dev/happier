import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import os from 'node:os';
import { basename } from 'node:path';
import { hasAcceptedBugReportArtifactKind, pushBugReportArtifact } from '@happier-dev/protocol/bugs/reports/artifacts';
import { inferBugReportDeploymentTypeFromServerUrl, sanitizeBugReportArtifactFileSegment, sanitizeBugReportArtifactPath, sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { resolveBugReportServerDiagnosticsLines } from '@happier-dev/protocol/bugs/reports/serverDiagnostics';
import { BUG_REPORT_LOG_SOURCE_KINDS, resolveBugReportLogSelection, type BugReportLogSelection, type BugReportSessionDiagnostics } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type { BugReportAttachmentArg } from './bugReportCommandArgs';
import type { BugReportArtifactPayload, BugReportEnvironmentPayload } from '@happier-dev/protocol';

import packageJson from '../../package.json';
import { readAccountChangesCursors, readSettings, readStoredCredentials } from '@/persistence';
import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsOnHost } from '@/diagnostics/bugReportMachineDiagnosticsLocalDaemon';
import { normalizeBaseUrl, withAbortTimeout } from '@/diagnostics/httpClient';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

export type CollectBugReportDiagnosticsArtifactsInput = {
  includeDiagnostics: boolean;
  acceptedKinds: string[];
  maxArtifactBytes: number;
  contextWindowMs?: number;
  serverUrl: string;
  activeServerId: string;
  rawArgs: string[];
  sessionId?: string;
  logSelection?: Partial<BugReportLogSelection>;
  extraAttachments?: BugReportAttachmentArg[];
};

export type CollectBugReportDiagnosticsArtifactsResult = {
  artifacts: BugReportArtifactPayload[];
  environment: BugReportEnvironmentPayload;
};

function summarizeInvocationArgs(rawArgs: string[]): {
  rawArgCount: number;
  positionalArgCount: number;
  flags: string[];
} {
  const normalizeFlag = (rawFlag: string): string => {
    const value = rawFlag.trim();
    if (!value.startsWith('-')) return '';
    const equalsIndex = value.indexOf('=');
    const withoutValue = equalsIndex >= 0 ? value.slice(0, equalsIndex) : value;
    return withoutValue.trim();
  };

  const flags: string[] = [];
  let positionalArgCount = 0;
  for (const entry of rawArgs) {
    const arg = String(entry ?? '').trim();
    if (!arg) continue;
    if (arg.startsWith('-')) {
      const normalizedFlag = normalizeFlag(arg);
      if (normalizedFlag) {
        flags.push(normalizedFlag);
      }
      continue;
    }
    positionalArgCount += 1;
  }
  return {
    rawArgCount: rawArgs.length,
    positionalArgCount,
    flags: Array.from(new Set(flags)).slice(0, 50),
  };
}

type DiagnosticsCollectionStatus = 'collected' | 'skipped' | 'error';

type DiagnosticsCollectionEntry = {
  status: DiagnosticsCollectionStatus;
  detail?: string;
};

function formatDiagnosticsCollectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return trimBugReportTextToMaxBytes(redactBugReportSensitiveText(message), 256).trim() || 'unknown error';
}

export async function collectBugReportDiagnosticsArtifacts(
  input: CollectBugReportDiagnosticsArtifactsInput,
): Promise<CollectBugReportDiagnosticsArtifactsResult> {
  const environment: BugReportEnvironmentPayload = {
    appVersion: String((packageJson as { version?: string }).version ?? 'unknown'),
    platform: process.platform,
    osVersion: os.release(),
    deploymentType: inferBugReportDeploymentTypeFromServerUrl(input.serverUrl),
    serverUrl: sanitizeBugReportUrl(input.serverUrl),
  };

  if (!input.includeDiagnostics) {
    return { artifacts: [], environment };
  }

  const artifacts: BugReportArtifactPayload[] = [];
  const limits = {
    maxArtifactBytes: input.maxArtifactBytes,
    acceptedKinds: input.acceptedKinds,
  };

  let credentialsToken: string | null = null;
  let accountId: string | null = null;
  let settingsActiveServerId: string | null = null;
  let settingsKnownAccountIds: string[] = [];
  let settingsServers: Array<{
    id: string;
    name: string;
    serverUrl: string;
    localServerUrl?: string;
    webappUrl: string;
    lastUsedAt: number;
  }> = [];

  try {
    const credentials = await readStoredCredentials();
    credentialsToken = credentials?.token ?? null;
    if (credentialsToken) {
      accountId = readAccountIdFromToken(credentialsToken) ?? accountId;
    }
  } catch {
    // optional
  }

  try {
    const settings = await readSettings();
    settingsActiveServerId = settings.activeServerId ? String(settings.activeServerId).trim() : null;

    const byServer = await readAccountChangesCursors();
    const accountIds: string[] = [];
    for (const map of Object.values(byServer)) {
      if (!map || typeof map !== 'object') continue;
      for (const key of Object.keys(map)) {
        const normalized = String(key ?? '').trim();
        if (normalized) accountIds.push(normalized);
      }
    }
    if (accountId) accountIds.push(accountId);
    settingsKnownAccountIds = Array.from(new Set(accountIds)).sort();

    settingsServers = Object.values(settings.servers ?? {})
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        id: String(entry.id ?? '').trim(),
        name: String(entry.name ?? '').trim(),
        serverUrl: sanitizeBugReportUrl(String(entry.serverUrl ?? '').trim()) ?? String(entry.serverUrl ?? '').trim(),
        localServerUrl: entry.localServerUrl
          ? (sanitizeBugReportUrl(String(entry.localServerUrl).trim()) ?? String(entry.localServerUrl).trim())
          : undefined,
        webappUrl: sanitizeBugReportUrl(String(entry.webappUrl ?? '').trim()) ?? String(entry.webappUrl ?? '').trim(),
        lastUsedAt: Number(entry.lastUsedAt ?? 0) || 0,
      }))
      .filter((entry) => entry.id && entry.name && entry.serverUrl && entry.webappUrl)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  } catch {
    // optional
  }

  const diagnosticsCollection: Record<string, DiagnosticsCollectionEntry> = {
    machineDiagnostics: { status: 'skipped', detail: 'not attempted' },
    serverDiagnostics: { status: 'skipped', detail: 'source kind not accepted or log collection disabled' },
    extraAttachments: { status: 'skipped', detail: 'no attachments provided' },
  };
  const logSelection = resolveBugReportLogSelection(input.logSelection);
  let sessionDiagnostics: BugReportSessionDiagnostics | undefined;
  try {
    const snapshot = await collectBugReportMachineDiagnosticsOnHost({
      sessionId: input.sessionId,
      logSelection: {
        daemon: logSelection.daemon && hasAcceptedBugReportArtifactKind(input.acceptedKinds, BUG_REPORT_LOG_SOURCE_KINDS.daemon),
        session: logSelection.session && hasAcceptedBugReportArtifactKind(input.acceptedKinds, BUG_REPORT_LOG_SOURCE_KINDS.session),
        provider: logSelection.provider && hasAcceptedBugReportArtifactKind(input.acceptedKinds, BUG_REPORT_LOG_SOURCE_KINDS.provider),
      },
    }, { maxArtifactBytes: input.maxArtifactBytes });
    sessionDiagnostics = snapshot.sessionDiagnostics;
    diagnosticsCollection.machineDiagnostics = { status: 'collected' };
    for (const entry of sessionDiagnostics?.logs ?? []) {
      if (entry.status === 'collected' && entry.artifact) pushBugReportArtifact(artifacts, entry.artifact, limits);
    }
    pushBugReportArtifact(artifacts, {
      filename: 'daemon-summary.json', sourceKind: 'daemon', contentType: 'application/json',
      content: JSON.stringify({ daemonState: snapshot.daemonState, runtime: snapshot.runtime }, null, 2),
    }, limits);
  } catch (error) {
    diagnosticsCollection.machineDiagnostics = { status: 'error', detail: formatDiagnosticsCollectionError(error) };
  }

  if (logSelection.daemon && hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'server')) {
    diagnosticsCollection.serverDiagnostics = { status: 'skipped', detail: 'missing credentials token' };
    try {
      if (credentialsToken) {
        diagnosticsCollection.serverDiagnostics = { status: 'skipped', detail: 'server diagnostics endpoint unavailable' };
        const lines = resolveBugReportServerDiagnosticsLines(input.contextWindowMs);
        await withAbortTimeout(6_000, async (signal) => {
          const response = await fetchWithCredentialRedirectRefusal(`${normalizeBaseUrl(input.serverUrl)}/v1/diagnostics/bug-report-snapshot?lines=${lines}`, {
            method: 'GET',
            headers: {
              ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
              Authorization: `Bearer ${credentialsToken}`,
            },
            signal,
          });
          if (response.ok) {
            pushBugReportArtifact(artifacts, {
              filename: 'server-diagnostics.json',
              sourceKind: 'server',
              contentType: 'application/json',
              content: await response.text(),
            }, limits);
            diagnosticsCollection.serverDiagnostics = { status: 'collected' };
          } else if (response.status === 404) {
            diagnosticsCollection.serverDiagnostics = { status: 'skipped', detail: 'server diagnostics endpoint disabled (404)' };
          } else {
            diagnosticsCollection.serverDiagnostics = { status: 'error', detail: `server responded with status ${response.status}` };
          }
        });
      }
    } catch (error) {
      if (error instanceof CredentialRequestRedirectError) throw error;
      diagnosticsCollection.serverDiagnostics = { status: 'error', detail: formatDiagnosticsCollectionError(error) };
    }
  }

  for (const attachment of input.extraAttachments ?? []) {
    if (!hasAcceptedBugReportArtifactKind(input.acceptedKinds, attachment.sourceKind)) continue;
    try {
      const content = await readBugReportLogTail(attachment.path, Math.min(input.maxArtifactBytes, 1_000_000));
      pushBugReportArtifact(artifacts, {
        filename: sanitizeBugReportArtifactFileSegment(basename(attachment.path)),
        sourceKind: attachment.sourceKind, contentType: 'text/plain', content,
      }, limits);
      diagnosticsCollection.extraAttachments = { status: 'collected' };
    } catch (error) {
      diagnosticsCollection.extraAttachments = { status: 'error', detail: formatDiagnosticsCollectionError(error) };
    }
  }

  pushBugReportArtifact(artifacts, {
    filename: 'cli-context.json',
    sourceKind: 'cli',
    contentType: 'application/json',
    content: JSON.stringify({
      capturedAt: new Date().toISOString(),
      accountId,
      activeServerId: input.activeServerId,
      serverUrl: sanitizeBugReportUrl(input.serverUrl) ?? input.serverUrl,
      settingsActiveServerId,
      settingsKnownAccountIds,
      settingsServers,
      cwd: sanitizeBugReportArtifactPath(process.cwd()),
      platform: process.platform,
      nodeVersion: process.version,
      cliVersion: (packageJson as { version?: string }).version ?? 'unknown',
      contextWindowMs: input.contextWindowMs ?? null,
      invocationSummary: summarizeInvocationArgs(input.rawArgs),
      diagnosticsCollection,
      sessionDiagnostics: sessionDiagnostics ? {
        context: sessionDiagnostics.context,
        logs: sessionDiagnostics.logs.map(({ kind, status, detail }) => ({ kind, status, ...(detail ? { detail } : {}) })),
      } : undefined,
    }, null, 2),
  }, limits);

  return { artifacts, environment };
}
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
