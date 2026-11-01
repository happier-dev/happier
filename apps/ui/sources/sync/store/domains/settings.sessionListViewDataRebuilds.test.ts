import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import {
    buildSessionListRenderableFromSession,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
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

function createHarness() {
    let state = createState() as TestState;
    const get = () => state;
    const set = (updater: ((value: TestState) => Partial<TestState> | TestState) | Partial<TestState>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSettingsDomain<TestState>({ set, get });
    state = { ...state, ...domain };
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
