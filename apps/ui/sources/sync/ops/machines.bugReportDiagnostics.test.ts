import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { upsertServerProfile, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { machineCollectBugReportDiagnostics } from './machines';

const boundary = vi.hoisted(() => ({ machineRPC: vi.fn(), credentials: vi.fn() }));
// The socket and credential storage are process boundaries; scope resolution and
// response validation below them use the real owners.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { machineRPC: boundary.machineRPC } }));
vi.mock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentialsForServerUrl: boundary.credentials } }));

describe('machine bug report diagnostics boundary', () => {
    beforeEach(() => {
        boundary.machineRPC.mockReset();
        boundary.credentials.mockReset();
    });
    afterEach(() => vi.restoreAllMocks());

    it('preserves the released empty request and validates the structural response', async () => {
        const snapshot = { daemonState: null, daemonLogs: [], runtime: { cwd: '/project', platform: 'linux', nodeVersion: 'v22' }, doctorSnapshot: { capturedAt: '2026-10-30T12:00:00Z', accountId: 'account' } };
        boundary.machineRPC.mockResolvedValueOnce(snapshot);
        expect(await machineCollectBugReportDiagnostics('machine')).toEqual(snapshot);
        expect(boundary.machineRPC).toHaveBeenCalledWith('machine', RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, {}, expect.any(Object));
        boundary.machineRPC.mockResolvedValueOnce({ daemonLogs: 'malformed' });
        expect(await machineCollectBugReportDiagnostics('machine')).toBeNull();
    });

    it('passes the selected session and explicit log exclusions through the transport', async () => {
        boundary.machineRPC.mockResolvedValueOnce({ daemonState: null, daemonLogs: [], runtime: { cwd: '', platform: 'linux', nodeVersion: 'v22' } });
        const logSelection = { daemon: false, session: true, provider: false };
        await machineCollectBugReportDiagnostics('machine', { sessionId: 'selected', serverId: getActiveServerSnapshot().serverId, logSelection });
        expect(boundary.machineRPC).toHaveBeenCalledWith('machine', RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, { sessionId: 'selected', logSelection }, expect.any(Object));
    });

    it('fails closed when saved credentials no longer belong to the captured account', async () => {
        const target = upsertServerProfile({ serverUrl: 'https://bug-report-scoped.example.test' });
        try {
            boundary.credentials.mockResolvedValue({ token: 'header.eyJzdWIiOiJuZXctYWNjb3VudCJ9.signature', secret: 'secret' });
            const result = await machineCollectBugReportDiagnostics('machine', {
                serverId: target.id, accountId: 'captured-account', sessionId: 'selected',
            });
            expect(result).toBeNull();
            expect(boundary.credentials).toHaveBeenCalledWith(target.serverUrl, { serverId: target.id });
            expect(boundary.machineRPC).not.toHaveBeenCalled();
        } finally {
            removeServerProfile(target.id);
        }
    });
});
