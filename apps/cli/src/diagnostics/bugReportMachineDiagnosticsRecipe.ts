import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { AGENT_IDS, resolveVendorResumeIdFromSessionMetadata, type AgentId } from '@happier-dev/agents';
import { resolveBugReportLogSelection, BUG_REPORT_LOG_SOURCE_KINDS, type BugReportLogSelection, type BugReportSessionDiagnostics } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { readCredentials, readDaemonState, readSettings, type Credentials } from '@/persistence';
import { listDaemonLogFiles } from '@/ui/logger';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveAgentNativeSessionLogPathThroughCatalog } from '@/backends/catalog';
import { collectBugReportMachineDiagnosticsSnapshot, readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';

import type { BugReportMachineDiagnosticsSnapshot } from '@/diagnostics/bugReportMachineDiagnostics';

export const BUG_REPORT_MACHINE_DIAGNOSTICS_RECIPE = {
  daemonLogLimit: 5,
  stackLogLimit: 3,
  stackRuntimeMaxChars: 400_000,
} as const;

export type BugReportMachineDiagnosticsRequest = {
  sessionId?: string;
  logSelection?: Partial<BugReportLogSelection>;
};

export type BugReportSelectedMachineDiagnostics = BugReportMachineDiagnosticsSnapshot & {
  sessionDiagnostics?: BugReportSessionDiagnostics;
};

async function canonicalFileWithin(path: unknown, root: string): Promise<string | null> {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) return null;
  const [canonicalPath, canonicalRoot] = await Promise.all([realpath(path), realpath(root)]).catch(() => [null, null]);
  if (!canonicalPath || !canonicalRoot) return null;
  const rel = relative(canonicalRoot, canonicalPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return (await stat(canonicalPath)).isFile() ? canonicalPath : null;
}

export async function collectBugReportMachineDiagnosticsSnapshotForBugReport(
  request?: BugReportMachineDiagnosticsRequest,
  scope: { credentials?: Credentials; machineId?: string; maxArtifactBytes?: number } = {},
): Promise<BugReportSelectedMachineDiagnostics> {
  // The original no-argument RPC is retained for released callers and its path-based log-tail operation.
  if (request === undefined) return await collectBugReportMachineDiagnosticsSnapshot(BUG_REPORT_MACHINE_DIAGNOSTICS_RECIPE);

  const selection = resolveBugReportLogSelection(request.logSelection);
  const sessionId = request.sessionId?.trim() ?? '';
  const sessionDiagnostics: BugReportSessionDiagnostics = {
    context: { sessionId, metadataStatus: 'unavailable' },
    logs: [],
  };
  let metadata: Record<string, unknown> | null = null;
  let localMetadata = false;
  if (sessionId) {
    try {
      const credentials = scope.credentials ?? await readCredentials();
      if (credentials) {
        const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId });
        if (transport.ok) {
          sessionDiagnostics.context.sessionId = transport.sessionId;
          metadata = tryDecryptSessionMetadata({ credentials, rawSession: transport.rawSession });
        }
      }
    } catch {
      // Unavailable selected-session metadata is reported below; diagnostics remain exportable.
    }
    if (!metadata) {
      const marker = (await listSessionMarkers().catch(() => [])).find((entry) => entry.happySessionId === sessionId);
      if (marker?.metadata && typeof marker.metadata === 'object' && !Array.isArray(marker.metadata)) {
        metadata = marker.metadata as Record<string, unknown>;
        localMetadata = true;
      }
    }
    if (metadata) {
      const settings = await readSettings();
      const localMachineId = scope.machineId ?? settings.machineId;
      const machineId = typeof metadata.machineId === 'string' ? metadata.machineId : undefined;
      const provider = typeof metadata.flavor === 'string' && (AGENT_IDS as readonly string[]).includes(metadata.flavor)
        ? metadata.flavor : undefined;
      sessionDiagnostics.context = {
        sessionId: sessionDiagnostics.context.sessionId,
        ...(machineId ? { machineId } : {}),
        ...(provider ? { provider } : {}),
        metadataStatus: localMetadata || (machineId && machineId === localMachineId) ? 'available' : 'wrong-machine',
      };
    }
  }

  const canReadMachine = !sessionId || sessionDiagnostics.context.metadataStatus === 'available';
  const daemonState = await readDaemonState();
  const result: BugReportSelectedMachineDiagnostics = {
    daemonState: daemonState && canReadMachine ? {
      pid: daemonState.pid,
      httpPort: daemonState.httpPort,
      startedAt: daemonState.startedAt,
      startedWithCliVersion: daemonState.startedWithCliVersion,
      hasControlToken: Boolean(daemonState.controlToken),
      daemonLogPath: null,
    } : null,
    daemonLogs: [],
    doctorSnapshot: null,
    runtime: { cwd: '', platform: process.platform, nodeVersion: process.version },
    stackContext: null,
    sessionDiagnostics,
  };

  for (const kind of ['daemon', 'session', 'provider'] as const) {
    if (!selection[kind]) {
      sessionDiagnostics.logs.push({ kind, status: 'disabled' });
      continue;
    }
    if (!canReadMachine || (kind !== 'daemon' && !metadata)) {
      sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: sessionId ? 'Selected session is unavailable on this machine' : 'No session selected' });
      continue;
    }
    try {
      let path: string | null = null;
      if (kind === 'daemon') {
        const daemonLogs = daemonState?.daemonLogPath ? [] : await listDaemonLogFiles(1);
        path = await canonicalFileWithin(daemonState?.daemonLogPath ?? daemonLogs[0]?.path, configuration.logsDir);
      } else if (kind === 'session') {
        path = await canonicalFileWithin(metadata?.sessionLogPath, configuration.logsDir);
      } else {
        const flavor = metadata?.flavor;
        const agentId = typeof flavor === 'string' && (AGENT_IDS as readonly string[]).includes(flavor) ? flavor as AgentId : null;
        const vendorResumeId = agentId ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata) : null;
        if (agentId && vendorResumeId) {
          // Provider hooks derive exact known files; arbitrary metadata paths are never read by this RPC.
          path = await resolveAgentNativeSessionLogPathThroughCatalog(agentId, { vendorResumeId, metadata: metadata ?? undefined });
        }
      }
      if (!path) {
        sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: 'No matching local log file' });
        continue;
      }
      const content = await readBugReportLogTail(path, Math.min(150_000, scope.maxArtifactBytes ?? 150_000));
      if (!content.trim()) {
        sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: 'Log file is empty' });
        continue;
      }
      sessionDiagnostics.logs.push({ kind, status: 'collected', artifact: {
        filename: kind === 'provider' ? 'provider-transcript.jsonl' : `${kind}.log`,
        sourceKind: BUG_REPORT_LOG_SOURCE_KINDS[kind],
        contentType: 'text/plain',
        content,
      } });
    } catch {
      sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: 'Log file could not be read' });
    }
  }
  return result;
}

