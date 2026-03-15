import { sanitizeBugReportUrl, sanitizeDoctorSnapshotUrls, type DoctorSnapshot } from '@happier-dev/protocol';

export type DiagnosisFindingSeverity = 'info' | 'warning' | 'error';

export type DiagnosisFindingCode =
  | 'server.mismatch.ui_vs_machine'
  | 'server.mismatch.ui_vs_pasted'
  | 'server.mismatch.settings_vs_resolved'
  | 'server.multiple_machines_multiple_servers'
  | 'server.profile_missing_for_active_url'
  | 'auth.mismatch.ui_vs_machine_account'
  | 'auth.machine_missing_account'
  | 'machine.none_online'
  | 'server.diagnostics_disabled'
  | 'auth.server_401'
  | 'server.unreachable'
  | 'server.http_error';

export type DiagnosisFinding = Readonly<{
  code: DiagnosisFindingCode;
  severity: DiagnosisFindingSeverity;
  machineIds?: string[];
  details?: Record<string, unknown>;
}>;

export type ServerDiagnosticsStatus =
  | { state: 'ok' }
  | { state: 'disabled' }
  | { state: 'auth_error' }
  | { state: 'timeout' }
  | { state: 'http_error'; httpStatus: number }
  | { state: 'unknown'; detail: string };

export type DiagnosisInput = Readonly<{
  ui: Readonly<{
    activeServerId: string;
    activeServerUrl: string;
    profileId: string | null;
  }>;
  serverProfiles: ReadonlyArray<Readonly<{ id: string; serverUrl: string }>>;
  machinesByServerId: Readonly<Record<string, ReadonlyArray<Readonly<{ id: string; active: boolean }>>>>;
  machineDoctorSnapshots: ReadonlyArray<Readonly<{ machineId: string; serverId: string; snapshot: DoctorSnapshot }>>;
  pastedDoctorSnapshots: ReadonlyArray<DoctorSnapshot>;
  serverDiagnostics: ServerDiagnosticsStatus;
  nowMs: number;
}>;

export type DiagnosisReport = Readonly<{
  capturedAt: string;
  findings: DiagnosisFinding[];
}>;

function normalizeUrl(raw: string): string {
  const sanitized = sanitizeBugReportUrl(raw) ?? raw;
  return sanitized.replace(/\/+$/, '');
}

function pushFinding(findings: DiagnosisFinding[], finding: DiagnosisFinding): void {
  const key = `${finding.code}:${(finding.machineIds ?? []).join(',')}:${JSON.stringify(finding.details ?? {})}`;
  if (findings.some((f) => `${f.code}:${(f.machineIds ?? []).join(',')}:${JSON.stringify(f.details ?? {})}` === key)) return;
  findings.push(finding);
}

export function buildDiagnosisReport(input: DiagnosisInput): DiagnosisReport {
  const findings: DiagnosisFinding[] = [];
  const uiServerUrl = normalizeUrl(input.ui.activeServerUrl);
  const uiProfileId = input.ui.profileId;

  const activeMachines = input.machinesByServerId[input.ui.activeServerId] ?? [];
  if (activeMachines.filter((m) => m.active).length === 0) {
    pushFinding(findings, {
      code: 'machine.none_online',
      severity: 'warning',
      details: { activeServerId: input.ui.activeServerId },
    });
  }

  const normalizedServerProfileUrls = new Set(input.serverProfiles.map((p) => normalizeUrl(p.serverUrl)));
  if (uiServerUrl && !normalizedServerProfileUrls.has(uiServerUrl)) {
    pushFinding(findings, {
      code: 'server.profile_missing_for_active_url',
      severity: 'warning',
      details: { activeServerUrl: uiServerUrl },
    });
  }

  const machineServerUrlSet = new Set<string>();

  for (const entry of input.machineDoctorSnapshots) {
    const snapshot = sanitizeDoctorSnapshotUrls(entry.snapshot);
    const machineServerUrl = normalizeUrl(snapshot.server.serverUrl);
    if (machineServerUrl) machineServerUrlSet.add(machineServerUrl);

    if (uiServerUrl && machineServerUrl && uiServerUrl !== machineServerUrl) {
      pushFinding(findings, {
        code: 'server.mismatch.ui_vs_machine',
        severity: 'error',
        machineIds: [entry.machineId],
        details: { uiServerUrl, machineServerUrl },
      });
    }

    if (uiProfileId && snapshot.accountId && uiProfileId !== snapshot.accountId) {
      pushFinding(findings, {
        code: 'auth.mismatch.ui_vs_machine_account',
        severity: 'error',
        machineIds: [entry.machineId],
        details: { uiProfileId, machineAccountId: snapshot.accountId },
      });
    } else if (!snapshot.accountId) {
      pushFinding(findings, {
        code: 'auth.machine_missing_account',
        severity: 'warning',
        machineIds: [entry.machineId],
      });
    }

    if (snapshot.settings.activeServerId && snapshot.settings.activeServerId !== snapshot.server.activeServerId) {
      pushFinding(findings, {
        code: 'server.mismatch.settings_vs_resolved',
        severity: 'warning',
        machineIds: [entry.machineId],
        details: { settingsActiveServerId: snapshot.settings.activeServerId, resolvedServerId: snapshot.server.activeServerId },
      });
    }
  }

  if (machineServerUrlSet.size > 1) {
    pushFinding(findings, {
      code: 'server.multiple_machines_multiple_servers',
      severity: 'warning',
      details: { machineServerUrls: Array.from(machineServerUrlSet.values()) },
    });
  }

  for (const snapshot of input.pastedDoctorSnapshots) {
    const sanitized = sanitizeDoctorSnapshotUrls(snapshot);
    const pastedServerUrl = normalizeUrl(sanitized.server.serverUrl);
    if (uiServerUrl && pastedServerUrl && uiServerUrl !== pastedServerUrl) {
      pushFinding(findings, {
        code: 'server.mismatch.ui_vs_pasted',
        severity: 'warning',
        details: { uiServerUrl, pastedServerUrl },
      });
    }
  }

  switch (input.serverDiagnostics.state) {
    case 'ok':
      break;
    case 'disabled':
      pushFinding(findings, { code: 'server.diagnostics_disabled', severity: 'info' });
      break;
    case 'auth_error':
      pushFinding(findings, { code: 'auth.server_401', severity: 'error' });
      break;
    case 'timeout':
      pushFinding(findings, { code: 'server.unreachable', severity: 'error' });
      break;
    case 'http_error':
      pushFinding(findings, { code: 'server.http_error', severity: 'error', details: { httpStatus: input.serverDiagnostics.httpStatus } });
      break;
    case 'unknown':
      pushFinding(findings, { code: 'server.http_error', severity: 'warning', details: { detail: input.serverDiagnostics.detail } });
      break;
  }

  return {
    capturedAt: new Date(input.nowMs || Date.now()).toISOString(),
    findings,
  };
}
