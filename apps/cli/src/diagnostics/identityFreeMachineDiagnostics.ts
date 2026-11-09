import type { BugReportMachineDiagnosticsSnapshot } from '@happier-dev/protocol';
import { pickIdentityFreeFields, projectIdentityFreeSignIn } from '@/capabilities/cliAuth/identityFreeSignIn';

export function projectIdentityFreeMachineDiagnostics(value: BugReportMachineDiagnosticsSnapshot): BugReportMachineDiagnosticsSnapshot {
  const doctor = value.doctorSnapshot;
  return {
    daemonState: value.daemonState ? { ...pickIdentityFreeFields(value.daemonState,
      ['pid', 'httpPort', 'startedAt', 'startedWithCliVersion', 'hasControlToken']), daemonLogPath: null } : null,
    daemonLogs: [],
    // Paths, runtime JSON, log content and extensible doctor inventories may
    // embed Account identity. Use receives technical facts, not free-form text.
    stackContext: null,
    runtime: { cwd: '', ...pickIdentityFreeFields(value.runtime, ['platform', 'nodeVersion']) },
    doctorSnapshot: doctor ? {
      capturedAt: doctor.capturedAt,
      server: pickIdentityFreeFields(doctor.server, ['activeServerId', 'serverUrl', 'publicServerUrl', 'webappUrl']),
      accountId: null,
      settings: { activeServerId: doctor.settings.activeServerId, servers: [], knownAccountIds: [] },
      ...(doctor.daemonStatus ? { daemonStatus: {
        server: pickIdentityFreeFields(doctor.daemonStatus.server,
          ['activeServerId', 'serverUrl', 'localServerUrl', 'publicServerUrl', 'webappUrl', 'comparableKey']),
        daemon: pickIdentityFreeFields(doctor.daemonStatus.daemon, ['running', 'healthy', 'pid', 'httpPort',
          'startedWithCliVersion', 'startedWithPublicReleaseChannel', 'serviceManaged']),
        service: pickIdentityFreeFields(doctor.daemonStatus.service, ['installed', 'running', 'autostart']),
        auth: { ...projectIdentityFreeSignIn(doctor.daemonStatus.auth), accountId: null },
      } } : {}),
    } : null,
    ...(value.sessionDiagnostics ? { sessionDiagnostics: {
      context: pickIdentityFreeFields(value.sessionDiagnostics.context, ['sessionId', 'machineId', 'provider', 'metadataStatus']),
      logs: value.sessionDiagnostics.logs.map(log => ({ kind: log.kind, status: 'disabled' as const })),
    } } : {}),
  };
}

/** Arbitrary log text cannot be projected into identity-free diagnostic facts. */
export function projectIdentityFreeDiagnosticLogTail(): Readonly<{ ok: false; error: string }> {
  return { ok: false, error: 'Log content is omitted for Use diagnostics' };
}

