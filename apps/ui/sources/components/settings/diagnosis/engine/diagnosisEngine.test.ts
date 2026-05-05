import { describe, expect, it } from 'vitest';

import { buildDiagnosisReport } from './diagnosisEngine';

describe('buildDiagnosisReport', () => {
  it('detects UI vs machine serverUrl mismatch', () => {
    const report = buildDiagnosisReport({
      ui: {
        activeServerId: 'cloud',
        activeServerUrl: 'https://api.happier.dev',
        profileId: 'acct_1',
      },
      serverProfiles: [{ id: 'cloud', serverUrl: 'https://api.happier.dev' }],
      machinesByServerId: { cloud: [{ id: 'm1', active: true }] },
      machineDoctorSnapshots: [{
        machineId: 'm1',
        serverId: 'cloud',
        snapshot: {
          capturedAt: '2026-02-23T00:00:00.000Z',
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://staging-api.happier.dev',
            publicServerUrl: 'https://staging-api.happier.dev',
            webappUrl: 'https://app.happier.dev',
          },
          accountId: 'acct_1',
          settings: { activeServerId: 'cloud', servers: [], knownAccountIds: ['acct_1'] },
        },
      }],
      pastedDoctorSnapshots: [],
      serverDiagnostics: { state: 'ok' },
      nowMs: 0,
    });

    expect(report.findings.some((f) => f.code === 'server.mismatch.ui_vs_machine')).toBe(true);
  });

  it('treats loopback-equivalent UI and machine serverUrls as the same Relay', () => {
    const report = buildDiagnosisReport({
      ui: {
        activeServerId: 'local',
        activeServerUrl: 'http://localhost:34567',
        profileId: 'acct_1',
      },
      serverProfiles: [{ id: 'local', serverUrl: 'http://localhost:34567' }],
      machinesByServerId: { local: [{ id: 'm1', active: true }] },
      machineDoctorSnapshots: [{
        machineId: 'm1',
        serverId: 'local',
        snapshot: {
          capturedAt: '2026-02-23T00:00:00.000Z',
          server: {
            activeServerId: 'local',
            serverUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
            webappUrl: 'http://localhost:34567',
          },
          accountId: 'acct_1',
          settings: { activeServerId: 'local', servers: [], knownAccountIds: ['acct_1'] },
        },
      }],
      pastedDoctorSnapshots: [{
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
          activeServerId: 'local',
          serverUrl: 'http://127.0.0.1:34567',
          publicServerUrl: 'http://127.0.0.1:34567',
          webappUrl: 'http://localhost:34567',
        },
        accountId: 'acct_1',
        settings: { activeServerId: 'local', servers: [], knownAccountIds: ['acct_1'] },
      }],
      serverDiagnostics: { state: 'ok' },
      nowMs: 0,
    });

    expect(report.findings.some((f) => f.code === 'server.mismatch.ui_vs_machine')).toBe(false);
    expect(report.findings.some((f) => f.code === 'server.mismatch.ui_vs_pasted')).toBe(false);
  });

  it('uses UI server URL canonicalization for scheme-less local Relay URLs', () => {
    const report = buildDiagnosisReport({
      ui: {
        activeServerId: 'local',
        activeServerUrl: 'localhost:34567',
        profileId: 'acct_1',
      },
      serverProfiles: [{ id: 'local', serverUrl: 'http://127.0.0.1:34567' }],
      machinesByServerId: { local: [{ id: 'm1', active: true }] },
      machineDoctorSnapshots: [{
        machineId: 'm1',
        serverId: 'local',
        snapshot: {
          capturedAt: '2026-02-23T00:00:00.000Z',
          server: {
            activeServerId: 'local',
            serverUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
            webappUrl: 'http://localhost:34567',
          },
          accountId: 'acct_1',
          settings: { activeServerId: 'local', servers: [], knownAccountIds: ['acct_1'] },
        },
      }],
      pastedDoctorSnapshots: [],
      serverDiagnostics: { state: 'ok' },
      nowMs: 0,
    });

    expect(report.findings.some((f) => f.code === 'server.profile_missing_for_active_url')).toBe(false);
    expect(report.findings.some((f) => f.code === 'server.mismatch.ui_vs_machine')).toBe(false);
  });

  it('detects UI vs machine accountId mismatch', () => {
    const report = buildDiagnosisReport({
      ui: {
        activeServerId: 'cloud',
        activeServerUrl: 'https://api.happier.dev',
        profileId: 'acct_ui',
      },
      serverProfiles: [{ id: 'cloud', serverUrl: 'https://api.happier.dev' }],
      machinesByServerId: { cloud: [{ id: 'm1', active: true }] },
      machineDoctorSnapshots: [{
        machineId: 'm1',
        serverId: 'cloud',
        snapshot: {
          capturedAt: '2026-02-23T00:00:00.000Z',
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            publicServerUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
          },
          accountId: 'acct_machine',
          settings: { activeServerId: 'cloud', servers: [], knownAccountIds: ['acct_machine'] },
        },
      }],
      pastedDoctorSnapshots: [],
      serverDiagnostics: { state: 'ok' },
      nowMs: 0,
    });

    expect(report.findings.some((f) => f.code === 'auth.mismatch.ui_vs_machine_account')).toBe(true);
  });

  it('flags server diagnostics disabled as an informational finding', () => {
    const report = buildDiagnosisReport({
      ui: {
        activeServerId: 'cloud',
        activeServerUrl: 'https://api.happier.dev',
        profileId: 'acct_1',
      },
      serverProfiles: [{ id: 'cloud', serverUrl: 'https://api.happier.dev' }],
      machinesByServerId: { cloud: [] },
      machineDoctorSnapshots: [],
      pastedDoctorSnapshots: [],
      serverDiagnostics: { state: 'disabled' },
      nowMs: 0,
    });

    expect(report.findings.some((f) => f.code === 'server.diagnostics_disabled')).toBe(true);
  });

  it('flags when active serverUrl is not represented in server profiles', () => {
    const report = buildDiagnosisReport({
      ui: {
        activeServerId: 'cloud',
        activeServerUrl: 'https://api.happier.dev',
        profileId: 'acct_1',
      },
      serverProfiles: [{ id: 'self', serverUrl: 'http://127.0.0.1:3005' }],
      machinesByServerId: { cloud: [] },
      machineDoctorSnapshots: [],
      pastedDoctorSnapshots: [],
      serverDiagnostics: { state: 'ok' },
      nowMs: 0,
    });

    expect(report.findings.some((f) => f.code === 'server.profile_missing_for_active_url')).toBe(true);
  });
});
