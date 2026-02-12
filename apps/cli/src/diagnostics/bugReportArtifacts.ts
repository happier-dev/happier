import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  hasAcceptedBugReportArtifactKind,
  inferBugReportDeploymentTypeFromServerUrl,
  pushBugReportArtifact,
  redactBugReportSensitiveText,
  resolveBugReportServerDiagnosticsLines,
  sanitizeBugReportDaemonDiagnosticsPayload,
  sanitizeBugReportArtifactFileSegment,
  sanitizeBugReportArtifactPath,
  sanitizeBugReportStackContextPayload,
  sanitizeBugReportUrl,
  trimBugReportTextToMaxBytes,
  type BugReportArtifactPayload,
  type BugReportEnvironmentPayload,
} from '@happier-dev/protocol';

import packageJson from '../../package.json';
import { configuration } from '@/configuration';
import { readCredentials } from '@/persistence';
import { collectBugReportMachineDiagnosticsSnapshot, readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { normalizeBaseUrl, withAbortTimeout } from '@/diagnostics/httpClient';

export type CollectBugReportDiagnosticsArtifactsInput = {
  includeDiagnostics: boolean;
  acceptedKinds: string[];
  maxArtifactBytes: number;
  contextWindowMs?: number;
  serverUrl: string;
  activeServerId: string;
  rawArgs: string[];
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

async function readLatestLogTail(input: {
  maxBytes: number;
  suffix: string;
  invertSuffix?: boolean;
}): Promise<{ path: string; tail: string } | null> {
  if (!existsSync(configuration.logsDir)) return null;
  const entries = await readdir(configuration.logsDir);
  const candidates = await Promise.all(entries
    .filter((file) => file.endsWith('.log'))
    .filter((file) => {
      const matches = file.endsWith(input.suffix);
      return input.invertSuffix ? !matches : matches;
    })
    .map(async (file) => {
      const path = join(configuration.logsDir, file);
      const metadata = await stat(path);
      return { file, path, modified: metadata.mtimeMs };
    }));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.modified - a.modified);
  const selected = candidates[0];
  const tail = await readBugReportLogTail(selected.path, input.maxBytes);
  return {
    path: selected.path,
    tail,
  };
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

  const diagnosticsCollection: Record<string, DiagnosticsCollectionEntry> = {
    cliLog: { status: 'skipped', detail: 'not attempted' },
    machineDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
    daemonLogTails: { status: 'skipped', detail: 'source kind not accepted' },
    stackLogTails: { status: 'skipped', detail: 'source kind not accepted' },
    serverDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
  };

  try {
    if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'cli')) {
      diagnosticsCollection.cliLog = { status: 'skipped', detail: 'no matching cli log file' };
      const latestCliLog = await readLatestLogTail({
        maxBytes: Math.min(150_000, input.maxArtifactBytes),
        suffix: '-daemon.log',
        invertSuffix: true,
      });
      if (latestCliLog && latestCliLog.tail.trim()) {
        pushBugReportArtifact(artifacts, {
          filename: 'cli.log',
          sourceKind: 'cli',
          contentType: 'text/plain',
          content: latestCliLog.tail,
        }, limits);
        diagnosticsCollection.cliLog = { status: 'collected' };
      }
    }
  } catch (error) {
    diagnosticsCollection.cliLog = { status: 'error', detail: formatDiagnosticsCollectionError(error) };
  }

  if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'daemon', 'stack-service')) {
    diagnosticsCollection.machineDiagnostics = { status: 'skipped', detail: 'no diagnostics payload available' };
    if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'daemon')) {
      diagnosticsCollection.daemonLogTails = { status: 'skipped', detail: 'no daemon log tail available' };
    }
    if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'stack-service')) {
      diagnosticsCollection.stackLogTails = { status: 'skipped', detail: 'no stack log tail available' };
    }
    try {
      const machineDiagnostics = await collectBugReportMachineDiagnosticsSnapshot({
        daemonLogLimit: 3,
        stackLogLimit: 3,
        stackRuntimeMaxChars: 400_000,
      });
      diagnosticsCollection.machineDiagnostics = { status: 'collected' };

      if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'daemon')) {
        const daemonDiagnostics = sanitizeBugReportDaemonDiagnosticsPayload(machineDiagnostics);
        pushBugReportArtifact(artifacts, {
          filename: 'daemon-summary.json',
          sourceKind: 'daemon',
          contentType: 'application/json',
          content: JSON.stringify({
            daemonState: daemonDiagnostics.daemonState,
            logs: daemonDiagnostics.daemonLogs,
            runtime: daemonDiagnostics.runtime,
          }, null, 2),
        }, limits);
      }

      if (machineDiagnostics.stackContext && hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'stack-service')) {
        const stackContext = sanitizeBugReportStackContextPayload(machineDiagnostics.stackContext);
        pushBugReportArtifact(artifacts, {
          filename: 'stack-context.json',
          sourceKind: 'stack-service',
          contentType: 'application/json',
          content: JSON.stringify(stackContext, null, 2),
        }, limits);

        if (machineDiagnostics.stackContext.runtimeState) {
          pushBugReportArtifact(artifacts, {
            filename: 'stack-runtime.json',
            sourceKind: 'stack-service',
            contentType: 'application/json',
            content: machineDiagnostics.stackContext.runtimeState,
          }, limits);
        }
      }

      if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'daemon')) {
        const daemonLogPath = machineDiagnostics.daemonState?.daemonLogPath || machineDiagnostics.daemonLogs[0]?.path || null;
        if (daemonLogPath) {
          try {
            const daemonTail = await readBugReportLogTail(daemonLogPath, Math.min(150_000, input.maxArtifactBytes));
            pushBugReportArtifact(artifacts, {
              filename: 'daemon.log',
              sourceKind: 'daemon',
              contentType: 'text/plain',
              content: daemonTail,
            }, limits);
            diagnosticsCollection.daemonLogTails = { status: 'collected' };
          } catch {
            // Optional artifact.
          }
        }
      }

      if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'stack-service')) {
        const stackLogPaths = machineDiagnostics.stackContext?.logCandidates ?? [];
        for (const stackLogPath of stackLogPaths.slice(0, 2)) {
          let stackTail = '';
          try {
            stackTail = await readBugReportLogTail(stackLogPath, Math.min(150_000, input.maxArtifactBytes));
          } catch {
            continue;
          }
          const sanitizedStackLogName = sanitizeBugReportArtifactPath(stackLogPath) ?? 'stack.log';
          pushBugReportArtifact(artifacts, {
            filename: `stack-${sanitizeBugReportArtifactFileSegment(sanitizedStackLogName)}.log`,
            sourceKind: 'stack-service',
            contentType: 'text/plain',
            content: stackTail,
          }, limits);
          diagnosticsCollection.stackLogTails = { status: 'collected' };
        }
      }
    } catch (error) {
      diagnosticsCollection.machineDiagnostics = { status: 'error', detail: formatDiagnosticsCollectionError(error) };
    }
  }

  if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'server')) {
    diagnosticsCollection.serverDiagnostics = { status: 'skipped', detail: 'missing credentials token' };
    try {
      const credentials = await readCredentials();
      if (credentials?.token) {
        diagnosticsCollection.serverDiagnostics = { status: 'skipped', detail: 'server diagnostics endpoint unavailable' };
        const lines = resolveBugReportServerDiagnosticsLines(input.contextWindowMs);
        const response = await withAbortTimeout(6_000, async (signal) =>
          await fetch(`${normalizeBaseUrl(input.serverUrl)}/v1/diagnostics/bug-report-snapshot?lines=${lines}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${credentials.token}`,
            },
            signal,
          }),
        );
        if (response.ok) {
          pushBugReportArtifact(artifacts, {
            filename: 'server-diagnostics.json',
            sourceKind: 'server',
            contentType: 'application/json',
            content: await response.text(),
          }, limits);
          diagnosticsCollection.serverDiagnostics = { status: 'collected' };
        } else {
          diagnosticsCollection.serverDiagnostics = { status: 'error', detail: `server responded with status ${response.status}` };
        }
      }
    } catch (error) {
      diagnosticsCollection.serverDiagnostics = { status: 'error', detail: formatDiagnosticsCollectionError(error) };
    }
  }

  pushBugReportArtifact(artifacts, {
    filename: 'cli-context.json',
    sourceKind: 'cli',
    contentType: 'application/json',
    content: JSON.stringify({
      capturedAt: new Date().toISOString(),
      activeServerId: input.activeServerId,
      serverUrl: sanitizeBugReportUrl(input.serverUrl) ?? input.serverUrl,
      cwd: sanitizeBugReportArtifactPath(process.cwd()),
      platform: process.platform,
      nodeVersion: process.version,
      cliVersion: (packageJson as { version?: string }).version ?? 'unknown',
      contextWindowMs: input.contextWindowMs ?? null,
      invocationSummary: summarizeInvocationArgs(input.rawArgs),
      diagnosticsCollection,
    }, null, 2),
  }, limits);

  return { artifacts, environment };
}
