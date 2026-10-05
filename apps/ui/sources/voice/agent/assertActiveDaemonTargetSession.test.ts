import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceAgentCommonModuleMocks } from '@/voice/agent/voiceAgentTestHelpers';

/**
 * `surface.terminal` has no static per-Agent declaration: {@link supportsAgentLifecycleCapability}
 * answers it from a published `agentRuntimeCapabilitiesV1.localControl` bit, otherwise from the
 * Agent capabilities projected by the target machine's daemon. These cases therefore supply a real
 * V2 projection and never a fabricated `localControl` bit, so a guard that ignored the projection
 * could not pass them.
 *
 * The projection is Home- AND machine-scoped, exactly as the live consumer scopes it
 * (`SessionView` passes the Session's route Home, not the focused one), so the focused Home below
 * is deliberately a different Home than the target's.
 */
const TARGET_HOME = 'home-target';
const FOCUSED_HOME = 'home-focused';

const projectionRequests: Array<{ machineId: string; serverId: string | null }> = [];
const describeProjection = vi.fn(async (_machineId: string, _options?: unknown): Promise<unknown> => ({
    supported: false,
    reason: 'not-supported',
}));

const state: any = {
    sessions: {},
    machines: {},
    machineListByServerId: {},
    sessionListRowsByServerId: {},
    ordinarySessionListMembershipByServerId: {},
    sessionListIndexByServerId: {},
    concurrentSessionListCacheByServerId: {},
};

installVoiceAgentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            // Return a fresh snapshot so the storage testkit's completed-state
            // adapter cannot retain a previous test's top-level fixture object.
            storage: { getState: () => ({ ...state }) },
        });
    },
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => `t:${key}` });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: FOCUSED_HOME, serverUrl: 'http://focused', generation: 1 }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
        ...original,
        machineContributionRegistryProjectionDescribe: (machineId: string, options?: any) => {
            projectionRequests.push({ machineId, serverId: options?.serverId ?? null });
            return describeProjection(machineId, options);
        },
    };
});

function buildProjection(agents: Readonly<Record<string, unknown>>) {
    return {
        supported: true,
        projection: {
            v: 2,
            generation: 3,
            installedPackagesById: {},
            agentsById: agents,
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        },
    };
}

/** A current-catalog declaration: the bundled Claude contribution publishing its terminal surface. */
const CLAUDE_WITH_TERMINAL_SURFACE = {
    id: 'claude',
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    capabilities: {
        surfaces: ['terminal'],
        sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
    },
};

/** The same Agent shape without the terminal surface: capable of sessions, not of local control. */
const CLAUDE_WITHOUT_TERMINAL_SURFACE = {
    id: 'claude',
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    capabilities: {
        sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
    },
};

function seedTargetSession(overrides: Readonly<Record<string, unknown>> = {}) {
    const session = {
        id: 'target-1',
        serverId: TARGET_HOME,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        agentState: { requests: {} },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: { flavor: 'claude', machineId: 'machine-1', path: '/tmp/target' },
        ...overrides,
    };
    state.sessions = { 'target-1': session };
    state.sessionListIndexByServerId = {
        [TARGET_HOME]: [{ type: 'session', sessionId: 'target-1', serverId: TARGET_HOME, serverName: 'Target' }],
    };
    return session;
}

// Load the real graph once after boundary registration, outside case deadlines.
const { assertActiveDaemonTargetSession, resolveVoiceAgentSessionFromState } = await import('./voiceAgentRunState');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');

async function assertTarget(target: unknown) {
    return await assertActiveDaemonTargetSession(target as never);
}

async function resolveVoiceSession(target: unknown) {
    return resolveVoiceAgentSessionFromState(target as never);
}

describe('assertActiveDaemonTargetSession', () => {
    beforeEach(() => {
        clearDaemonMergedProjectionCacheForTests();
        projectionRequests.length = 0;
        describeProjection.mockReset();
        describeProjection.mockResolvedValue({ supported: false, reason: 'not-supported' });
        state.sessions = {};
        state.machines = {};
        state.machineListByServerId = {};
        state.sessionListRowsByServerId = {};
        state.ordinarySessionListMembershipByServerId = {};
        state.sessionListIndexByServerId = {};
        state.concurrentSessionListCacheByServerId = {};
        seedTargetSession();
    });

    it('admits a target whose own Home projects the terminal surface for its Agent', async () => {
        describeProjection.mockResolvedValue(buildProjection({ claude: CLAUDE_WITH_TERMINAL_SURFACE }));

        await expect(assertTarget({ serverId: TARGET_HOME, sessionId: 'target-1' })).resolves.toBeUndefined();

        // The target's Home, never the focused one: a focus change must not decide capability.
        expect(projectionRequests).toEqual([{ machineId: 'machine-1', serverId: TARGET_HOME }]);
    });

    it('refuses a target whose projected Agent declares no terminal surface', async () => {
        describeProjection.mockResolvedValue(buildProjection({ claude: CLAUDE_WITHOUT_TERMINAL_SURFACE }));

        await expect(assertTarget({ serverId: TARGET_HOME, sessionId: 'target-1' })).rejects.toMatchObject({
            code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
        });
    });

    it('fails closed when the target Home cannot project its Agent declarations', async () => {
        describeProjection.mockResolvedValue({ supported: false, reason: 'not-supported' });

        await expect(assertTarget({ serverId: TARGET_HOME, sessionId: 'target-1' })).rejects.toMatchObject({
            code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
        });
    });

    it('fails closed for an unreadable Agent identity even with a ready projection', async () => {
        seedTargetSession({ metadata: { machineId: 'machine-1', path: '/tmp/target' } });
        describeProjection.mockResolvedValue(buildProjection({ claude: CLAUDE_WITH_TERMINAL_SURFACE }));

        await expect(assertTarget({ serverId: TARGET_HOME, sessionId: 'target-1' })).rejects.toMatchObject({
            code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
        });
    });

    it('still reports inactive and offline targets after the capability check passes', async () => {
        describeProjection.mockResolvedValue(buildProjection({ claude: CLAUDE_WITH_TERMINAL_SURFACE }));

        seedTargetSession({ active: false });
        await expect(assertTarget({ serverId: TARGET_HOME, sessionId: 'target-1' })).rejects.toMatchObject({
            code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE',
        });

        seedTargetSession({ presence: 'offline' });
        await expect(assertTarget({ serverId: TARGET_HOME, sessionId: 'target-1' })).rejects.toMatchObject({
            code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE',
        });
    });

    it('does not use a direct Session row from another Home for an explicit target', async () => {
        seedTargetSession({ serverId: 'home-other' });
        state.sessionListIndexByServerId = {};

        await expect(resolveVoiceSession({ serverId: TARGET_HOME, sessionId: 'target-1' })).resolves.toBeNull();
    });

    it('fails closed when a bare Session ID is present on more than one Home', async () => {
        seedTargetSession();
        state.ordinarySessionListMembershipByServerId = {
            [TARGET_HOME]: ['target-1'],
            'home-other': ['target-1'],
        };

        await expect(resolveVoiceSession('target-1')).resolves.toBeNull();
    });
});
