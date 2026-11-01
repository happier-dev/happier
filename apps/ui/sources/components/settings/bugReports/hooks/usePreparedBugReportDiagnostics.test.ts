import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { usePreparedBugReportDiagnostics } from './usePreparedBugReportDiagnostics';

const credentials = vi.hoisted(() => vi.fn());
vi.mock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentialsForServerUrl: credentials } }));
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemMock().module;
});

const accountToken = 'header.eyJzdWIiOiJjYXB0dXJlZC1hY2NvdW50In0=.signature';
const changedToken = 'header.eyJzdWIiOiJuZXctYWNjb3VudCJ9.signature';

describe('prepared bug report scope', () => {
    let serverId = '';
    beforeEach(() => {
        credentials.mockReset();
        credentials.mockResolvedValue({ token: accountToken, secret: 'secret' });
        serverId = upsertServerProfile({ serverUrl: 'https://prepared-bug-report.example.test' }).id;
    });
    afterEach(() => removeServerProfile(serverId));

    const renderPrepared = () => renderHook(() => usePreparedBugReportDiagnostics({
        machines: [], includeDiagnostics: true, acceptedKinds: ['ui-mobile'], maxArtifactBytes: 128_000,
        sessionTarget: { sessionId: 'selected', serverId, accountId: 'captured-account' },
        logSelection: { daemon: false, session: false, provider: false },
    }));

    it('refuses a prepared snapshot when the selected Home credentials changed accounts', async () => {
        const hook = await renderPrepared();
        let preview: Awaited<ReturnType<ReturnType<typeof usePreparedBugReportDiagnostics>['collectDiagnosticsArtifacts']>>;
        await act(async () => { preview = await hook.getCurrent().collectDiagnosticsArtifacts(); });
        credentials.mockResolvedValue({ token: changedToken, secret: 'secret' });
        await act(async () => {
            await expect(hook.getCurrent().collectDiagnosticsArtifacts()).rejects.toThrow('bug_report_diagnostics_scope_changed');
        });
        expect(hook.getCurrent().collectionStatuses).toEqual({ scope: { status: 'unavailable', detail: 'bug_report_diagnostics_scope_changed' } });
        credentials.mockResolvedValue({ token: accountToken, secret: 'secret' });
        await act(async () => {
            expect(await hook.getCurrent().collectDiagnosticsArtifacts()).not.toBe(preview!);
        });
        expect(hook.getCurrent().collectionStatuses.scope).toBeUndefined();
    });

    it('checks account identity again before returning an awaited collection', async () => {
        credentials.mockResolvedValueOnce({ token: accountToken, secret: 'secret' });
        credentials.mockResolvedValue({ token: changedToken, secret: 'secret' });
        const hook = await renderPrepared();
        await act(async () => {
            await expect(hook.getCurrent().collectDiagnosticsArtifacts()).rejects.toThrow('bug_report_diagnostics_scope_changed');
        });
        expect(hook.getCurrent().collectionStatuses.scope?.status).toBe('unavailable');
    });
});
