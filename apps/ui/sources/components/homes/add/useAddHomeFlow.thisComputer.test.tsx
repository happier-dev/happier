import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { renderHook, standardCleanup } from '@/dev/testkit';

installTokenStorageWebPlatformMocks();
const modal = vi.hoisted(() => ({ confirm: vi.fn(async () => false), alert: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.doUnmock('@/components/systemTasks/createSystemTaskBridge');
    vi.resetModules();
    vi.clearAllMocks();
});

describe('Add Home offers this computer a scoped connection', () => {
    it.each([
        { name: 'Keep', connect: false, aligned: false, accountMismatch: false, replaceCredentials: false },
        { name: 'Connect', connect: true, aligned: false, accountMismatch: false, replaceCredentials: false },
        { name: 'already connected', connect: true, aligned: true, accountMismatch: false, replaceCredentials: false },
        { name: 'declined account replacement', connect: true, aligned: false, accountMismatch: true, replaceCredentials: false },
        { name: 'credentials changed during consent', connect: true, aligned: false, accountMismatch: false, replaceCredentials: true },
    ])('preserves existing focus and connection authority: $name', async ({ connect, aligned, accountMismatch, replaceCredentials }) => {
        modal.confirm.mockResolvedValue(connect);
        if (accountMismatch) modal.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const localStorage = installLocalStorageMock();
        const locks = installWebLockManagerMock();
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `direct-home-${Date.now()}`);
        vi.stubGlobal('isTauri', true);
        const secureValues = new Map<string, string>();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: { key?: string; value?: string }) => {
            if (command.includes('secure_storage') && args?.key) {
                if (command.endsWith('_read')) return secureValues.get(args.key) ?? null;
                if (command.endsWith('_write') && args.value !== undefined) secureValues.set(args.key, args.value);
                if (command.endsWith('_remove')) secureValues.delete(args.key);
                return null;
            }
            throw new Error(`Unexpected native command ${command}`);
        } });
        const manual = createManualSystemTaskRunner();
        vi.doMock('@/components/systemTasks/createSystemTaskBridge', () => ({ createSystemTaskBridge: () => manual.bridge }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests();
        const existing = await profiles.upsertServerProfile({ serverUrl: 'https://existing-direct.example', name: 'Existing' });
        await profiles.setActiveServerId(existing.id, { scope: 'device' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50X2EifQ.sig';
        await TokenStorage.setCredentialsForServerUrl(existing.serverUrl, { serverId: existing.id }, { token });
        const { readUsableHomeServerIds } = await import('@/sync/domains/scope/usableHomeServerIds');
        await vi.waitFor(() => expect(readUsableHomeServerIds()).toContain(existing.id));
        const added = await profiles.upsertServerProfile({ serverUrl: 'https://added-direct.example', name: 'Added' });
        await TokenStorage.setCredentialsForServerUrl(added.serverUrl, { serverId: added.id }, { token });
        if (replaceCredentials) modal.confirm.mockImplementationOnce(async () => {
            await TokenStorage.setCredentialsForServerUrl(added.serverUrl, { serverId: added.id }, {
                token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50X2IifQ.sig',
            });
            return true;
        });
        const { useAddHomeFlow } = await import('./useAddHomeFlow');
        const hook = await renderHook(() => useAddHomeFlow({ initialPath: 'direct', serviceStatus: 'ready', serviceHostsHome: false, canSetUpServerHome: false }));
        try {
            await act(async () => { await hook.getCurrent().showAllHomes(); });
            expect(manual.bridge.start).not.toHaveBeenCalled();
            let connected!: ReturnType<typeof hook.getCurrent>['onConnected'] extends (...args: never[]) => infer R ? R : never;
            await act(async () => { connected = hook.getCurrent().onConnected(added); });
            await vi.waitFor(() => expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'daemon.service.status.v1', params: expect.objectContaining({ relayUrl: added.serverUrl }),
            })));
            const taskId = 'personal-home-task-1';
            manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: {
                serviceInstalled: aligned || accountMismatch, daemonRunning: aligned || accountMismatch,
                needsAuth: !(aligned || accountMismatch), machineId: aligned || accountMismatch ? 'machine-a' : null,
                daemonServerUrl: added.serverUrl, daemonAccountId: accountMismatch ? 'account_old' : 'account_a',
            } });
            await act(async () => { await connected; });
            expect(modal.confirm).toHaveBeenCalledTimes(aligned ? 0 : accountMismatch ? 2 : 1);
            expect(profiles.getActiveServerId()).toBe(existing.id);
            const setup = manual.bridge.start.mock.calls.find(([spec]) => spec.kind === 'setup.thisComputer.v1')?.[0];
            if (connect && !aligned && !accountMismatch && !replaceCredentials) {
                expect(setup).toEqual(expect.objectContaining({ params: expect.objectContaining({
                    activeRelayUrl: added.serverUrl, activeAccountId: 'account_a', installService: true, startService: true, verifyService: true,
                }) }));
            } else {
                expect(setup).toBeUndefined();
            }
        } finally {
            await hook.unmount();
            locks.restore();
            localStorage.restore();
        }
    });
});
