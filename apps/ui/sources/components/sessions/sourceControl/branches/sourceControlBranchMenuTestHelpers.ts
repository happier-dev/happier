import * as React from 'react';
import { act } from 'react-test-renderer';
import { vi } from 'vitest';
import { flushHookEffects } from '@/dev/testkit';

type SourceControlBranchMenuModuleFactory = () => unknown | Promise<unknown>;
type SourceControlBranchMenuImportOriginal = <T = unknown>() => Promise<T>;
type SourceControlBranchMenuStorageModuleFactory = (
    importOriginal: SourceControlBranchMenuImportOriginal,
) => unknown | Promise<unknown>;

type InstallSourceControlBranchMenuCommonModuleMocksOptions = Readonly<{
    modal?: SourceControlBranchMenuModuleFactory;
    reactNative?: SourceControlBranchMenuModuleFactory;
    router?: SourceControlBranchMenuModuleFactory;
    storage?: SourceControlBranchMenuStorageModuleFactory;
    text?: SourceControlBranchMenuModuleFactory;
    unistyles?: SourceControlBranchMenuModuleFactory;
}>;

const sourceControlBranchMenuModuleState = vi.hoisted(() => ({
    createWorktreeForMachinePathMock: vi.fn(),
    fetchBranchesForSessionMock: vi.fn(),
    invalidateBranchesForSessionMock: vi.fn(),
    modalAlertSpy: vi.fn(),
    modalConfirmSpy: vi.fn(async () => false),
    modalShowSpy: vi.fn(),
    pruneWorktreesForMachinePathMock: vi.fn(),
    publishBranchMock: vi.fn(async () => true),
    readCachedBranchesForSessionMock: vi.fn(),
    readMachineTargetForSessionMock: vi.fn(),
    preferredServerIdForSession: null as string | null,
    removeWorktreeForMachinePathMock: vi.fn(),
    routerPushSpy: vi.fn(),
    sessionScmBranchCheckoutMock: vi.fn(),
    sessionScmBranchCreateMock: vi.fn(),
    sessionScmRepositoryRemoveIndexLockMock: vi.fn(),
    sessionScmRemotePublishMock: vi.fn(),
    usePublishBranchActionMock: vi.fn(),
    useSettingMock: vi.fn(),
    options: {
        modal: undefined as SourceControlBranchMenuModuleFactory | undefined,
        reactNative: undefined as SourceControlBranchMenuModuleFactory | undefined,
        router: undefined as SourceControlBranchMenuModuleFactory | undefined,
        storage: undefined as SourceControlBranchMenuStorageModuleFactory | undefined,
        text: undefined as SourceControlBranchMenuModuleFactory | undefined,
        unistyles: undefined as SourceControlBranchMenuModuleFactory | undefined,
    },
}));

export function resetSourceControlBranchMenuCommonModuleMockState() {
    sourceControlBranchMenuModuleState.createWorktreeForMachinePathMock.mockReset();
    sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockReset();
    sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockResolvedValue([]);
    sourceControlBranchMenuModuleState.invalidateBranchesForSessionMock.mockReset();
    sourceControlBranchMenuModuleState.modalAlertSpy.mockReset();
    sourceControlBranchMenuModuleState.modalConfirmSpy.mockReset();
    sourceControlBranchMenuModuleState.modalConfirmSpy.mockResolvedValue(false);
    sourceControlBranchMenuModuleState.modalShowSpy.mockReset();
    sourceControlBranchMenuModuleState.pruneWorktreesForMachinePathMock.mockReset();
    sourceControlBranchMenuModuleState.publishBranchMock.mockReset();
    sourceControlBranchMenuModuleState.publishBranchMock.mockResolvedValue(true);
    sourceControlBranchMenuModuleState.readCachedBranchesForSessionMock.mockReset();
    sourceControlBranchMenuModuleState.readCachedBranchesForSessionMock.mockReturnValue([]);
    sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReset();
    sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue(null);
    sourceControlBranchMenuModuleState.preferredServerIdForSession = null;
    sourceControlBranchMenuModuleState.removeWorktreeForMachinePathMock.mockReset();
    sourceControlBranchMenuModuleState.routerPushSpy.mockReset();
    sourceControlBranchMenuModuleState.sessionScmBranchCheckoutMock.mockReset();
    sourceControlBranchMenuModuleState.sessionScmBranchCreateMock.mockReset();
    sourceControlBranchMenuModuleState.sessionScmRepositoryRemoveIndexLockMock.mockReset();
    sourceControlBranchMenuModuleState.sessionScmRepositoryRemoveIndexLockMock.mockResolvedValue({
        success: true,
        removed: true,
        lockPath: '/repo/.git/index.lock',
    });
    sourceControlBranchMenuModuleState.sessionScmRemotePublishMock.mockReset();
    sourceControlBranchMenuModuleState.usePublishBranchActionMock.mockReset();
    sourceControlBranchMenuModuleState.usePublishBranchActionMock.mockImplementation(({ writeEnabled, disabled, snapshot }: any) => ({
        canPublish:
            writeEnabled !== false
            && disabled !== true
            && snapshot?.capabilities?.writeRemotePublish === true
            && snapshot?.branch?.upstream == null,
        publishBusy: false,
        publishBranch: sourceControlBranchMenuModuleState.publishBranchMock,
    }));
    sourceControlBranchMenuModuleState.useSettingMock.mockReset();
    sourceControlBranchMenuModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installSourceControlBranchMenuCommonModuleMocks(
    options: InstallSourceControlBranchMenuCommonModuleMocksOptions = {},
) {
    sourceControlBranchMenuModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sourceControlBranchMenuModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', () => ({
        Octicons: 'Octicons',
    }));

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sourceControlBranchMenuModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
        DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
    }));

    vi.mock('@/components/ui/popover', () => ({
        Popover: (props: Record<string, any>) => React.createElement(
            'Popover',
            props,
            props.open && typeof props.children === 'function' ? props.children({}) : null,
        ),
    }));

    vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
        SegmentedTabBar: (props: Record<string, unknown>) => React.createElement('SegmentedTabBar', props),
    }));

    vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
        SelectableMenuResults: (props: Record<string, unknown>) => React.createElement('SelectableMenuResults', props),
    }));

    vi.mock('@/components/ui/text/Text', () => ({
        Text: 'Text',
        TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    }));

    vi.mock('@/constants/Typography', () => ({
        Typography: {
            default: () => ({}),
            mono: () => ({}),
        },
    }));

    vi.mock('@/text', async () => {
        const activeOptions = sourceControlBranchMenuModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sourceControlBranchMenuModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: sourceControlBranchMenuModuleState.modalAlertSpy,
                confirm: sourceControlBranchMenuModuleState.modalConfirmSpy,
                show: sourceControlBranchMenuModuleState.modalShowSpy,
            },
        }).module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sourceControlBranchMenuModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: sourceControlBranchMenuModuleState.routerPushSpy,
            },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sourceControlBranchMenuModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => sourceControlBranchMenuModuleState.useSettingMock(key),
        });
    });

    vi.mock('@/sync/ops', () => ({
        sessionScmBranchCheckout: sourceControlBranchMenuModuleState.sessionScmBranchCheckoutMock,
        sessionScmRemotePublish: sourceControlBranchMenuModuleState.sessionScmRemotePublishMock,
        sessionScmBranchCreate: sourceControlBranchMenuModuleState.sessionScmBranchCreateMock,
        sessionScmRepositoryRemoveIndexLock: sourceControlBranchMenuModuleState.sessionScmRepositoryRemoveIndexLockMock,
    }));

    vi.mock('@/scm/repository/repoScmBranchService', () => ({
        repoScmBranchService: {
            fetchBranchesForSession: (input: unknown) =>
                sourceControlBranchMenuModuleState.fetchBranchesForSessionMock(input),
            readCachedBranchesForSession: (input: unknown) =>
                sourceControlBranchMenuModuleState.readCachedBranchesForSessionMock(input),
            invalidateBranchesForSession: (input: unknown) =>
                sourceControlBranchMenuModuleState.invalidateBranchesForSessionMock(input),
        },
    }));

    vi.mock('@/sync/ops/sessionMachineTarget', () => ({
        readMachineTargetForSession: (sessionId: string) =>
            sourceControlBranchMenuModuleState.readMachineTargetForSessionMock(sessionId),
    }));

    vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
        usePreferredServerIdForSession: () => sourceControlBranchMenuModuleState.preferredServerIdForSession,
    }));

    vi.mock('@/scm/scmStatusSync', () => ({
        scmStatusSync: {
            invalidateFromMutationAndAwait: vi.fn(async () => {}),
        },
    }));

    vi.mock('@/hooks/session/sourceControl/usePublishBranchAction', () => ({
        usePublishBranchAction: (...args: any[]) =>
            sourceControlBranchMenuModuleState.usePublishBranchActionMock(...args),
    }));

    vi.mock('@/scm/repository/repoScmWorktreeService', () => ({
        repoScmWorktreeService: {
            createWorktreeForMachinePath: (input: unknown) =>
                sourceControlBranchMenuModuleState.createWorktreeForMachinePathMock(input),
            removeWorktreeForMachinePath: (input: unknown) =>
                sourceControlBranchMenuModuleState.removeWorktreeForMachinePathMock(input),
            pruneWorktreesForMachinePath: (input: unknown) =>
                sourceControlBranchMenuModuleState.pruneWorktreesForMachinePathMock(input),
        },
    }));
}

export async function openSourceControlBranchMenu(screen: {
    findByType: (type: unknown) => { props: { onOpenChange?: (open: boolean) => unknown } };
    findByProps: (props: Record<string, unknown>) => { props: { onPress?: () => unknown } };
}) {
    try {
        const trigger = screen.findByProps({ testID: 'scm-branch-menu-trigger' });
        await act(async () => {
            await trigger.props.onPress?.();
        });
    } catch {
        const menu = screen.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onOpenChange?.(true);
        });
    }
    await flushHookEffects({ cycles: 1 });
}

export function listSourceControlBranchMenuItemIds(screen: {
    findByType: (type: unknown) => { props: { categories?: ReadonlyArray<{ items: ReadonlyArray<{ id: string }> }> } };
}): string[] {
    const results = screen.findByType('SelectableMenuResults' as any);
    return (results.props.categories ?? []).flatMap((category: { items: ReadonlyArray<{ id: string }> }) =>
        category.items.map((item) => item.id),
    );
}

export async function selectSourceControlBranchMenuItem(
    screen: {
        findByType: (type: unknown) => { props: { categories?: ReadonlyArray<{ items: ReadonlyArray<{ id: string }> }>; onPressItem?: (item: { id: string }) => unknown } };
    },
    itemId: string,
) {
    const results = screen.findByType('SelectableMenuResults' as any);
    const item = (results.props.categories ?? [])
        .flatMap((category: { items: ReadonlyArray<{ id: string }> }) => category.items)
        .find((candidate: { id: string }) => candidate.id === itemId);
    if (!item) {
        throw new Error(`Branch menu item not found: ${itemId}`);
    }
    await act(async () => {
        await results.props.onPressItem?.(item);
    });
    await flushHookEffects({ cycles: 1 });
}

export { sourceControlBranchMenuModuleState };
