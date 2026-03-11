import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
    useRouter,
    useActiveServerWorkspaces,
    useSession,
    useProjectForSession,
    useWorkspace,
    useWorkspaceLocation,
    useWorkspaceCheckout,
    useWorkspaceCheckouts,
    useMachine,
    readSessionWorkspaceContext,
    getMachineDisplayName,
    formatPathRelativeToHome,
    saveWorkspace,
    saveWorkspaceLocation,
    saveWorkspaceCheckout,
    saveNewSessionDraft,
} = vi.hoisted(() => ({
    useRouter: vi.fn(),
    useActiveServerWorkspaces: vi.fn(),
    useSession: vi.fn(),
    useProjectForSession: vi.fn(),
    useWorkspace: vi.fn(),
    useWorkspaceLocation: vi.fn(),
    useWorkspaceCheckout: vi.fn(),
    useWorkspaceCheckouts: vi.fn(),
    useMachine: vi.fn(),
    readSessionWorkspaceContext: vi.fn(),
    getMachineDisplayName: vi.fn(),
    formatPathRelativeToHome: vi.fn(),
    saveWorkspace: vi.fn(),
    saveWorkspaceLocation: vi.fn(),
    saveWorkspaceCheckout: vi.fn(),
    saveNewSessionDraft: vi.fn(),
}));

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    AppState: {
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: {
                    blue: '#00f',
                    green: '#0f0',
                    indigo: '#44f',
                    purple: '#a0f',
                    orange: '#f80',
                },
            },
        },
    }),
    StyleSheet: {
        create: (value: any) => value,
        absoluteFillObject: {},
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('expo-router', () => ({
    useRouter,
}));

vi.mock('@/hooks/server/useActiveServerWorkspaces', () => ({
    useActiveServerWorkspaces,
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSession,
        useProjectForSession,
        useWorkspace,
        useWorkspaceLocation,
        useWorkspaceCheckout,
        useWorkspaceCheckouts,
        useMachine,
    };
});

vi.mock('@/sync/domains/session/readSessionWorkspaceContext', () => ({
    readSessionWorkspaceContext,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    getMachineDisplayName,
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    formatPathRelativeToHome,
}));

vi.mock('@/sync/ops/workspaces', () => ({
    saveWorkspace,
    saveWorkspaceLocation,
    saveWorkspaceCheckout,
}));

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/persistence')>();
    return {
        ...actual,
        saveNewSessionDraft,
    };
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

beforeEach(() => {
    vi.clearAllMocks();
    useRouter.mockReturnValue({ push: vi.fn() });
    useActiveServerWorkspaces.mockReturnValue({
        serverId: 'server-a',
        workspaces: [],
        status: 'ready',
        refresh: vi.fn(),
    });
    useSession.mockReturnValue({ id: 'session-a', metadata: { machineId: 'machine-a', path: '/repo', homeDir: '/Users/alex' } });
    useProjectForSession.mockReturnValue({ key: { machineId: 'machine-a', path: '/repo' } });
    useWorkspace.mockReturnValue(null);
    useWorkspaceLocation.mockReturnValue(null);
    useWorkspaceCheckout.mockReturnValue(null);
    useWorkspaceCheckouts.mockReturnValue([]);
    useMachine.mockReturnValue({ id: 'machine-a', metadata: { displayName: 'MacBook Pro' } });
    readSessionWorkspaceContext.mockReturnValue({
        workspacePath: '/repo',
        projectPath: '/repo',
        projectMachineId: 'machine-a',
        workspaceId: null,
        workspaceLocationId: null,
        workspaceCheckoutId: null,
    });
    getMachineDisplayName.mockReturnValue('MacBook Pro');
    formatPathRelativeToHome.mockReturnValue('~/repo');
});

describe('SourceControlWorkspaceRailSection', () => {
    it('renders linked workspace, current checkout, and sibling checkouts for a linked session', async () => {
        readSessionWorkspaceContext.mockReturnValue({
            workspacePath: '/repo/.worktrees/feature-auth',
            projectPath: '/repo',
            projectMachineId: 'machine-a',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        });
        useWorkspace.mockReturnValue({
            id: 'ws_payments',
            displayName: 'Payments API',
        });
        useWorkspaceLocation.mockReturnValue({
            id: 'loc_local',
            machineId: 'machine-a',
            path: '/repo/.worktrees/feature-auth',
        });
        useWorkspaceCheckout.mockReturnValue({
            id: 'checkout_feature_auth',
            displayName: 'feature/auth',
            kind: 'git_worktree',
            status: 'ready',
            syncPolicy: 'inherit',
            scm: { git: { branch: 'feature/auth' } },
        });
        useWorkspaceCheckouts.mockReturnValue([
            {
                id: 'checkout_feature_auth',
                displayName: 'feature/auth',
                kind: 'git_worktree',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: { git: { branch: 'feature/auth' } },
            },
            {
                id: 'checkout_main',
                displayName: 'main',
                kind: 'primary',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: { git: { branch: 'main' } },
            },
        ]);
        formatPathRelativeToHome.mockReturnValue('~/repo/.worktrees/feature-auth');

        const { SourceControlWorkspaceRailSection } = await import('./SourceControlWorkspaceRailSection');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlWorkspaceRailSection
                    sessionId="session-a"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo/.worktrees/feature-auth', backendId: 'git', mode: '.git' },
                    } as any}
                />,
            );
        });

        expect(tree.root.findByProps({ testID: 'source-control-workspace-rail-workspace' }).props.subtitle).toBe('Payments API');
        expect(tree.root.findByProps({ testID: 'source-control-workspace-rail-current-checkout' }).props.subtitle).toBe('feature/auth');
        expect(tree.root.findByProps({ testID: 'source-control-workspace-rail-sibling-checkout-checkout_main' }).props.subtitle).toBe('main');
    });

    it('can start a new session from the current linked checkout row', async () => {
        const push = vi.fn();
        useRouter.mockReturnValue({ push });
        readSessionWorkspaceContext.mockReturnValue({
            workspacePath: '/repo/.worktrees/feature-auth',
            projectPath: '/repo',
            projectMachineId: 'machine-a',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        });
        useWorkspace.mockReturnValue({
            id: 'ws_payments',
            displayName: 'Payments API',
        });
        useWorkspaceLocation.mockReturnValue({
            id: 'loc_local',
            machineId: 'machine-a',
            path: '/repo/.worktrees/feature-auth',
        });
        useWorkspaceCheckout.mockReturnValue({
            id: 'checkout_feature_auth',
            displayName: 'feature/auth',
            kind: 'git_worktree',
            status: 'ready',
            syncPolicy: 'inherit',
            path: '/repo/.worktrees/feature-auth',
            scm: { git: { branch: 'feature/auth' } },
        });
        useWorkspaceCheckouts.mockReturnValue([
            {
                id: 'checkout_feature_auth',
                displayName: 'feature/auth',
                kind: 'git_worktree',
                status: 'ready',
                syncPolicy: 'inherit',
                path: '/repo/.worktrees/feature-auth',
                scm: { git: { branch: 'feature/auth' } },
            },
        ]);

        const { SourceControlWorkspaceRailSection } = await import('./SourceControlWorkspaceRailSection');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlWorkspaceRailSection
                    sessionId="session-a"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo/.worktrees/feature-auth', backendId: 'git', mode: '.git' },
                    } as any}
                />,
            );
        });

        const currentItem = tree.root.findByProps({ testID: 'source-control-workspace-rail-current-checkout' });
        await act(async () => {
            await currentItem.props.onPress();
        });

        expect(saveNewSessionDraft).toHaveBeenCalledWith({
            input: '',
            selectedMachineId: 'machine-a',
            selectedPath: '/repo/.worktrees/feature-auth',
            selectedProfileId: null,
            selectedSecretId: null,
            agentType: DEFAULT_AGENT_ID,
            permissionMode: 'default',
            modelMode: 'default',
            acpSessionModeId: null,
            updatedAt: expect.any(Number),
        });
        expect(push).toHaveBeenCalledWith('/new');
    });

    it('can start a new session directly from a linked sibling checkout', async () => {
        const push = vi.fn();
        useRouter.mockReturnValue({ push });
        readSessionWorkspaceContext.mockReturnValue({
            workspacePath: '/repo/.worktrees/feature-auth',
            projectPath: '/repo',
            projectMachineId: 'machine-a',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        });
        useWorkspace.mockReturnValue({
            id: 'ws_payments',
            displayName: 'Payments API',
        });
        useWorkspaceLocation.mockReturnValue({
            id: 'loc_local',
            machineId: 'machine-a',
            path: '/repo/.worktrees/feature-auth',
        });
        useWorkspaceCheckout.mockReturnValue({
            id: 'checkout_feature_auth',
            displayName: 'feature/auth',
            kind: 'git_worktree',
            status: 'ready',
            syncPolicy: 'inherit',
            path: '/repo/.worktrees/feature-auth',
            scm: { git: { branch: 'feature/auth' } },
        });
        useWorkspaceCheckouts.mockReturnValue([
            {
                id: 'checkout_feature_auth',
                displayName: 'feature/auth',
                kind: 'git_worktree',
                status: 'ready',
                syncPolicy: 'inherit',
                path: '/repo/.worktrees/feature-auth',
                scm: { git: { branch: 'feature/auth' } },
            },
            {
                id: 'checkout_main',
                displayName: 'main',
                kind: 'primary',
                status: 'ready',
                syncPolicy: 'inherit',
                path: '/repo',
                scm: { git: { branch: 'main' } },
            },
        ]);

        const { SourceControlWorkspaceRailSection } = await import('./SourceControlWorkspaceRailSection');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlWorkspaceRailSection
                    sessionId="session-a"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo/.worktrees/feature-auth', backendId: 'git', mode: '.git' },
                    } as any}
                />,
            );
        });

        const siblingItem = tree.root.findByProps({ testID: 'source-control-workspace-rail-sibling-checkout-checkout_main' });
        await act(async () => {
            await siblingItem.props.onPress();
        });

        expect(saveNewSessionDraft).toHaveBeenCalledWith({
            input: '',
            selectedMachineId: 'machine-a',
            selectedPath: '/repo',
            selectedProfileId: null,
            selectedSecretId: null,
            agentType: DEFAULT_AGENT_ID,
            permissionMode: 'default',
            modelMode: 'default',
            acpSessionModeId: null,
            updatedAt: expect.any(Number),
        });
        expect(push).toHaveBeenCalledWith('/new');
    });

    it('creates and opens a linked workspace from the current checkout when the repo is unlinked', async () => {
        const push = vi.fn();
        useRouter.mockReturnValue({ push });
        saveWorkspace.mockResolvedValue({
            workspace: {
                id: 'ws_created',
            },
        });
        saveWorkspaceLocation.mockResolvedValue({
            workspace: { id: 'ws_created' },
            location: { id: 'loc_created' },
            primaryCheckout: { id: 'checkout_primary' },
        });

        const { SourceControlWorkspaceRailSection } = await import('./SourceControlWorkspaceRailSection');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlWorkspaceRailSection
                    sessionId="session-a"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                    } as any}
                />,
            );
        });

        const createItem = tree.root.findByProps({ testID: 'source-control-workspace-rail-create-workspace' });
        await act(async () => {
            await createItem.props.onPress();
        });

        expect(saveWorkspace).toHaveBeenCalledWith(
            { displayName: 'repo' },
            { serverId: 'server-a' },
        );
        expect(saveWorkspaceLocation).toHaveBeenCalledWith(
            {
                workspaceId: 'ws_created',
                machineId: 'machine-a',
                path: '/repo',
            },
            { serverId: 'server-a' },
        );
        expect(push).toHaveBeenCalledWith('/(app)/settings/workspaces/ws_created');
    });

    it('shows unlinked discovered worktrees and can adopt them into the current workspace', async () => {
        readSessionWorkspaceContext.mockReturnValue({
            workspacePath: '/repo/.worktrees/feature-auth',
            projectPath: '/repo',
            projectMachineId: 'machine-a',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        });
        useWorkspace.mockReturnValue({
            id: 'ws_payments',
            displayName: 'Payments API',
        });
        useWorkspaceLocation.mockReturnValue({
            id: 'loc_local',
            machineId: 'machine-a',
            path: '/repo/.worktrees/feature-auth',
        });
        useWorkspaceCheckout.mockReturnValue({
            id: 'checkout_feature_auth',
            displayName: 'feature/auth',
            kind: 'git_worktree',
            status: 'ready',
            syncPolicy: 'inherit',
            scm: { git: { branch: 'feature/auth' } },
        });
        useWorkspaceCheckouts.mockReturnValue([
            {
                id: 'checkout_feature_auth',
                displayName: 'feature/auth',
                kind: 'git_worktree',
                status: 'ready',
                syncPolicy: 'inherit',
                path: '/repo/.worktrees/feature-auth',
                scm: { git: { branch: 'feature/auth' } },
            },
            {
                id: 'checkout_main',
                displayName: 'main',
                kind: 'primary',
                status: 'ready',
                syncPolicy: 'inherit',
                path: '/repo',
                scm: { git: { branch: 'main' } },
            },
        ]);
        saveWorkspaceCheckout.mockResolvedValue({
            checkout: {
                id: 'checkout_bugfix',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'git_worktree',
                path: '/repo/.worktrees/bugfix',
                displayName: 'bugfix',
                status: 'ready',
                syncPolicy: 'manual_only',
            },
        });

        const { SourceControlWorkspaceRailSection } = await import('./SourceControlWorkspaceRailSection');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlWorkspaceRailSection
                    sessionId="session-a"
                    scmSnapshot={{
                        repo: {
                            isRepo: true,
                            rootPath: '/repo/.worktrees/feature-auth',
                            backendId: 'git',
                            mode: '.git',
                            worktrees: [
                                { path: '/repo', branch: 'main', isCurrent: false },
                                { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: true },
                                { path: '/repo/.worktrees/bugfix', branch: 'bugfix', isCurrent: false },
                            ],
                        },
                    } as any}
                />,
            );
        });

        const adoptItem = tree.root.findByProps({ testID: 'source-control-workspace-rail-adopt-worktree-/repo/.worktrees/bugfix' });
        expect(adoptItem.props.subtitle).toBe('bugfix');
        expect(adoptItem.props.detail).toBe('~/repo');

        await act(async () => {
            await adoptItem.props.onPress();
        });

        expect(saveWorkspaceCheckout).toHaveBeenCalledWith(
            {
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'git_worktree',
                path: '/repo/.worktrees/bugfix',
                displayName: 'bugfix',
            },
            { serverId: 'server-a' },
        );
    });

    it('can start a new session directly from an unlinked discovered worktree', async () => {
        const push = vi.fn();
        useRouter.mockReturnValue({ push });
        readSessionWorkspaceContext.mockReturnValue({
            workspacePath: '/repo/.worktrees/feature-auth',
            projectPath: '/repo',
            projectMachineId: 'machine-a',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        });
        useWorkspace.mockReturnValue({
            id: 'ws_payments',
            displayName: 'Payments API',
        });
        useWorkspaceLocation.mockReturnValue({
            id: 'loc_local',
            machineId: 'machine-a',
            path: '/repo/.worktrees/feature-auth',
        });
        useWorkspaceCheckout.mockReturnValue({
            id: 'checkout_feature_auth',
            displayName: 'feature/auth',
            kind: 'git_worktree',
            status: 'ready',
            syncPolicy: 'inherit',
            scm: { git: { branch: 'feature/auth' } },
        });
        useWorkspaceCheckouts.mockReturnValue([
            {
                id: 'checkout_feature_auth',
                displayName: 'feature/auth',
                kind: 'git_worktree',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: { git: { branch: 'feature/auth' } },
            },
        ]);

        const { SourceControlWorkspaceRailSection } = await import('./SourceControlWorkspaceRailSection');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlWorkspaceRailSection
                    sessionId="session-a"
                    scmSnapshot={{
                        repo: {
                            isRepo: true,
                            rootPath: '/repo/.worktrees/feature-auth',
                            backendId: 'git',
                            mode: '.git',
                            worktrees: [
                                { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: true },
                                { path: '/repo/.worktrees/bugfix', branch: 'bugfix', isCurrent: false },
                            ],
                        },
                    } as any}
                />,
            );
        });

        const createItem = tree.root.findByProps({
            testID: 'source-control-workspace-rail-create-session-worktree-/repo/.worktrees/bugfix',
        });
        await act(async () => {
            await createItem.props.onPress();
        });

        expect(saveNewSessionDraft).toHaveBeenCalledWith({
            input: '',
            selectedMachineId: 'machine-a',
            selectedPath: '/repo/.worktrees/bugfix',
            selectedProfileId: null,
            selectedSecretId: null,
            agentType: DEFAULT_AGENT_ID,
            permissionMode: 'default',
            modelMode: 'default',
            acpSessionModeId: null,
            updatedAt: expect.any(Number),
        });
        expect(push).toHaveBeenCalledWith('/new');
    });
});
