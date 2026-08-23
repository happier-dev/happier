import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const machineSpawnNewSessionMock = vi.fn();
const state: any = {
    sessions: {},
    machines: {},
    settings: {},
};

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => state,
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }),
}));

vi.mock('@/sync/ops/machines', () => ({
    machineSpawnNewSession: (params: unknown) => machineSpawnNewSessionMock(params),
    machineSpawnNewSessionUntilResolved: (params: unknown) => machineSpawnNewSessionMock(params),
    completeMachineSpawnAttemptCustody: vi.fn(async () => true),
}));

vi.mock('./spawnSessionPostProcess', () => ({
    postprocessSpawnedSession: vi.fn(async () => undefined),
}));

describe('spawnSessionForVoiceTool', () => {
    beforeEach(() => {
        vi.resetModules();
        machineSpawnNewSessionMock.mockReset();
        machineSpawnNewSessionMock.mockResolvedValue({ type: 'success', sessionId: 'voice-session' });
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        } as any);
        state.sessions = {};
        state.machines = {
            'machine-current': {
                id: 'machine-current',
                active: true,
                activeAt: Date.now(),
                metadata: { host: 'mac', displayName: 'Mac', homeDir: '/Users/test' },
            },
        };
        state.settings = {
            lastUsedAgent: 'claude',
            recentMachinePaths: [],
        };
        state.getProjectForSession = undefined;
    });

    it('canonicalizes raw recent machine paths through explicit replacement before spawning', async () => {
        const { spawnSessionForVoiceTool } = await import('./spawnSession');

        state.machines = {
            'machine-old': {
                id: 'machine-old',
                active: false,
                activeAt: 1,
                replacedByMachineId: 'machine-current',
                replacedAt: 100,
                replacementReason: 'manual_repair',
                replacementSource: 'manual',
                metadata: { host: 'mac', homeDir: '/Users/test' },
            },
            'machine-current': {
                id: 'machine-current',
                active: true,
                activeAt: Date.now(),
                metadata: { host: 'mac', displayName: 'Mac', homeDir: '/Users/test' },
            },
        };
        state.settings.recentMachinePaths = [{ machineId: 'machine-old', path: '/Users/test/repo' }];

        await spawnSessionForVoiceTool({});

        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-current',
            directory: '/Users/test/repo',
        }));
    });

    it('spawns from the resolved focused session machine target', async () => {
        const { spawnSessionForVoiceTool } = await import('./spawnSession');

        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: 's1',
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        } as any);
        state.sessions = {
            s1: {
                id: 's1',
                active: false,
                metadata: {
                    machineId: 'machine-old',
                    path: '/Users/test/stale-repo',
                },
            },
        };
        state.getProjectForSession = (sessionId: string) =>
            sessionId === 's1'
                ? {
                    key: {
                        machineId: 'machine-current',
                        path: '/Volumes/live/repo',
                    },
                }
                : null;
        state.machines = {
            'machine-old': {
                id: 'machine-old',
                active: false,
                activeAt: 1,
                replacedByMachineId: 'machine-current',
                replacedAt: 100,
                replacementReason: 'manual_repair',
                replacementSource: 'manual',
                metadata: { host: 'mac', homeDir: '/Users/test' },
            },
            'machine-current': {
                id: 'machine-current',
                active: true,
                activeAt: Date.now(),
                metadata: { host: 'mac', displayName: 'Mac', homeDir: '/Users/test' },
            },
        };

        await spawnSessionForVoiceTool({});

        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-current',
            directory: '/Volumes/live/repo',
        }));
    });

    it('keeps sourceContext and the stable Action attempt identity on the canonical machine spawn', async () => {
        const { spawnSessionForVoiceTool } = await import('./spawnSession');
        state.machines['machine-current'].daemonState = { startedWithCliVersion: '0.2.10-dev.76' };
        const sourceContext = {
            v: 1,
            kind: 'session_replay',
            sourceSessionId: 'sess_source',
            forkPoint: { type: 'latest' },
        } as const;

        await spawnSessionForVoiceTool({
            host: 'mac',
            path: '/Users/test/repo',
            agentId: 'claude',
            sourceContext,
            actionRequestId: 'stable-action-attempt',
        } as any);

        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-current',
            directory: '/Users/test/repo',
            sourceContext,
            userAttemptId: 'stable-action-attempt',
        }));
    }, 120_000);

    it('fails closed instead of dropping sourceContext for a backend this bridge cannot carry', async () => {
        const { spawnSessionForVoiceTool } = await import('./spawnSession');

        await expect(spawnSessionForVoiceTool({
            host: 'mac',
            path: '/Users/test/repo',
            sourceContext: {
                v: 1,
                kind: 'session_replay',
                sourceSessionId: 'sess_source',
                forkPoint: { type: 'latest' },
            },
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'remote-agent' },
        } as any)).resolves.toMatchObject({
            type: 'error',
            errorCode: 'invalid_parameters',
            errorMessage: 'source_context_requires_built_in_agent',
        });

        expect(machineSpawnNewSessionMock).not.toHaveBeenCalled();
    });

    it('rejects duplicate same-host raw recent targets without explicit replacement', async () => {
        const { spawnSessionForVoiceTool } = await import('./spawnSession');

        state.machines = {
            'machine-a': {
                id: 'machine-a',
                active: true,
                activeAt: Date.now(),
                metadata: { host: 'mac', homeDir: '/Users/test' },
            },
            'machine-b': {
                id: 'machine-b',
                active: true,
                activeAt: Date.now(),
                metadata: { host: 'mac', homeDir: '/Users/test' },
            },
        };
        state.settings.recentMachinePaths = [{ machineId: 'machine-a', path: '/Users/test/repo' }];

        await expect(spawnSessionForVoiceTool({ host: 'mac' })).resolves.toMatchObject({
            type: 'error',
            errorCode: 'host_ambiguous',
        });
        expect(machineSpawnNewSessionMock).not.toHaveBeenCalled();
    });
});
