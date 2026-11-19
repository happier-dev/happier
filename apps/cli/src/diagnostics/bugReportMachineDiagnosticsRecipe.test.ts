import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { writeCredentialsTokenOnly, writeDaemonState } from '@/persistence';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from './bugReportMachineDiagnosticsRecipe';
import { collectBugReportMachineDiagnosticsSnapshot } from './bugReportMachineDiagnostics';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('selected bug report machine diagnostics', () => {
  it.each(['plain', 'e2ee'] as const)('collects layout-one %s owner logs without disclosing another Machine', async mode => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-report-owner-layout-' }, async () => {
      const { default: axios } = await import('axios');
      const { encrypt, encodeBase64 } = await import('@/api/encryption');
      const { sealSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
      await mkdir(configuration.logsDir, { recursive: true });
      const selected = join(configuration.logsDir, 'selected-owner.log');
      const daemonLogPath = join(configuration.logsDir, 'owner-daemon.log');
      await writeFile(selected, 'LAYOUT_ONE_SESSION_BODY');
      await writeFile(daemonLogPath, 'LAYOUT_ONE_DAEMON_BODY');
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath });
      const secret = new Uint8Array(32).fill(7);
      const shared = { v: 1 };
      const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { machineId: 'machine-a' }, runtime: { sessionLogPath: selected } });
      const ownerEnvelope = mode === 'plain' ? { t: 'plain' as const, v: ownerMetadata }
        : sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret }, ownerMetadata,
          randomBytes: length => new Uint8Array(length).fill(9) });
      const sessionId = 'c123456789012345678901234';
      // Only HTTP is substituted: the admitted layout, owner crypto, locality and file reads stay real.
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/encryption/currentness')
        ? { mode, version: 1, signingKeyFingerprint: mode === 'plain' ? null : 'fixture-signing', contentKeyFingerprint: mode === 'plain' ? null : 'fixture-content', updatedAt: 1 }
        : { session: { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryptionMode: mode,
          metadata: mode === 'plain' ? JSON.stringify(shared) : encodeBase64(encrypt(secret, 'legacy', shared), 'base64'),
          metadataLayoutVersion: 1, ownerMetadata: ownerEnvelope, metadataVersion: 1,
          agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null } } }));
      vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
      const credentials = { token: 'fixture-token', credentialProvenance: 'stored_session' as const,
        encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
      const request = { sessionId, logSelection: { daemon: true, session: true, provider: false } };
      const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport(request, { credentials, machineId: 'machine-a' });
      expect(result.sessionDiagnostics?.context.metadataStatus).toBe('available');
      expect(result.sessionDiagnostics?.logs.find(entry => entry.kind === 'session')?.artifact?.content).toBe('LAYOUT_ONE_SESSION_BODY');
      expect(result.sessionDiagnostics?.logs.find(entry => entry.kind === 'daemon')?.artifact?.content).toBe('LAYOUT_ONE_DAEMON_BODY');
      const foreign = await collectBugReportMachineDiagnosticsSnapshotForBugReport(request, { credentials, machineId: 'machine-b' });
      expect(foreign.sessionDiagnostics?.context.metadataStatus).toBe('wrong-machine');
      expect(foreign.sessionDiagnostics?.logs.some(entry => entry.status === 'collected')).toBe(false);
      expect(JSON.stringify(foreign)).not.toContain('LAYOUT_ONE_SESSION_BODY');
    });
  });
  it('uses the artifact owner budget beyond the former selected-log cap', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-selected-log-budget-' }, async () => {
      await mkdir(configuration.logsDir, { recursive: true });
      const daemonLogPath = join(configuration.logsDir, 'large.log');
      const content = 'x'.repeat(200_000);
      await writeFile(daemonLogPath, content);
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath });
      for (const maxArtifactBytes of [180_000, 256_000]) {
        const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({
          logSelection: { daemon: true, session: false, provider: false },
        }, { maxArtifactBytes });
        expect(result.sessionDiagnostics?.logs[0]?.artifact?.content).toBe(content.slice(-maxArtifactBytes));
      }
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('includes the doctor snapshot when machine diagnostics are requested', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-requested-doctor-' }, async () => {
      const result = await collectBugReportMachineDiagnosticsSnapshot();
      expect(result.doctorSnapshot?.server.serverUrl).toBe(configuration.serverUrl);
      expect(result.doctorSnapshot?.accountId).toBeNull();
    });
  });
  it('returns only allowlisted technical context when all log choices are disabled', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-selected-report-' }, async () => {
      await mkdir(configuration.logsDir, { recursive: true });
      const daemonLogPath = join(configuration.logsDir, 'fixture-daemon.log');
      await writeFile(daemonLogPath, 'PRIVATE_DAEMON_BODY');
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath });
      const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ logSelection: { daemon: false, session: false, provider: false } });
      expect(result.doctorSnapshot).toBeNull();
      expect(result.stackContext).toBeNull();
      expect(result.daemonLogs).toEqual([]);
      expect(result.sessionDiagnostics?.logs).toEqual([
        { kind: 'daemon', status: 'disabled' }, { kind: 'session', status: 'disabled' }, { kind: 'provider', status: 'disabled' },
      ]);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_DAEMON_BODY');
    });
  });
  it('collects the selected local runner and daemon while rejecting a symlink escape and missing session', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-exact-report-' }, async ({ homeDir }) => {
      const { writeSessionMarker } = await import('@/daemon/sessionRegistry');
      await mkdir(configuration.logsDir, { recursive: true });
      const selected = join(configuration.logsDir, 'selected.log');
      const daemonLogPath = join(configuration.logsDir, 'fixture-daemon.log');
      await writeFile(selected, 'SELECTED_SESSION_BODY');
      await writeFile(daemonLogPath, 'SELECTED_DAEMON_BODY');
      await writeFile(join(configuration.logsDir, 'newest.log'), 'UNRELATED_RUNNER_BODY');
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath });
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(12345), pid: 12345, happySessionId: 'selected-session', metadata: { sessionLogPath: selected, summary: { text: 'PRIVATE_METADATA_SUMMARY' } } });
      const selectedResult = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'selected-session' });
      expect(selectedResult.sessionDiagnostics?.logs.find(entry => entry.kind === 'session')?.artifact?.content).toBe('SELECTED_SESSION_BODY');
      expect(selectedResult.sessionDiagnostics?.logs.find(entry => entry.kind === 'daemon')?.artifact?.content).toBe('SELECTED_DAEMON_BODY');
      expect(selectedResult.sessionDiagnostics?.logs.find(entry => entry.kind === 'provider')?.status).toBe('disabled');
      expect(JSON.stringify(selectedResult)).not.toContain('PRIVATE_METADATA_SUMMARY');
      expect(JSON.stringify(selectedResult)).not.toContain('UNRELATED_RUNNER_BODY');
      const payload = Buffer.from(JSON.stringify({ sub: 'obsolete-account', extras: {} })).toString('base64url');
      await writeCredentialsTokenOnly({ token: `hdr.${payload}.sig` });
      const reloginResult = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'selected-session' });
      expect(reloginResult.sessionDiagnostics).toEqual(selectedResult.sessionDiagnostics);

      const outside = join(homeDir, 'outside.log');
      const link = join(configuration.logsDir, 'escape.log');
      await writeFile(outside, 'PRIVATE_OUTSIDE_BODY');
      await symlink(outside, link);
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(12345), pid: 12345, happySessionId: 'selected-session', metadata: { sessionLogPath: link } });
      const refused = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'selected-session' });
      expect(refused.sessionDiagnostics?.logs.find(entry => entry.kind === 'session')?.status).toBe('unavailable');
      expect(JSON.stringify(refused)).not.toContain('PRIVATE_OUTSIDE_BODY');
      const missing = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'missing-session' });
      expect(missing.sessionDiagnostics?.logs.some(entry => entry.status === 'collected')).toBe(false);
    });
  });

  it.each(['plain', 'e2ee'] as const)('opens %s session metadata through currentness and canonical decryption and refuses a foreign machine', async mode => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-report-transport-' }, async () => {
      const { default: axios } = await import('axios');
      const { encrypt, encodeBase64 } = await import('@/api/encryption');
      await mkdir(configuration.logsDir, { recursive: true });
      const selected = join(configuration.logsDir, 'selected.log');
      await writeFile(selected, 'EXACT_TRANSPORT_BODY');
      const secret = new Uint8Array(32).fill(7);
      const metadata = { machineId: 'machine-a', sessionLogPath: selected, summary: { text: 'PRIVATE_METADATA_SUMMARY' } };
      const sessionId = 'c123456789012345678901234';
      // HTTP is the only substituted boundary; lookup, access/envelope parsing and file IO remain real.
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/encryption/currentness')
        ? { mode, version: 1, signingKeyFingerprint: mode === 'plain' ? null : 'fixture-signing', contentKeyFingerprint: mode === 'plain' ? null : 'fixture-content', updatedAt: 1 }
        : { session: { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryptionMode: mode,
          metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(secret, 'legacy', metadata), 'base64'),
          metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null } } }));
      vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
      const keyedCredentials = { token: 'fixture-token', credentialProvenance: 'stored_session' as const, encryption: { type: 'legacy' as const, secret } };
      // A plain Account is keyless; active E2EE custody would correctly refuse the reported downgrade.
      const credentials = mode === 'plain' ? { ...keyedCredentials, encryption: null } : keyedCredentials;
      const request = { sessionId, logSelection: { daemon: false } };
      const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport(request, { credentials, machineId: 'machine-a' });
      expect(result.sessionDiagnostics?.context.metadataStatus).toBe('available');
      expect(result.sessionDiagnostics?.logs.find(entry => entry.kind === 'session')?.artifact?.content).toBe('EXACT_TRANSPORT_BODY');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_METADATA_SUMMARY');
      const foreign = await collectBugReportMachineDiagnosticsSnapshotForBugReport(request, { credentials, machineId: 'machine-b' });
      expect(foreign.sessionDiagnostics?.context.metadataStatus).toBe('wrong-machine');
      expect(foreign.sessionDiagnostics?.logs.some(entry => entry.status === 'collected')).toBe(false);
      if (mode === 'plain') {
        const unverifiedDowngrade = await collectBugReportMachineDiagnosticsSnapshotForBugReport(request, {
          credentials: keyedCredentials, machineId: 'machine-a',
        });
        expect(unverifiedDowngrade.sessionDiagnostics?.context.metadataStatus).toBe('unavailable');
        expect(unverifiedDowngrade.sessionDiagnostics?.logs.some(entry => entry.status === 'collected')).toBe(false);
        expect(JSON.stringify(unverifiedDowngrade)).not.toContain('EXACT_TRANSPORT_BODY');
      }
    });
  });

});
