import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import {
    buildSessionListRenderableFromSession,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import { buildSessionListViewData, type SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import { settingsDefaults } from '../../domains/settings/settings';
import type { Machine, Session } from '../../domains/state/storageTypes';
import { setActiveServerId, upsertServerProfile } from '../../domains/server/serverProfiles';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

import { createSettingsDomain, type SettingsDomain } from './settings';

type TestState = SettingsDomain & {
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    getProjectForSession: (sessionId: string) => { key?: { machineId?: string | null; path?: string | null } | null } | null;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
    machineListByServerId: Record<string, Machine[] | null>;
};

function createMachine(input: Readonly<{
    id: string;
    displayName: string;
    host: string;
    homeDir: string;
}>): Machine {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 3,
        metadata: {
            displayName: input.displayName,
            host: input.host,
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: `${input.homeDir}/.happy`,
            homeDir: input.homeDir,
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    host: string;
    path: string;
    homeDir: string;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: false,
        activeAt: 5,
        archivedAt: null,
        metadata: {
            machineId: input.machineId,
            host: input.host,
            path: input.path,
            homeDir: input.homeDir,
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 5,
    };
}

function createState() {
    const staleMachine = createMachine({
        id: 'machine-stale',
        displayName: 'Personal Mac',
        host: 'personal.local',
        homeDir: '/Users/tester',
    });
    const reachableMachine = createMachine({
        id: 'machine-reachable',
        displayName: 'Work Mac',
        host: 'work.local',
        homeDir: '/Users/tester',
    });
    const session = createSession({
        id: 'session-1',
        machineId: 'machine-stale',
        host: 'personal.local',
        path: '/Users/tester/personal/repo',
        homeDir: '/Users/tester',
    });

    return {
        sessions: { [session.id]: session },
        sessionListRenderables: {
            [session.id]: buildSessionListRenderableFromSession(session),
        },
        machines: {
            [staleMachine.id]: staleMachine,
            [reachableMachine.id]: reachableMachine,
        },
        machineDisplayById: {
            [staleMachine.id]: buildMachineDisplayRenderableFromMachine(staleMachine),
            [reachableMachine.id]: buildMachineDisplayRenderableFromMachine(reachableMachine),
        },
        getProjectForSession: (sessionId: string) => sessionId === session.id
            ? {
                key: {
                    machineId: 'machine-reachable',
                    path: '/Users/tester/work/repo',
                },
            }
            : null,
        settings: {
            ...settingsDefaults,
            groupInactiveSessionsByProject: false,
            sessionListActiveGroupingV1: 'date' as const,
            sessionListInactiveGroupingV1: 'date' as const,
        },
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
    };
}

function createHarness(overrides: Partial<TestState> = {}) {
    let state = createState() as TestState;
    const get = () => state;
    const set = (updater: ((value: TestState) => Partial<TestState> | TestState) | Partial<TestState>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSettingsDomain<TestState>({ set, get });
    state = { ...state, ...domain, machineListByServerId: {}, ...overrides };
    return { get };
}

describe('settings domain: sessionListViewData rebuilds', () => {
    let activeServerId: string;
    beforeEach(() => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `settings-list-rebuild-${Math.random()}`);
        const home = upsertServerProfile({ serverUrl: 'https://settings-server.example.test', name: 'Server A' });
        activeServerId = home.id;
        setActiveServerId(home.id, { scope: 'device' });
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(['local', 'synced'] as const)('regroups active and cached server lists when the worktree preference changes (%s)', (source) => {
        const machine = createMachine({ id: 'machine-1', displayName: 'Work Mac', host: 'work.local', homeDir: '/Users/tester' });
        const sessions = Object.fromEntries(['/Users/tester/repo', '/Users/tester/worktrees/feature'].map((path, index) => {
            const session = createSession({ id: `worktree-${index}`, machineId: machine.id, host: 'work.local', path, homeDir: '/Users/tester' });
            const enriched = {
                ...session,
                metadata: {
                    ...session.metadata,
                    path,
                    host: 'work.local',
                    sessionRepositoryV1: { v: 1 as const, machineId: machine.id, rootPath: '/Users/tester/repo', worktreePath: path },
                },
            };
            return [enriched.id, enriched];
        }));
        const renderables = Object.fromEntries(Object.values(sessions).map((session) => [session.id, buildSessionListRenderableFromSession(session)]));
        const remote = upsertServerProfile({ serverUrl: 'https://cached-worktrees.example.test', name: 'Cached server' });
        const initialSettings = { ...settingsDefaults, sessionListInactiveGroupingV1: 'project' as const, sessionListGroupGitWorktreesV1: false };
        const cachedRows = buildSessionListViewData(renderables, { [machine.id]: machine }, {
            groupInactiveSessionsByProject: true,
            inactiveGroupingV1: 'project',
            groupGitWorktreesByRepository: false,
            serverScope: { serverId: remote.id, serverName: 'Cached server' },
        });
        const { get } = createHarness({
            sessions, sessionListRenderables: renderables,
            machines: { [machine.id]: machine },
            machineDisplayById: { [machine.id]: buildMachineDisplayRenderableFromMachine(machine) },
            getProjectForSession: () => null,
            settings: initialSettings,
            sessionListViewData: cachedRows,
            sessionListViewDataByServerId: { [remote.id]: cachedRows },
            machineListByServerId: { [remote.id]: [machine] },
        });
        const projectHeaders = (rows: SessionListViewItem[] | null | undefined) => rows?.filter((row) => row.type === 'header' && row.headerKind === 'project');
        expect(projectHeaders(cachedRows)).toHaveLength(2);

        if (source === 'local') get().applySettingsLocal({ sessionListGroupGitWorktreesV1: true });
        else get().applySettings({ ...initialSettings, sessionListGroupGitWorktreesV1: true }, 1);

        expect(projectHeaders(get().sessionListViewData)).toHaveLength(1);
        expect(projectHeaders(get().sessionListViewDataByServerId[remote.id])).toHaveLength(1);
        expect(get().sessionListViewData?.filter((row) => row.type === 'session')).toHaveLength(2);
        expect(projectHeaders(get().sessionListViewDataByServerId[remote.id])?.[0]).toMatchObject({ serverId: remote.id, serverName: 'Cached server' });

        get().applySettingsLocal({ sessionListGroupGitWorktreesV1: false });
        expect(projectHeaders(get().sessionListViewData)).toHaveLength(2);
        expect(projectHeaders(get().sessionListViewDataByServerId[remote.id])).toHaveLength(2);
    });

    it('rebuilds sessionListViewData when grouping settings change', () => {
        const { get } = createHarness();

        get().applySettingsLocal({
            groupInactiveSessionsByProject: true,
            sessionListInactiveGroupingV1: 'project',
            workspacePathDisplayModeV1: 'path',
        });

        const projectHeader = get().sessionListViewData?.find((item) => item.type === 'header' && item.headerKind === 'project');
        const projectedSessionRow = get().sessionListViewData?.find((item) => item.type === 'session');
        expect(projectHeader).toMatchObject({
            type: 'header',
            title: '~/personal/repo',
            serverId: activeServerId,
            serverName: 'Server A',
        });
        expect(projectedSessionRow).toMatchObject({
            type: 'session',
            session: {
                id: 'session-1',
                metadata: expect.objectContaining({
                    path: '/Users/tester/personal/repo',
                }),
            },
        });
    });

    it('rebuilds sessionListViewData when the attention placement setting changes', () => {
        const { get } = createHarness();

        get().applySettingsLocal({
            groupInactiveSessionsByProject: true,
            sessionListInactiveGroupingV1: 'project',
        });
        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        get().applySettingsLocal({
            sessionListAttentionPromotionModeV1: 'withinGroups',
        });

        expect(get().sessionListViewData).not.toBe(initial);
    });

    it('invalidates session list projections when background unread placement changes', () => {
        const { get } = createHarness();
        get().applySettingsLocal({ sessionListInactiveGroupingV1: 'project' });
        const previous = get().sessionListViewData;
        get().applySettingsLocal({ sessionListBackgroundWorkAttentionModeV1: 'showUnread' });
        expect(get().settings.sessionListBackgroundWorkAttentionModeV1).toBe('showUnread');
        expect(get().sessionListViewData).not.toBe(previous);
    });

    it('rebuilds sessionListViewData when the working placement setting changes', () => {
        const { get } = createHarness();

        get().applySettingsLocal({
            groupInactiveSessionsByProject: true,
            sessionListInactiveGroupingV1: 'project',
        });
        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        get().applySettingsLocal({
            sessionListWorkingPlacementModeV1: 'global',
        } as any);

        expect(get().sessionListViewData).not.toBe(initial);
    });
});
