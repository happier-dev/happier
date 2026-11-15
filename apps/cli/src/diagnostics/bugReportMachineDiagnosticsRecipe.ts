import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata,
  resolveAgentIdFromSessionMetadata,
  resolveAgentNativeResumeIdentityFromSessionMetadata,
} from '@happier-dev/agents';
import {
  BUG_REPORT_LOG_SOURCE_KINDS,
  resolveBugReportLogSelection,
  type BugReportDiagnosticsRequest,
  type BugReportSessionDiagnostics,
  type BugReportMachineDiagnosticsSnapshot,
} from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { configuration } from '@/configuration';
import { readDaemonState, readSettings, readStoredCredentials, type StoredCredentials } from '@/persistence';
import { listDaemonLogFiles } from '@/ui/logger';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { collectBugReportMachineDiagnosticsSnapshot, readBugReportLogTail } from './bugReportMachineDiagnostics';
import { DIAGNOSTIC_RECENT_DAEMON_LOG_COUNT } from '@/utils/logs/logRetention';

export const BUG_REPORT_MACHINE_DIAGNOSTICS_RECIPE = {
  daemonLogLimit: DIAGNOSTIC_RECENT_DAEMON_LOG_COUNT, stackLogLimit: 3, stackRuntimeMaxChars: 400_000,
} as const;

type CollectionScope = Readonly<{
  credentials?: StoredCredentials;
  machineId?: string;
  maxArtifactBytes?: number;
  signal?: AbortSignal;
}>;

async function containedFile(candidate: unknown, containmentRoot: string): Promise<string | null> {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return null;
  const [path, root] = await Promise.all([realpath(candidate), realpath(containmentRoot)]).catch(() => [null, null]);
  if (!path || !root) return null;
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return (await stat(path)).isFile() ? path : null;
}

export async function collectBugReportMachineDiagnosticsSnapshotForBugReport(
  request?: BugReportDiagnosticsRequest,
  scope: CollectionScope = {},
): Promise<BugReportMachineDiagnosticsSnapshot> {
  if (request === undefined) return await collectBugReportMachineDiagnosticsSnapshot(BUG_REPORT_MACHINE_DIAGNOSTICS_RECIPE);
  scope.signal?.throwIfAborted();
  const selection = resolveBugReportLogSelection(request.logSelection);
  const requestedSessionId = request.sessionId?.trim() ?? '';
  const sessionDiagnostics: BugReportSessionDiagnostics = {
    context: { sessionId: requestedSessionId, metadataStatus: 'unavailable' }, logs: [],
  };
  let metadata: Record<string, unknown> | null = null;
  let fromLocalMarker = false;
  if (requestedSessionId) {
    const credentials = scope.credentials ?? await readStoredCredentials();
    if (credentials) {
      try {
        const transport = await resolveSessionTransportContext({
          reason: 'session-query', credentials, idOrPrefix: requestedSessionId,
          ...(scope.signal ? { signal: scope.signal } : {}),
        });
        if (transport.ok) {
          sessionDiagnostics.context.sessionId = transport.sessionId;
          metadata = tryDecryptSessionMetadata({ credentials, rawSession: transport.rawSession });
        }
      } catch {
        scope.signal?.throwIfAborted();
        // An unavailable Home or encryption witness is reported without bypassing currentness.
      }
    } else {
      const marker = (await listSessionMarkers().catch(() => [])).find((entry) => entry.happySessionId === requestedSessionId);
      if (marker?.metadata && typeof marker.metadata === 'object' && !Array.isArray(marker.metadata)) {
        metadata = marker.metadata as Record<string, unknown>;
        fromLocalMarker = true;
      }
    }
    if (metadata) {
      const machineId = typeof metadata.machineId === 'string' ? metadata.machineId : undefined;
      const localMachineId = scope.machineId ?? (await readSettings()).machineId;
      const agentId = resolveAgentIdFromSessionMetadata(metadata);
      sessionDiagnostics.context = {
        sessionId: sessionDiagnostics.context.sessionId,
        ...(machineId ? { machineId } : {}), ...(agentId ? { provider: agentId } : {}),
        metadataStatus: fromLocalMarker || (machineId && machineId === localMachineId) ? 'available' : 'wrong-machine',
      };
    }
  }
  const onSelectedMachine = !requestedSessionId || sessionDiagnostics.context.metadataStatus === 'available';
  const daemonState = onSelectedMachine ? await readDaemonState() : null;
  const result: BugReportMachineDiagnosticsSnapshot = {
    daemonState: daemonState ? {
      pid: daemonState.pid, httpPort: daemonState.httpPort, startedAt: daemonState.startedAt,
      startedWithCliVersion: daemonState.startedWithCliVersion,
      ...(daemonState.machineId ? { machineId: daemonState.machineId } : {}),
      hasControlToken: Boolean(daemonState.controlToken), daemonLogPath: null,
    } : null,
    daemonLogs: [], doctorSnapshot: null, stackContext: null,
    runtime: { cwd: '', platform: process.platform, nodeVersion: process.version }, sessionDiagnostics,
  };
  for (const kind of ['daemon', 'session', 'provider'] as const) {
    if (!selection[kind]) {
      sessionDiagnostics.logs.push({ kind, status: 'disabled' });
      continue;
    }
    if (!onSelectedMachine || (kind !== 'daemon' && !metadata)) {
      sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: requestedSessionId ? 'Selected session is unavailable on this machine' : 'No session selected' });
      continue;
    }
    try {
      scope.signal?.throwIfAborted();
      let path: string | null = null;
      if (kind === 'daemon') {
        const files = daemonState?.daemonLogPath ? [] : await listDaemonLogFiles(1);
        path = await containedFile(daemonState?.daemonLogPath ?? files[0]?.path, configuration.logsDir);
      } else if (kind === 'session') {
        path = await containedFile(metadata?.sessionLogPath, configuration.logsDir);
      } else if (metadata) {
        const agentId = resolveAgentIdFromSessionMetadata(metadata);
        const identity = agentId ? resolveAgentNativeResumeIdentityFromSessionMetadata(agentId, metadata) : null;
        const descriptor = readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(metadata);
        if (agentId && identity && descriptor?.agentId === agentId) {
          const runtime = await getSessionHostBridge().resolveCurrentExecutionSurfacesForCatalogAgent(agentId);
          const resolveCandidate = runtime?.agentId === agentId ? runtime.executionSurfaces.handoff?.resolveNativeTranscriptPathCandidate : null;
          const candidate = resolveCandidate ? await resolveCandidate({ identity, runtimeDescriptorV1: descriptor }) : null;
          if (candidate) path = await containedFile(candidate.path, candidate.containmentRoot);
        }
      }
      if (!path) {
        sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: 'No matching local log file' });
        continue;
      }
      const content = await readBugReportLogTail(path, scope.maxArtifactBytes, { signal: scope.signal });
      if (!content.trim()) {
        sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: 'Log file is empty' });
        continue;
      }
      sessionDiagnostics.logs.push({ kind, status: 'collected', artifact: {
        filename: kind === 'provider' ? 'provider-transcript.jsonl' : `${kind}.log`,
        sourceKind: BUG_REPORT_LOG_SOURCE_KINDS[kind], contentType: 'text/plain', content,
      } });
    } catch {
      scope.signal?.throwIfAborted();
      sessionDiagnostics.logs.push({ kind, status: 'unavailable', detail: 'Log file could not be read' });
    }
  }
  scope.signal?.throwIfAborted();
  return result;
}
