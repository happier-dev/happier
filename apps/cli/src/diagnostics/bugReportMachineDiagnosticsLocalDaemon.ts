import {
  BUG_REPORT_LOG_SOURCE_KINDS,
  BugReportMachineDiagnosticsSnapshotSchema,
  resolveBugReportLogSelection,
  type BugReportDiagnosticsRequest,
  type BugReportMachineDiagnosticsSnapshot,
} from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { daemonPost } from '@/daemon/controlHttp';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from './bugReportMachineDiagnosticsRecipe';

/** Provider callbacks execute in the installed daemon's admitted plugin runtime. */
export async function collectBugReportMachineDiagnosticsOnHost(
  request: BugReportDiagnosticsRequest,
  scope: Parameters<typeof collectBugReportMachineDiagnosticsSnapshotForBugReport>[1] = {},
): Promise<BugReportMachineDiagnosticsSnapshot> {
  const selection = resolveBugReportLogSelection(request.logSelection);
  const snapshot = await collectBugReportMachineDiagnosticsSnapshotForBugReport({
    ...request, logSelection: { ...selection, provider: false },
  }, scope);
  const diagnostics = snapshot.sessionDiagnostics;
  if (!selection.provider || !diagnostics) return snapshot;
  let provider: typeof diagnostics.logs[number] = { kind: 'provider', status: 'unavailable', detail: 'Local daemon provider diagnostics are unavailable' };
  if (diagnostics.context.metadataStatus === 'available') {
    const response: unknown = await daemonPost('/diagnostics/bug-report/collect', {
      sessionId: diagnostics.context.sessionId,
      logSelection: { daemon: false, session: false, provider: true },
    }, { timeoutMs: null, ...(scope.signal ? { signal: scope.signal } : {}) });
    scope.signal?.throwIfAborted();
    const parsed = BugReportMachineDiagnosticsSnapshotSchema.safeParse(response);
    const remote = parsed.success ? parsed.data.sessionDiagnostics : undefined;
    if (remote?.context.metadataStatus === 'available'
      && remote.context.sessionId === diagnostics.context.sessionId
      && remote.context.machineId === diagnostics.context.machineId) {
      const log = remote.logs.find(entry => entry.kind === 'provider');
      if (log && (!log.artifact || log.artifact.sourceKind === BUG_REPORT_LOG_SOURCE_KINDS.provider)) provider = log;
    }
  }
  diagnostics.logs = diagnostics.logs.map(log => log.kind === 'provider' ? provider : log);
  return snapshot;
}
