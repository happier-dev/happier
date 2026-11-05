import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { homeProfileForTests, installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import type { AppWindowRecord } from './appWindowBoot';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('app_window_credential_scopes');

const host = vi.hoisted(() => ({ invoke: vi.fn(), windows: vi.fn(), secure: new Map<string, string>(), events: new Map<string, (value: unknown) => void>() }));
// Only native IPC is replaced; credential storage, profiles and window orchestration stay real.
vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => 'tauri', isDesktopHost: () => true,
    getDesktopHostWindowLabel: () => 'main',
    getDesktopHostAvailability: async () => ({ windows: { kind: 'available' } }),
    invokeDesktopHost: host.invoke,
    listenDesktopHostEvent: async (event: string, handler: (value: unknown) => void) => {
        host.events.set(event, handler); return () => host.events.delete(event);
    },
}));

const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { adoptHomeProfileWithCredentials } = await import('@/sync/domains/server/adoptHomeProfile');
const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
const { registerDesktopAppWindowWorkspace } = await import('./appWindowRuntime');
const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
const homes = [homeProfileForTests('home-a', 'https://a.example.test'), homeProfileForTests('home-b', 'https://b.example.test')];
let restoreStorage: () => void;
let restoreLocks: () => void;

beforeEach(async () => {
    restoreStorage = installLocalStorageMock().restore;
    restoreLocks = installWebLockManagerMock().restore;
    host.invoke.mockReset();
    host.windows.mockReset();
    host.secure.clear();
    host.invoke.mockImplementation(async (command: string, args: { key: string; value: string }) => {
        if (command === 'desktop_secure_storage_read') return host.secure.get(args.key) ?? null;
        if (command === 'desktop_secure_storage_write') { host.secure.set(args.key, args.value); return; }
        if (command === 'desktop_secure_storage_remove') { host.secure.delete(args.key); return; }
        return await host.windows(command, args);
    });
    await seedPersistedHomeProfilesForTests({ profiles: homes, activeServerId: 'home-a' });
});
afterEach(() => { restoreLocks(); restoreStorage(); host.events.clear(); });

it('retires only the removed Home credential scope when two Homes use the same local Account id', async () => {
    for (const home of homes) expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token('same') })).toBe(true);
    host.invoke.mockClear();
    expect(await TokenStorage.removeCredentialsForServerUrl(homes[0].serverUrl, { serverId: homes[0].id })).toBe(true);
    expect(host.invoke).toHaveBeenCalledWith('desktop_app_windows_teardown', { scopes: [{ serverId: 'home-a', accountId: 'same' }] });
    expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_auth_changed')).toEqual([
        ['desktop_app_windows_auth_changed', { mutations: [{ kind: 'credentials_removed', serverId: homes[0].id, serverUrl: homes[0].serverUrl }] }],
    ]);
    expect(await TokenStorage.getCredentialsForServerUrl(homes[1].serverUrl, { serverId: homes[1].id })).toEqual({ token: token('same') });
});

it('global forget consumes both qualified credential scopes through the same mutation owner', async () => {
    const connectHome = homeProfileForTests('home-c', 'https://c.example.test');
    await seedPersistedHomeProfilesForTests({ profiles: [...homes, connectHome], activeServerId: homes[0].id });
    for (const home of homes) expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token('same') })).toBe(true);
    host.invoke.mockClear();
    expect(await TokenStorage.removeCredentials()).toBe(true);
    const scopes = host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown').flatMap(([, args]) => args.scopes);
    expect(scopes).toEqual([{ serverId: 'home-a', accountId: 'same' }, { serverId: 'home-b', accountId: 'same' }]);
    expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_auth_changed')).toEqual([
        ['desktop_app_windows_auth_changed', { mutations: [...homes, connectHome].map(home => ({
            kind: 'credentials_removed', serverId: home.id, serverUrl: home.serverUrl,
        })) }],
    ]);
    for (const home of homes) expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
});

it('a stale conditional logout cannot retire the successor credential scope', async () => {
    const home = homes[0];
    const current = { token: token('successor') };
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, current)).toBe(true);
    host.invoke.mockClear();
    expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id, expectedCredentials: { token: token('predecessor') } })).toBe(false);
    expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(current);
});

it.each(['focused', 'qualified'])('the %s credential writer retires only its replaced Home, while same-Account refresh stays local', async writer => {
    const home = homes[0];
    const write = (sub: string) => writer === 'focused'
        ? TokenStorage.setCredentials({ token: token(sub) })
        : TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token(sub) });
    expect(await write('old')).toBe(true);
    host.invoke.mockClear();
    expect(await write('old')).toBe(true);
    expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
    expect(await write('new')).toBe(true);
    expect(host.invoke).toHaveBeenCalledWith('desktop_app_windows_teardown', { scopes: [{ serverId: home.id, accountId: 'old' }] });
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token: token('new') });
});

it.each(['focused', 'qualified', 'adoption'])('the %s credential writer leaves the predecessor intact when desktop secure storage cannot read it', async writer => {
    const home = homes[0];
    const previous = { token: token('old') };
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, previous)).toBe(true);
    const stored = new Map(host.secure);
    const invoke = host.invoke.getMockImplementation()!;
    const failure = new Error('keychain_temporarily_unavailable');
    let failRead = true;
    host.invoke.mockImplementation(async (command, args) => {
        if (command === 'desktop_secure_storage_read' && failRead) { failRead = false; throw failure; }
        return await invoke(command, args);
    });
    const next = { token: token('new') };
    const write = writer === 'focused' ? TokenStorage.setCredentials(next)
        : writer === 'adoption' ? TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.id }, next)
        : TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, next);
    await expect(write).rejects.toThrow(failure.message);
    expect(host.secure).toEqual(stored);
    expect(host.windows.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(previous);
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, next)).toBe(true);
    expect(host.windows).toHaveBeenCalledWith('desktop_app_windows_teardown', { scopes: [{ serverId: home.id, accountId: 'old' }] });
});

it('Retry cannot resurrect a failed restore retired by a later Home logout', async () => {
    for (const home of homes) expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token('same') })).toBe(true);
    const record: AppWindowRecord = { windowId: 'failed-home-b', chrome: 'full', homeId: homes[1].id,
        accountId: 'same', layoutId: 'failed-home-b', selectedAddress: { kind: 'home' } };
    let retained = [record];
    let failPlacement = true;
    host.windows.mockImplementation(async (command: string, args: { activeOnly?: boolean; record?: AppWindowRecord;
        contexts?: { serverId: string; accountId: string | null }[]; scopes?: { serverId: string; accountId: string }[] }) => {
        if (command === 'desktop_app_window_restore') return args.activeOnly ? [] : retained.filter(saved => args.contexts?.some(
            context => context.serverId === saved.homeId && (context.accountId === saved.accountId || context.accountId === null && saved.chrome === 'full')));
        if (command === 'desktop_app_windows_teardown') retained = retained.filter(saved => !args.scopes?.some(
            scope => scope.serverId === saved.homeId && scope.accountId === saved.accountId));
        if (command === 'desktop_app_window_placement') {
            if (failPlacement) throw new Error('placement_unavailable');
            return { frame: null, previousFrame: null, workArea: null };
        }
        if (command === 'desktop_app_window_open' && args.record) {
            retained = [...retained.filter(saved => saved.windowId !== args.record?.windowId), args.record];
            return { windowId: args.record.windowId, ready: true, reused: false };
        }
    });
    const reported = vi.fn<(error: unknown, retry?: () => void | Promise<void>) => void>();
    const state = createWorkspaceState({ id: 'main-tab', target: { kind: 'newTab', params: {} }, pinned: false, preview: false });
    const dispose = registerDesktopAppWindowWorkspace({ windowId: 'main', scope: { serverId: homes[0].id, accountId: 'same' },
        getState: () => state, dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 }, onRestoreError: reported });
    try {
        await vi.waitFor(() => expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: 'placement_unavailable' }), expect.any(Function)));
        expect(await TokenStorage.removeCredentialsForServerUrl(homes[1].serverUrl, { serverId: homes[1].id })).toBe(true);
        expect(retained).toEqual([]);
        failPlacement = false;
        const retry = reported.mock.calls[0][1];
        if (!retry) throw new Error('failed restore did not expose Retry');
        await retry();
        // Let the native bridge continuations settle before asserting absence of a write.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(retained).toEqual([]);
        expect(host.windows.mock.calls.filter(([command]) => command === 'desktop_app_window_open')).toEqual([]);
    } finally { host.events.get('desktopAppWindow://records')?.([]); dispose(); }
});

it.each([false, true])('credentialed adoption fails closed on its writer predecessor read before replacing an Account (URL move: %s)', async move => {
    const home = homeProfileForTests('srv_home_a', homes[0].serverUrl);
    await seedPersistedHomeProfilesForTests({ profiles: [home, homes[1]], activeServerId: home.id });
    await adoptHomeProfile({ source: 'qr', descriptor: { v: 1, homeServerIdentityId: home.id,
        canonicalServerUrl: home.serverUrl, revision: 1, endpoints: [{ kind: 'https', url: home.serverUrl }] } });
    const previous = { token: token('old') };
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, previous)).toBe(true);
    const stored = new Map(host.secure);
    const invoke = host.invoke.getMockImplementation()!;
    let failRead = true;
    host.invoke.mockImplementation(async (command, args) => {
        if (command === 'desktop_secure_storage_read' && failRead) {
            failRead = false;
            throw new Error('adoption_predecessor_unavailable');
        }
        return await invoke(command, args);
    });
    const serverUrl = move ? 'https://a-moved.example.test' : home.serverUrl;
    const input = { source: 'qr' as const, credentials: { token: token('new') },
        descriptor: { v: 1 as const, homeServerIdentityId: home.id, canonicalServerUrl: serverUrl,
            revision: 2, endpoints: [{ kind: 'https' as const, url: serverUrl }] } };
    await expect(adoptHomeProfileWithCredentials(input)).rejects.toThrow('adoption_predecessor_unavailable');
    expect(host.secure).toEqual(stored);
    expect(host.windows.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(previous);
    await adoptHomeProfileWithCredentials(input);
    expect(host.windows).toHaveBeenCalledWith('desktop_app_windows_teardown', { scopes: [{ serverId: home.id, accountId: 'old' }] });
    expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: home.id })).toEqual(input.credentials);
});

it.each(['srv_home_a', 'legacy-home-a'])('moving a Home canonical URL retains its valid Account windows and saved layouts (profile id: %s)', async profileId => {
    const identity = 'srv_home_a';
    const home = homeProfileForTests(profileId, homes[0].serverUrl);
    await seedPersistedHomeProfilesForTests({ profiles: [home, homes[1]], activeServerId: home.id });
    await adoptHomeProfile({ source: 'qr', descriptor: { v: 1, homeServerIdentityId: identity,
        canonicalServerUrl: home.serverUrl, revision: 1, endpoints: [{ kind: 'https', url: home.serverUrl }] } });
    const credentials = { token: token('same') };
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: identity }, credentials)).toBe(true);
    const record: AppWindowRecord = { windowId: 'moving-home', chrome: 'full', homeId: identity,
        accountId: 'same', layoutId: 'retained-layout', selectedAddress: { kind: 'home' } };
    let retained = [record];
    // Native IPC is the boundary: reflect its teardown and forgotten-Home record retirement.
    host.windows.mockImplementation(async (command: string, args: {
        scopes?: { serverId: string; accountId: string }[];
        mutations?: { kind: string; serverId: string }[];
    }) => {
        if (command === 'desktop_app_windows_teardown') retained = retained.filter(saved => !args.scopes?.some(
            scope => scope.serverId === saved.homeId && scope.accountId === saved.accountId));
        if (command === 'desktop_app_windows_auth_changed') retained = retained.filter(saved => !args.mutations?.some(
            mutation => mutation.kind === 'credentials_removed' && mutation.serverId === saved.homeId));
    });
    const serverUrl = 'https://a-moved.example.test';
    await adoptHomeProfileWithCredentials({ source: 'qr', credentials,
        descriptor: { v: 1, homeServerIdentityId: identity, canonicalServerUrl: serverUrl,
            revision: 2, endpoints: [{ kind: 'https', url: serverUrl }] } });
    expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: identity })).toEqual(credentials);
    expect(retained).toEqual([record]);
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl)).toBeNull();
});

it('Account Directory credential replacement cannot retire Home windows with equal local ids', async () => {
    const home = homes[0];
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token('same') })).toBe(true);
    const directory = { endpoint: 'https://accounts.example.test', serverIdentityId: 'directory' };
    expect(await TokenStorage.accountDirectoryAuthCredentials.set(directory, { token: token('same') })).toBe(true);
    host.invoke.mockClear();
    expect(await TokenStorage.accountDirectoryAuthCredentials.set(directory, { token: token('different-directory-account') })).toBe(true);
    expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token: token('same') });
});

it.each([false, true])('relaunch restores each Home-local Account and keeps full Connect recovery when the second credential is absent: %s', async missingCredential => {
    for (const [index, home] of homes.entries()) {
        if (index === 1 && missingCredential) continue;
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token(`account-${index}`) })).toBe(true);
    }
    const saved: AppWindowRecord[] = homes.map((home, index) => ({ windowId: `full-${index}`, chrome: 'full', homeId: home.id,
        accountId: `account-${index}`, layoutId: `layout-${index}`, selectedAddress: { kind: 'home' } }));
    const replaced: AppWindowRecord = { ...saved[1], windowId: 'old-account', accountId: 'replaced-account' };
    host.windows.mockImplementation(async (command: string, args: { activeOnly?: boolean; accountId?: string;
        contexts?: { serverId: string; accountId: string | null }[]; record?: AppWindowRecord }) => {
        if (command === 'desktop_app_window_restore') return args.activeOnly ? [] : [...saved, ...(missingCredential ? [] : [replaced])].filter(record => args.contexts
            ? args.contexts.some(context => context.serverId === record.homeId && (context.accountId === record.accountId || context.accountId === null && record.chrome === 'full'))
            : record.accountId === args.accountId);
        if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
        if (command === 'desktop_app_window_open') return { windowId: args.record?.windowId, ready: true, reused: false };
    });
    const state = createWorkspaceState({ id: 'main-tab', target: { kind: 'newTab', params: {} }, pinned: false, preview: false });
    const dispose = registerDesktopAppWindowWorkspace({ windowId: 'main', scope: { serverId: 'home-a', accountId: 'account-0' },
        getState: () => state, dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
    try {
        await vi.waitFor(() => expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open').map(([, args]) => args.record)).toEqual(saved));
    } finally { host.events.get('desktopAppWindow://records')?.([]); dispose(); }
});
