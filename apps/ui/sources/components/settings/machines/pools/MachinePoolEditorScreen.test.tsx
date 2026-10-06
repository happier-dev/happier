import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, type MachinePoolViewV1 } from '@happier-dev/protocol';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resetMachinePoolSyncRuntimeForTests } from '@/sync/engine/machines/machinePoolSyncRuntime';
import { FocusReturnProvider } from '@/keyboard/focusReturn';
import { machinePoolSettingsRowTestId } from '../sections/MachinePoolsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boundaries = vi.hoisted(() => ({
    serverId: '',
    pools: null as MachinePoolViewV1[] | null,
    machines: [] as Machine[],
    machineStatus: 'idle' as 'idle' | 'loading' | 'signedOut' | 'error',
    create: vi.fn<(serverId: string, input: Record<string, unknown>) => Promise<unknown>>(),
    update: vi.fn<(serverId: string, input: Record<string, unknown>) => Promise<unknown>>(),
    remove: vi.fn<(serverId: string, input: Record<string, unknown>) => Promise<void>>(),
    back: vi.fn(),
    // The native stack header the page hands its phone actions to (a platform navigation boundary).
    navigation: { setOptions: vi.fn<(options: Record<string, unknown>) => void>() },
    push: vi.fn(),
    replace: vi.fn(),
    dismissTo: vi.fn(),
    setParams: vi.fn(),
    routeStack: ['/settings/machines'] as string[],
    request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    pressableFocus: vi.fn<(testID: string | null) => void>(),
    textInputFocus: vi.fn<(testID: string | null) => void>(),
    accessibilityFocus: vi.fn<(reactTag: number) => void>(),
    randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
}));

const artifactStore = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });

vi.mock('react-native', async () => {
    const {
        createFocusablePressableMock,
        createFocusableTextInputMock,
        createReactNativeNativeMock,
    } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeNativeMock(
        { platformOS: 'ios' },
        {
            AccessibilityInfo: {
                setAccessibilityFocus: (reactTag: number) => boundaries.accessibilityFocus(reactTag),
            },
            findNodeHandle: () => 41,
        },
    );
    return {
        ...base,
        Pressable: createFocusablePressableMock(
            () => undefined,
            (props) => boundaries.pressableFocus(typeof props.testID === 'string' ? props.testID : null),
        ),
        TextInput: createFocusableTextInputMock(
            () => undefined,
            (props) => boundaries.textInputFocus(typeof props.testID === 'string' ? props.testID : null),
        ),
    };
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      navigation: boundaries.navigation,
      pathname: () => boundaries.routeStack.at(-1)?.split('?')[0] ?? '/',
      params: () => {
        const route = boundaries.routeStack.at(-1) ?? '/';
        const url = new URL(route, 'https://happier.test');
        const id = url.pathname.startsWith('/inbox/approvals/')
            ? url.pathname.slice('/inbox/approvals/'.length)
            : undefined;
        return { ...(id ? { id } : {}), ...Object.fromEntries(url.searchParams.entries()) };
      },
      router: {
        canGoBack: () => boundaries.routeStack.length > 1,
        back: () => {
            boundaries.back();
            if (boundaries.routeStack.length > 1) boundaries.routeStack.pop();
        },
        push: (href) => {
            const route = String(href);
            boundaries.push(route);
            boundaries.routeStack.push(route);
        },
        replace: (href) => {
            const route = String(href);
            boundaries.replace(route);
            boundaries.routeStack.splice(-1, 1, route);
        },
        dismissTo: (href) => {
            const route = String(href);
            boundaries.dismissTo(route);
            const targetIndex = boundaries.routeStack
                .map((entry: string) => entry.split('?')[0])
                .lastIndexOf(route);
            boundaries.routeStack.splice(targetIndex >= 0 ? targetIndex + 1 : 0);
            if (targetIndex < 0) boundaries.routeStack.push(route);
        },
        setParams: (params) => boundaries.setParams(params),
      },
    }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => boundaries.randomUUID() }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({ isFocused: true });
});

const poolView = (revision: number, memberState: 'connected' | 'offline' | 'revoked' = 'connected') => ({
    pool: {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Development',
        description: null,
        revision,
        createdAt: 1,
        updatedAt: revision,
        members: [{ machineId: 'machine-a', priorityTier: 2, enabled: true, state: memberState }],
    },
    availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
}) satisfies MachinePoolViewV1;

const twoTierPool = (revision: number) => ({
    pool: {
        id: '00000000-0000-4000-8000-000000000003',
        name: 'Development',
        description: null,
        revision,
        createdAt: 1,
        updatedAt: revision,
        members: [
            { machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' as const },
            { machineId: 'machine-b', priorityTier: 1, enabled: true, state: 'connected' as const },
        ],
    },
    availability: { state: 'known' as const, connectedCount: 2, enabledCount: 2 },
}) satisfies MachinePoolViewV1;

const sameTierPool = (revision: number) => ({
    pool: {
        id: '00000000-0000-4000-8000-000000000004',
        name: 'Development',
        description: null,
        revision,
        createdAt: 1,
        updatedAt: revision,
        members: [
            { machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' as const },
            { machineId: 'machine-b', priorityTier: 0, enabled: true, state: 'connected' as const },
            { machineId: 'machine-z', priorityTier: 0, enabled: true, state: 'connected' as const },
        ],
    },
    availability: { state: 'known' as const, connectedCount: 3, enabledCount: 3 },
}) satisfies MachinePoolViewV1;

const initialStorageState = getStorage().getState();
const initialSyncCredentials = sync.getCredentials();
const featureResponse = {
    features: { machines: { enabled: true, pools: { enabled: true } } },
    capabilities: { accountStoredContentCompatibility: {
        v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
    } },
};

function machineMetadata(displayName: string): NonNullable<Machine['metadata']> {
    const metadata = createMachineFixture().metadata;
    if (!metadata) throw new Error('Canonical Machine fixture must include metadata');
    return { ...metadata, displayName };
}

async function readInput(init?: RequestInit): Promise<Record<string, unknown>> {
    return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

async function actionResponse(url: string, init?: RequestInit): Promise<Response> {
    const input = await readInput(init);
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/auth/ping' || pathname === '/health') return Response.json({ ok: true });
    if (pathname === '/v1/features') return Response.json(featureResponse);
    if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
    const artifactResponse = artifactStore.handle(pathname, init);
    if (artifactResponse) return artifactResponse;
    const action = pathname.split('/').at(-1) ?? '';
    try {
        if (action === 'list') return Response.json({ pools: boundaries.pools ?? [] });
        if (action === 'create') return Response.json(await boundaries.create(boundaries.serverId, input));
        if (action === 'update') return Response.json(await boundaries.update(boundaries.serverId, input));
        if (action === 'delete') {
            await boundaries.remove(boundaries.serverId, input);
            return Response.json({ poolId: input.poolId, deleted: true });
        }
        return Response.json({ code: 'invalid_request', message: `Unexpected action ${action}` }, { status: 400 });
    } catch (cause) {
        const { MachinePoolActionError } = await import('@/sync/api/machines/machinePoolActions');
        if (cause instanceof MachinePoolActionError) return Response.json(cause.detail, { status: cause.status });
        throw cause;
    }
}

/** Delete lives in the saved pool's `⋯` menu: choose it there, as a person would. */
async function chooseDelete(screen: Awaited<ReturnType<typeof renderScreen>>): Promise<void> {
    const menu = screen.root.findAll((node) => node.props?.testID === 'settings.machinePools.editor.menu'
        && typeof node.props?.onSelect === 'function')[0];
    if (!menu) throw new Error('Expected the pool ⋯ menu');
    await act(async () => { await menu.props.onSelect('delete'); });
}
function chooseDeleteWithoutAwaiting(screen: Awaited<ReturnType<typeof renderScreen>>): void {
    const menu = screen.root.findAll((node) => node.props?.testID === 'settings.machinePools.editor.menu'
        && typeof node.props?.onSelect === 'function')[0];
    if (!menu) throw new Error('Expected the pool ⋯ menu');
    void menu.props.onSelect('delete');
}

async function publishBoundaryState(): Promise<void> {
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
        profileScope: { serverId: boundaries.serverId, accountId: 'account-a' },
        settingsScope: { serverId: boundaries.serverId, accountId: 'account-a' },
        machineListByServerId: { [boundaries.serverId]: boundaries.machines },
        machineListStatusByServerId: { [boundaries.serverId]: boundaries.machineStatus },
        machinePoolListByServerId: { [boundaries.serverId]: boundaries.pools },
        machinePoolListStatusByServerId: { [boundaries.serverId]: boundaries.pools === null ? 'loading' : 'idle' },
        machinePoolAccountIdByServerId: { [boundaries.serverId]: 'account-a' },
    });
}

describe('MachinePoolEditorScreen', () => {
    beforeEach(async () => {
        resetMachinePoolSyncRuntimeForTests();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialStorageState, true);
        boundaries.serverId = (await upsertAndActivateServer({ serverUrl: 'https://machine-pools-editor.test', name: 'Machine Pools Test' })).id;
        boundaries.pools = null;
        boundaries.machines = [];
        boundaries.machineStatus = 'idle';
        boundaries.create.mockReset();
        boundaries.update.mockReset();
        boundaries.remove.mockReset();
        vi.mocked(Modal.show).mockReset().mockReturnValue('machine-pool-member-picker');
        vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
        boundaries.back.mockReset();
        boundaries.push.mockReset();
        boundaries.replace.mockReset();
        boundaries.dismissTo.mockReset();
        boundaries.setParams.mockReset();
        boundaries.routeStack = ['/settings/machines'];
        artifactStore.clear();
        boundaries.pressableFocus.mockReset();
        boundaries.textInputFocus.mockReset();
        boundaries.accessibilityFocus.mockReset();
        boundaries.randomUUID.mockReset().mockReturnValue('00000000-0000-4000-8000-000000000001');
        Reflect.set(sync, 'credentials', { token: createAccountTokenForTests('account-a') });
        boundaries.request.mockReset().mockImplementation((url: string, init?: RequestInit) => actionResponse(url, init));
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('account-a') });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(featureResponse)));
        await getServerFeaturesSnapshot({ serverId: boundaries.serverId, force: true });
        setRuntimeFetch((url, init) => boundaries.request(String(url), init));
        await act(async () => publishBoundaryState());
    });

    it('keeps Create disabled until the pool has a name, and sends nothing for a blank one', async () => {
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);
        boundaries.request.mockClear();

        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', '   '));
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Build farm'));
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(false);
        expect(boundaries.create).not.toHaveBeenCalled();
    });

    it('hands Create and Cancel to the native header on a phone instead of stacking them under the title', async () => {
        const [{ MachinePoolEditorScreen }, { NavigationTitleChromeProvider }] = await Promise.all([
            import('./MachinePoolEditorScreen'),
            import('@/components/ui/layout/PageHeader'),
        ]);
        const screen = await renderScreen(
            <NavigationTitleChromeProvider showsTitle>
                <MachinePoolEditorScreen serverId={boundaries.serverId} />
            </NavigationTitleChromeProvider>,
        );

        const published = boundaries.navigation.setOptions.mock.calls
            .map(([options]) => options as { headerRight?: () => React.ReactElement; headerLeft?: () => React.ReactElement })
            .filter((options) => options.headerRight || options.headerLeft);
        expect(published.length).toBeGreaterThan(0);
        const options = published.at(-1)!;
        // The page itself keeps neither button: one primary lives in the chrome, beside the title it shows.
        expect(screen.findByTestId('settings.machinePools.editor.save')).toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.cancel')).toBeNull();

        const header = await renderScreen(<>{options.headerLeft?.()}{options.headerRight?.()}</>);
        expect(header.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        await header.pressByTestIdAsync('settings.machinePools.editor.cancel');
        // Cancel leaves the form (back, or the Machines fallback when there is no history).
        expect(boundaries.back.mock.calls.length + boundaries.replace.mock.calls.length).toBeGreaterThan(0);
    });

    it('keeps Save disabled on a saved pool until something changes', async () => {
        boundaries.pools = [twoTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Linux box') }),
        ];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={twoTierPool(1).pool.id} />);

        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Development'));
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Development 2'));
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(false);
    });

    it('adds machines into the tier whose Add row was used', async () => {
        boundaries.pools = [twoTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Linux box') }),
            createMachineFixture({ id: 'machine-c', metadata: machineMetadata('Build runner') }),
        ];
        await publishBoundaryState();
        boundaries.update.mockResolvedValue(twoTierPool(2));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={twoTierPool(1).pool.id} />);

        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.addMachines.tier.1')).not.toBeNull());
        await screen.pressByTestIdAsync('settings.machinePools.editor.addMachines.tier.1');
        const onSelect = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props?.onSelect as ((optionId: string) => void) | undefined;
        await act(async () => onSelect?.('machine-c'));
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');

        await vi.waitFor(() => expect(boundaries.update).toHaveBeenCalledOnce());
        expect(boundaries.update.mock.calls[0]?.[1].members).toEqual(expect.arrayContaining([
            { machineId: 'machine-c', priorityTier: 1, enabled: true },
        ]));
    });

    it('pauses a member for new sessions from its row menu', async () => {
        boundaries.pools = [twoTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Linux box') }),
        ];
        await publishBoundaryState();
        boundaries.update.mockResolvedValue(twoTierPool(2));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={twoTierPool(1).pool.id} />);

        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.member.machine-a.menu')).not.toBeNull());
        await screen.pressByTestIdAsync('settings.machinePools.editor.member.machine-a.menu');
        const onSelect = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props?.onSelect as ((optionId: string) => void) | undefined;
        await act(async () => onSelect?.('pause'));
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');

        await vi.waitFor(() => expect(boundaries.update).toHaveBeenCalledOnce());
        expect(boundaries.update.mock.calls[0]?.[1].members).toEqual(expect.arrayContaining([
            { machineId: 'machine-a', priorityTier: 0, enabled: false },
        ]));
    });

    it.each([
        { action: 'create' as const, actionId: 'machines.pools.create' as const },
        { action: 'update' as const, actionId: 'machines.pools.update' as const },
        { action: 'delete' as const, actionId: 'machines.pools.delete' as const },
    ])('completes an approved $action through the pushed approval route at Machines Settings', async ({ action, actionId }) => {
        const current = poolView(1);
        const next = {
            ...poolView(1),
            pool: { ...poolView(1).pool, id: '00000000-0000-4000-8000-000000000003', name: 'Next pool' },
        } satisfies MachinePoolViewV1;
        if (action !== 'create') boundaries.pools = action === 'delete' ? [current, next] : [current];
        boundaries.machines = [createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') })];
        boundaries.create.mockResolvedValue(poolView(0));
        boundaries.update.mockResolvedValue(poolView(2));
        boundaries.remove.mockResolvedValue(undefined);
        await act(async () => publishBoundaryState());
        getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
            [actionId]: { approvalRequiredSurfaces: ['ui'] },
        } }) });
        const [{ MachinePoolsSection }, { MachinePoolEditorScreen }] = await Promise.all([
            import('../sections/MachinePoolsSection'),
            import('./MachinePoolEditorScreen'),
        ]);
        const ApprovalDetailPage = (await import('@/app/(app)/inbox/approvals/[id]')).default;
        const group = {
            serverId: boundaries.serverId,
            serverName: 'Machine Pools Test',
            status: 'idle' as const,
            machines: boundaries.machines,
        };
        const originTestId = machinePoolSettingsRowTestId(boundaries.serverId, current.pool.id);
        const nextTestId = machinePoolSettingsRowTestId(boundaries.serverId, next.pool.id);
        const screen = action === 'delete'
            ? await renderScreen(<FocusReturnProvider><MachinePoolsSection groups={[group]} /></FocusReturnProvider>)
            : await renderScreen(<FocusReturnProvider><MachinePoolEditorScreen serverId={boundaries.serverId} poolId={action === 'update' ? current.pool.id : undefined} /></FocusReturnProvider>);

        if (action === 'delete') {
            await screen.pressByTestIdAsync(originTestId);
            await act(async () => screen.tree.update(
                <FocusReturnProvider><MachinePoolEditorScreen serverId={boundaries.serverId} poolId={current.pool.id} /></FocusReturnProvider>,
            ));
        }
        if (action !== 'delete') {
            boundaries.routeStack.push(action === 'create'
                ? `/settings/machines/pools/new?serverId=${encodeURIComponent(boundaries.serverId)}`
                : `/settings/machines/pools/${current.pool.id}?serverId=${encodeURIComponent(boundaries.serverId)}`);
        }
        if (action !== 'delete') {
            // Save is the pool's one primary action and stays disabled until the draft changes.
            await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', action === 'create' ? 'Development' : 'Development renamed'));
        }
        if (action === 'delete') await chooseDelete(screen);
        else await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(artifactStore.list()).toHaveLength(1));
        expect(boundaries[action === 'create' ? 'create' : action === 'update' ? 'update' : 'remove']).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings.machinePools.editor.approval');
        expect(boundaries.routeStack).toHaveLength(3);
        await act(async () => screen.tree.update(<FocusReturnProvider><ApprovalDetailPage /></FocusReturnProvider>));
        await vi.waitFor(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
        await screen.pressByTestIdAsync('approvals.approve');

        const actionBoundary = boundaries[action === 'create' ? 'create' : action === 'update' ? 'update' : 'remove'];
        await vi.waitFor(() => expect(actionBoundary).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(boundaries.routeStack).toEqual(['/settings/machines']));
        expect(boundaries.dismissTo).toHaveBeenCalledWith('/settings/machines');
        expect(actionBoundary).toHaveBeenCalledTimes(1);

        if (action === 'delete') {
            await act(async () => screen.tree.update(
                <FocusReturnProvider><MachinePoolsSection groups={[group]} /></FocusReturnProvider>,
            ));
            await vi.waitFor(() => expect(boundaries.pressableFocus).toHaveBeenCalledWith(nextTestId));
            expect(boundaries.pressableFocus).not.toHaveBeenCalledWith(originTestId);
        }
    });

    afterEach(() => {
        resetMachinePoolSyncRuntimeForTests();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        Reflect.set(sync, 'credentials', initialSyncCredentials);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('preserves a proposed create and opens its pending approval without submitting another request', async () => {
        getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'machines.pools.create': { approvalRequiredSurfaces: ['ui'] },
        } }) });
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Development'));

        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(Object.keys(getStorage().getState().artifacts)).toHaveLength(1));
        expect(boundaries.create).not.toHaveBeenCalled();
        expect(boundaries.back).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Development');
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('settings.machinePools.editor.approval');
        expect(boundaries.push).toHaveBeenCalledWith(
            `/inbox/approvals/00000000-0000-4000-8000-000000000001?serverId=${encodeURIComponent(boundaries.serverId)}&completionHref=${encodeURIComponent('/settings/machines')}`,
        );
    });

    it('keeps human Delete confirmation and restores the form after its pending approval is rejected', async () => {
        // Request identities and artifact identities both use the OS randomness
        // boundary. Mint distinct values without assuming their consumption order.
        let nextUuid = 0;
        boundaries.randomUUID.mockImplementation(() => `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, '0')}`);
        boundaries.pools = [poolView(1)];
        await act(async () => publishBoundaryState());
        getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'machines.pools.delete': { approvalRequiredSurfaces: ['ui'] },
            'machines.pools.update': { approvalRequiredSurfaces: ['ui'] },
        } }) });
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Unsaved change'));
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await chooseDelete(screen);
        expect(artifactStore.list()).toHaveLength(0);
        expect(boundaries.remove).not.toHaveBeenCalled();

        await chooseDelete(screen);
        await vi.waitFor(() => expect(artifactStore.list()).toHaveLength(1));
        const rejectedApprovalId = artifactStore.list()[0]!.id;
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        expect(boundaries.remove).not.toHaveBeenCalled();
        expect(boundaries.back).not.toHaveBeenCalled();
        await act(async () => {
            await createDefaultActionExecutor().execute('approval.request.decide', {
                artifactId: rejectedApprovalId, decision: 'reject',
            }, { serverId: boundaries.serverId, surface: 'ui' });
        });
        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(false));
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Unsaved change');
        expect(boundaries.remove).not.toHaveBeenCalled();
        expect(boundaries.back).not.toHaveBeenCalled();

        // A rejected delete keeps the Pool. A later Save therefore returns focus to that Pool,
        // not to the stale next-row target computed for the abandoned delete proposal.
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(artifactStore.list()).toHaveLength(2));
        const nextApprovalId = artifactStore.list().map((artifact) => artifact.id).find((id) => id !== rejectedApprovalId);
        expect(nextApprovalId).toBeDefined();
        await screen.pressByTestIdAsync('settings.machinePools.editor.approval');
        expect(boundaries.push).toHaveBeenLastCalledWith(
            `/inbox/approvals/${nextApprovalId}?serverId=${encodeURIComponent(boundaries.serverId)}&completionHref=${encodeURIComponent('/settings/machines')}`,
        );
    });

    it('reuses the author-minted pool ID when a create response is lost and the user retries', async () => {
        boundaries.create.mockRejectedValueOnce(new Error('response_lost')).mockResolvedValueOnce(poolView(0));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Development'));

        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(boundaries.create).toHaveBeenCalledTimes(1));
        expect(boundaries.back).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(boundaries.create).toHaveBeenCalledTimes(2));

        expect(boundaries.create.mock.calls[0]?.[1].poolId).toBe('00000000-0000-4000-8000-000000000001');
        expect(boundaries.create.mock.calls[1]?.[1].poolId).toBe(boundaries.create.mock.calls[0]?.[1].poolId);
    });

    it('keeps the loaded CAS revision and serializes tiers contiguously after a fresher store projection arrives', async () => {
        boundaries.pools = [poolView(1)];
        await act(async () => publishBoundaryState());
        boundaries.update.mockResolvedValue(poolView(2));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const element = <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />;
        const screen = await renderScreen(element);

        boundaries.pools = [poolView(9)];
        await act(async () => publishBoundaryState());
        await act(async () => screen.tree.update(element));
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Development renamed'));
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(boundaries.update).toHaveBeenCalledOnce());

        expect(boundaries.update.mock.calls[0]?.[1]).toMatchObject({
            expectedRevision: 1,
            members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true }],
        });
    });

    it('reports a failed refresh truthfully and keeps the form editable with an explicit Retry', async () => {
        boundaries.pools = [poolView(1)];
        await act(async () => publishBoundaryState());
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const element = <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />;
        const screen = await renderScreen(element);

        // The pool list boundary starts failing after the row is already hydrated.
        boundaries.request.mockImplementation((url: string, init?: RequestInit) => (
            url.endsWith('/v1/machines/pools/list')
                ? Promise.reject(new Error('network_unreachable'))
                : actionResponse(url, init)
        ));
        await act(async () => {
            const { storage } = await import('@/sync/domains/state/storage');
            storage.getState().setMachinePoolListStatus(boundaries.serverId, 'error');
        });
        await act(async () => screen.tree.update(element));

        // A failed read is not an offline Home, and it must not silently remove administration.
        expect(screen.findByTestId('settings.machinePools.editor.offline')).toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.refreshFailed')).not.toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.editable).toBe(true);

        boundaries.request.mockClear();
        await screen.pressByTestIdAsync('settings.machinePools.editor.retry');
        await vi.waitFor(() => expect(boundaries.request.mock.calls.some(([url]) => url.endsWith('/v1/machines/pools/list'))).toBe(true));
    });

    it('reports feature discovery failure truthfully and keeps the editor fail closed', async () => {
        boundaries.pools = [poolView(1)];
        await act(async () => publishBoundaryState());
        resetServerFeaturesClientForTests();
        boundaries.request.mockImplementation((url: string, init?: RequestInit) => (
            url.endsWith('/v1/features')
                ? Promise.resolve(Response.json({}, { status: 503 }))
                : actionResponse(url, init)
        ));
        vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => (
            boundaries.request(String(input), init)
        )));
        await getServerFeaturesSnapshot({ serverId: boundaries.serverId, force: true });

        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(
            <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />,
        );

        expect(screen.findByTestId('settings.machinePools.editor.loading')).toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.refreshFailed')).not.toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.editable).toBe(false);
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Development');

        boundaries.request.mockClear();
        await screen.pressByTestIdAsync('settings.machinePools.editor.retry');
        await vi.waitFor(() => expect(boundaries.request.mock.calls.some(([url]) => url.endsWith('/v1/features'))).toBe(true));
    });

    it('withdraws the private draft before a replacement Home credential can render', async () => {
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);
        await act(async () => screen.changeTextByTestId(
            'settings.machinePools.editor.name',
            'Account A private draft',
        ));
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value)
            .toBe('Account A private draft');

        const accountBCredentials = { token: createAccountTokenForTests('account-b') };
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(accountBCredentials);
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(
                'https://machine-pools-editor.test',
                { serverId: boundaries.serverId },
                accountBCredentials,
            );
        });

        await vi.waitFor(() => expect(
            screen.findByTestId('settings.machinePools.editor.name')?.props.value,
        ).toBe(''));
        await TokenStorage.removeCredentialsForServerUrl(
            'https://machine-pools-editor.test',
            { serverId: boundaries.serverId },
        );
    });

    it('retires an Account-scoped delete confirmation when the Home credential changes', async () => {
        boundaries.pools = [poolView(1)];
        await act(async () => publishBoundaryState());
        let resolveConfirmation!: (confirmed: boolean) => void;
        vi.mocked(Modal.confirm).mockReturnValueOnce(new Promise<boolean>((resolve) => {
            resolveConfirmation = resolve;
        }));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(
            <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />,
        );
        // Start the deliberately unresolved confirmation without keeping React's global `act`
        // scope open across the credential mutation below.
        chooseDeleteWithoutAwaiting(screen);
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledOnce());

        const accountBCredentials = { token: createAccountTokenForTests('account-b') };
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(accountBCredentials);
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(
                'https://machine-pools-editor.test',
                { serverId: boundaries.serverId },
                accountBCredentials,
            );
        });
        await act(async () => resolveConfirmation(true));
        await vi.waitFor(() => expect(boundaries.remove).not.toHaveBeenCalled());

        expect(boundaries.remove).not.toHaveBeenCalled();
        await TokenStorage.removeCredentialsForServerUrl(
            'https://machine-pools-editor.test',
            { serverId: boundaries.serverId },
        );
    });

    it('uses the loaded CAS revision for delete and disables all writes while the Home is signed out', async () => {
        boundaries.pools = [poolView(3)];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const element = <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(3).pool.id} />;
        const screen = await renderScreen(element);

        boundaries.pools = [poolView(7)];
        await act(async () => publishBoundaryState());
        await act(async () => screen.tree.update(element));
        await chooseDelete(screen);
        await vi.waitFor(() => expect(boundaries.remove).toHaveBeenCalledOnce());
        expect(boundaries.remove.mock.calls[0]?.[1].expectedRevision).toBe(3);

        boundaries.machineStatus = 'signedOut';
        await act(async () => publishBoundaryState());
        await act(async () => screen.tree.update(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(3).pool.id} />));
        expect(screen.findByTestId('settings.machinePools.editor.offline')).not.toBeNull();
    });

    it('preserves the local draft on a CAS conflict and reloads only after confirmation', async () => {
        boundaries.pools = [poolView(1)];
        await publishBoundaryState();
        const [{ MachinePoolEditorScreen }, { MachinePoolActionError }] = await Promise.all([
            import('./MachinePoolEditorScreen'),
            import('@/sync/api/machines/machinePoolActions'),
        ]);
        const current = { ...poolView(4), pool: { ...poolView(4).pool, name: 'Remote' } };
        boundaries.update.mockRejectedValue(new MachinePoolActionError(409, { code: 'pool_changed', current }));
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Local'));

        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.conflict')).not.toBeNull());
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Local');

        await act(async () => screen.findByTestId('settings.machinePools.editor.reload')?.props.onPress());
        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Remote'));
    });

    it('renders the server-observed offline member state even when the local Machine snapshot is active', async () => {
        const offline = poolView(1, 'offline');
        boundaries.pools = [offline];
        boundaries.machines = [createMachineFixture({ id: 'machine-a', active: true, activeAt: 2, updatedAt: 2, metadata: machineMetadata('A') })];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={offline.pool.id} />);

        expect(screen.findByTestId('settings.machinePools.editor.member.machine-a.status')?.props.accessibilityLabel).toBe('offline');
    });

    it('names a member removed from this Home as removed, never locked, and still offers Remove', async () => {
        const removed = poolView(1, 'revoked');
        boundaries.pools = [removed];
        boundaries.machines = [];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={removed.pool.id} />);

        const row = screen.findAll((node) => node.props?.testID === 'settings.machinePools.editor.member.machine-a'
            && typeof node.props?.title === 'string')[0];
        expect(row?.props.title).toBe('Removed machine');
        await screen.pressByTestIdAsync('settings.machinePools.editor.member.machine-a');
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        const rootStep = config?.props?.rootStep as SelectionListStep | undefined;
        const options = (rootStep?.sections ?? []).flatMap((section) => section.kind === 'static' ? section.options : []);
        expect(options.map((option) => option.id)).toContain('remove');
    });

    it('presents equal-tier members by stable display label with Machine ID as the tie-break', async () => {
        boundaries.pools = [sameTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Zebra') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Alpha') }),
            createMachineFixture({ id: 'machine-z', metadata: machineMetadata('Alpha') }),
        ];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={sameTierPool(1).pool.id} />);

        const memberRows = Array.from(new Set(screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && /^settings\.machinePools\.editor\.member\.machine-[^.]+$/.test(node.props.testID)
        )).map((node) => node.props.testID as string)));

        expect(memberRows).toEqual([
            'settings.machinePools.editor.member.machine-b',
            'settings.machinePools.editor.member.machine-z',
            'settings.machinePools.editor.member.machine-a',
        ]);
    });

    it('labels the pool name and description fields for assistive technology', async () => {
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);

        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.accessibilityLabel).toBe('Name');
        expect(screen.findByTestId('settings.machinePools.editor.description')?.props.accessibilityLabel).toBe('Description (optional)');
    });

    it('opens the shared searchable selection list and permits an offline persistent machine', async () => {
        boundaries.machines = [createMachineFixture({ id: 'machine-offline', active: false, metadata: machineMetadata('Offline machine') })];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);

        expect(screen.findAllByTestId('settings.machinePools.editor.addMachines')[0]?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('settings.machinePools.editor.addMachines');

        expect(Modal.show).toHaveBeenCalledOnce();
        const config = vi.mocked(Modal.show).mock.calls[0]?.[0];
        // The generic modal mock erases the displayed component's props type.
        const rootStep = config?.props?.rootStep as SelectionListStep | undefined;
        const section = rootStep?.sections[0];
        if (!section || section.kind !== 'static') throw new Error('Expected static Machine picker section');
        const option = section.options[0];
        expect(option).toMatchObject({ id: 'machine-offline', disabled: false });
    });

    it('explains why Add machines is unavailable once every eligible machine is already a member', async () => {
        boundaries.machines = [createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') })];
        boundaries.pools = [poolView(1)];
        await act(async () => publishBoundaryState());
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(
            <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />,
        );

        // The Home does have an eligible Machine, so "no persistent machines" would be untrue. A
        // disabled action still has to say why it is disabled.
        await vi.waitFor(() => {
            expect(screen.findByTestId('settings.machinePools.editor.member.machine-a')).not.toBeNull();
            // One line says why nothing can be added, in place of a dead "Add machines" row.
            expect(screen.findAllByTestId('settings.machinePools.editor.allMachinesAdded')).not.toHaveLength(0);
            expect(screen.findAllByTestId('settings.machinePools.editor.addMachines')).toHaveLength(0);
        });
        expect(screen.findAllByTestId('settings.machinePools.editor.noMachines')).toHaveLength(0);
    });

    it('excludes temporary session runners from pool membership', async () => {
        boundaries.machines = [
            createMachineFixture({ id: 'persistent', kind: 'persistent' }),
            createMachineFixture({ id: 'temporary', kind: 'ephemeral_session_runner' }),
        ];
        await publishBoundaryState();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);

        expect(screen.findAllByTestId('settings.machinePools.editor.addMachines')[0]?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('settings.machinePools.editor.addMachines');
        const config = vi.mocked(Modal.show).mock.calls[0]?.[0];
        // The generic modal mock erases the displayed component's props type.
        const rootStep = config?.props?.rootStep as SelectionListStep | undefined;
        const section = rootStep?.sections[0];
        if (!section || section.kind !== 'static') throw new Error('Expected static Machine picker section');
        expect(section.options.map((option) => option.id)).toEqual(['persistent']);
    });

    it('keeps the draft and marks every ineligible member row returned by the aggregate owner', async () => {
        boundaries.pools = [poolView(1)];
        boundaries.machines = [createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') })];
        await publishBoundaryState();
        const [{ MachinePoolEditorScreen }, { MachinePoolActionError }] = await Promise.all([
            import('./MachinePoolEditorScreen'),
            import('@/sync/api/machines/machinePoolActions'),
        ]);
        boundaries.update.mockRejectedValue(new MachinePoolActionError(400, {
            code: 'member_machine_not_eligible', machineIds: ['machine-a'],
        }));
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />);
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Local edit'));

        await screen.pressByTestIdAsync('settings.machinePools.editor.save');

        await vi.waitFor(() => expect(screen.findByTestId('settings.machinePools.editor.error')).not.toBeNull());
        // The row names the machine, its tier and the repair, so the actionable error is
        // identifiable without sight and without a second stacked notice row.
        const label = screen.findByTestId('settings.machinePools.editor.member.machine-a')?.props.accessibilityLabel;
        expect(label).toContain('Mac Studio');
        expect(label).toContain('Primary');
        expect(label).toContain('persistent machine');
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Local edit');
    });

    it('focuses the first actionable invalid member in the rendered member order', async () => {
        boundaries.pools = [sameTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Zebra') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Alpha') }),
            createMachineFixture({ id: 'machine-z', metadata: machineMetadata('Omega') }),
        ];
        await publishBoundaryState();
        const [{ MachinePoolEditorScreen }, { MachinePoolActionError }, { Item }] = await Promise.all([
            import('./MachinePoolEditorScreen'),
            import('@/sync/api/machines/machinePoolActions'),
            import('@/components/ui/lists/Item'),
        ]);
        const actionError = new MachinePoolActionError(400, {
            code: 'member_machine_not_eligible',
            // Server order is deliberately different from the visible Alpha → Omega → Zebra order.
            machineIds: ['machine-a', 'machine-b'],
        });
        let rejectUpdate: ((cause: unknown) => void) | null = null;
        boundaries.update.mockImplementation(() => new Promise((_, reject) => {
            rejectUpdate = reject;
        }));
        const screen = await renderScreen(
            <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={sameTierPool(1).pool.id} />,
        );
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Development renamed'));
        const savePromise = screen.pressByTestIdAsync('settings.machinePools.editor.save');
        await vi.waitFor(() => expect(boundaries.update).toHaveBeenCalledOnce());
        await act(async () => rejectUpdate?.(actionError));
        await savePromise;

        await vi.waitFor(() => expect(boundaries.pressableFocus).toHaveBeenCalledWith(
            'settings.machinePools.editor.member.machine-b',
        ));
        expect(boundaries.pressableFocus).not.toHaveBeenCalledWith(
            'settings.machinePools.editor.member.machine-a',
        );
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.value).toBe('Development renamed');
    });

    it('retargets successful deletion to the next Pool row', async () => {
        const current = poolView(1);
        const next = {
            ...poolView(1),
            pool: { ...poolView(1).pool, id: '00000000-0000-4000-8000-000000000003', name: 'Next pool' },
        } satisfies MachinePoolViewV1;
        boundaries.pools = [current, next];
        boundaries.machines = [createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') })];
        await publishBoundaryState();
        const [{ MachinePoolsSection }, { MachinePoolEditorScreen }] = await Promise.all([
            import('../sections/MachinePoolsSection'),
            import('./MachinePoolEditorScreen'),
        ]);
        const group = {
            serverId: boundaries.serverId,
            serverName: 'Machine Pools Test',
            status: 'idle' as const,
            machines: boundaries.machines,
        };
        const originTestId = `settings.machinePools.row.${boundaries.serverId}.${current.pool.id}`;
        const nextTestId = `settings.machinePools.row.${boundaries.serverId}.${next.pool.id}`;
        const screen = await renderScreen(
            <FocusReturnProvider><MachinePoolsSection groups={[group]} /></FocusReturnProvider>,
        );
        await screen.pressByTestIdAsync(originTestId);

        await act(async () => {
            screen.tree.update(
                <FocusReturnProvider>
                    <MachinePoolEditorScreen serverId={boundaries.serverId} poolId={current.pool.id} />
                </FocusReturnProvider>,
            );
        });
        await chooseDelete(screen);
        await vi.waitFor(() => expect(boundaries.back).toHaveBeenCalledOnce());

        await act(async () => {
            screen.tree.update(
                <FocusReturnProvider><MachinePoolsSection groups={[group]} /></FocusReturnProvider>,
            );
        });

        await vi.waitFor(() => expect(boundaries.pressableFocus).toHaveBeenCalledWith(nextTestId));
        expect(boundaries.pressableFocus).not.toHaveBeenCalledWith(originTestId);
        expect(boundaries.accessibilityFocus).toHaveBeenCalledWith(41);
    });

    it('offers tier placement and removal in one labeled action list per member', async () => {
        boundaries.pools = [twoTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Linux box') }),
        ];
        await publishBoundaryState();
        boundaries.update.mockResolvedValue(twoTierPool(2));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={twoTierPool(1).pool.id} />);

        // The placement notice is the Machines section's description, above the tiers.
        expect(screen.findAll((node) => typeof node.children[0] === 'string'
            && String(node.children[0]).startsWith('Changes apply to sessions that start after you save')).length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('settings.machinePools.editor.member.machine-a.remove')).toHaveLength(0);
        await screen.pressByTestIdAsync('settings.machinePools.editor.member.machine-a');

        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        // The generic modal mock erases the displayed component's props type.
        const rootStep = config?.props?.rootStep as SelectionListStep | undefined;
        const options = (rootStep?.sections ?? []).flatMap((section) => section.kind === 'static' ? section.options : []);
        expect(options.map((option) => option.id)).toEqual(['tier:1', 'pause', 'remove']);
        expect(options[0]?.accessibilityLabel).toContain('Mac Studio');

        const onSelect = config?.props?.onSelect as ((optionId: string) => void) | undefined;
        await act(async () => onSelect?.('tier:1'));
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');

        await vi.waitFor(() => expect(boundaries.update).toHaveBeenCalledOnce());
        expect(boundaries.update.mock.calls[0]?.[1].members).toEqual([
            { machineId: 'machine-a', priorityTier: 0, enabled: true },
            { machineId: 'machine-b', priorityTier: 0, enabled: true },
        ]);
    });

    it('renumbers visible fallback tiers as soon as an edit empties an intermediate tier', async () => {
        boundaries.pools = [twoTierPool(1)];
        boundaries.machines = [
            createMachineFixture({ id: 'machine-a', metadata: machineMetadata('Mac Studio') }),
            createMachineFixture({ id: 'machine-b', metadata: machineMetadata('Linux box') }),
        ];
        await publishBoundaryState();
        boundaries.update.mockResolvedValue(twoTierPool(2));
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={twoTierPool(1).pool.id} />);

        // Add a third tier, then empty the middle one by moving its only member to the last tier.
        await screen.pressByTestIdAsync('settings.machinePools.editor.addFallback');
        await screen.pressByTestIdAsync('settings.machinePools.editor.member.machine-b');
        const onSelect = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props?.onSelect as ((optionId: string) => void) | undefined;
        await act(async () => onSelect?.('tier:2'));

        // Save must not be the first moment the user sees the collapsed structure: the member is
        // already presented in Fallback 1, and that is exactly what the aggregate persists.
        expect(screen.findByTestId('settings.machinePools.editor.member.machine-b')?.props.accessibilityLabel)
            .toContain('Fallback 1');
        // The collapsed structure equals the loaded one, so a real edit is what enables Save.
        await act(async () => screen.changeTextByTestId('settings.machinePools.editor.name', 'Development renamed'));
        await screen.pressByTestIdAsync('settings.machinePools.editor.save');

        await vi.waitFor(() => expect(boundaries.update).toHaveBeenCalledOnce());
        expect(boundaries.update.mock.calls[0]?.[1].members).toEqual([
            { machineId: 'machine-a', priorityTier: 0, enabled: true },
            { machineId: 'machine-b', priorityTier: 1, enabled: true },
        ]);
    });

    it('keeps a direct create route unavailable when the Home disables machine pools', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            features: { machines: { enabled: true, pools: { enabled: false } } },
            capabilities: {},
        })));
        boundaries.request.mockImplementation((url, init) => new URL(url).pathname === '/v1/features'
            ? Promise.resolve(Response.json({ features: { machines: { enabled: true, pools: { enabled: false } } }, capabilities: {} }))
            : actionResponse(url, init));
        resetServerFeaturesClientForTests();
        await getServerFeaturesSnapshot({ serverId: boundaries.serverId, force: true });
        boundaries.request.mockClear();
        const { MachinePoolEditorScreen } = await import('./MachinePoolEditorScreen');

        const screen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} />);

        expect(boundaries.request.mock.calls.some(([url]) => url.endsWith('/v1/machines/pools/list'))).toBe(false);
        expect(screen.findByTestId('settings.machinePools.editor.featureUnavailable')).not.toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.name')?.props.editable).toBe(false);
        expect(screen.findByTestId('settings.machinePools.editor.addMachines')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.machinePools.editor.addFallback')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);

        await screen.pressByTestIdAsync('settings.machinePools.editor.save');
        expect(boundaries.create).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('settings.machinePools.editor.featureUnavailable.back');
        expect(boundaries.back).not.toHaveBeenCalled();
        expect(boundaries.replace).toHaveBeenCalledWith('/settings/machines');

        await act(async () => screen.tree.unmount());
        const editScreen = await renderScreen(<MachinePoolEditorScreen serverId={boundaries.serverId} poolId={poolView(1).pool.id} />);
        expect(editScreen.findByTestId('settings.machinePools.editor.featureUnavailable')).not.toBeNull();
        expect(editScreen.findByTestId('settings.machinePools.editor.name')?.props.editable).toBe(false);
        expect(editScreen.findByTestId('settings.machinePools.editor.save')?.props.disabled).toBe(true);
        // Nothing can be deleted where the Home offers no pools: the page has no `⋯` menu.
        expect(editScreen.findByTestId('settings.machinePools.editor.menu.trigger')).toBeNull();
        expect(boundaries.remove).not.toHaveBeenCalled();
    });

    it('asks for an exact Home when the searchable create route has no Home parameter', async () => {
        boundaries.pools = [];
        await act(async () => publishBoundaryState());
        const { MachinePoolEditorRoute } = await import('./MachinePoolEditorScreen');

        const screen = await renderScreen(<MachinePoolEditorRoute params={{}} />);

        expect(screen.findByTestId(`settings.machinePools.home.${boundaries.serverId}`)).not.toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.name')).toBeNull();
        expect(boundaries.create).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync(`settings.machinePools.home.${boundaries.serverId}`);

        expect(boundaries.setParams).toHaveBeenCalledWith({ serverId: boundaries.serverId });
        expect(boundaries.create).not.toHaveBeenCalled();
    });

    it('retries exact-Home feature discovery from the chooser without navigating or mutating', async () => {
        resetServerFeaturesClientForTests();
        const featureFetch = vi.fn(async () => {
            throw new Error('network_unreachable');
        });
        setRuntimeFetch((url, init) => new URL(String(url)).pathname === '/v1/features'
            ? featureFetch()
            : boundaries.request(String(url), init));
        await getServerFeaturesSnapshot({ serverId: boundaries.serverId, force: true });
        const { MachinePoolEditorRoute } = await import('./MachinePoolEditorScreen');
        const screen = await renderScreen(<MachinePoolEditorRoute params={{}} />);

        const callsBeforeRetry = featureFetch.mock.calls.length;
        await vi.waitFor(() => {
            const homeRow = screen.findByTestId(`settings.machinePools.home.${boundaries.serverId}`);
            expect(homeRow?.props.accessibilityLabel).toContain('Retry');
            expect(typeof homeRow?.props.onPress).toBe('function');
        });

        await screen.pressByTestIdAsync(`settings.machinePools.home.${boundaries.serverId}`);

        await vi.waitFor(() => expect(featureFetch.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
        expect(boundaries.setParams).not.toHaveBeenCalled();
        expect(boundaries.create).not.toHaveBeenCalled();
    });

    it('fails an unknown explicit Home closed with a route recovery action', async () => {
        const { MachinePoolEditorRoute } = await import('./MachinePoolEditorScreen');

        const screen = await renderScreen(<MachinePoolEditorRoute params={{ serverId: 'unknown-home' }} />);

        expect(screen.findByTestId('settings.machinePools.routeUnavailable')).not.toBeNull();
        expect(screen.findByTestId('settings.machinePools.editor.name')).toBeNull();
        expect(boundaries.create).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings.machinePools.routeUnavailable.back');
        expect(boundaries.back).not.toHaveBeenCalled();
        expect(boundaries.replace).toHaveBeenCalledWith('/settings/machines');
    });
});
