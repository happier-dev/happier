import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { makeSettings } from '@/agents/registry/registryUiBehavior.testHelpers';

const projectionState = vi.hoisted(() => ({
    phase: 'ready' as 'ready' | 'loading',
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => projectionState.phase === 'ready'
        ? {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: {
                    v: 2,
                    generation: 42,
                    agentsById: {
                        antigravity: {
                            id: 'antigravity',
                            identity: {
                                pluginId: 'happier.agent.antigravity',
                                localId: 'antigravity',
                            },
                            capabilities: {
                                sessions: {
                                    open: ['create', 'resume', 'fork'],
                                    delivery: ['newTurn', 'steer', 'followUp'],
                                    cancel: true,
                                    conversationRollback: true,
                                    usageLimitRecovery: {
                                        active: ['checkNow'],
                                        inactive: ['checkNow', 'consumeResetCredit'],
                                    },
                                },
                                executionRuns: {
                                    open: ['create', 'resume', 'fork'],
                                    checkpoint: true,
                                    stop: true,
                                },
                                surfaces: ['terminal'],
                            },
                            externalSessions: {
                                agent: {
                                    pluginId: 'happier.agent.antigravity',
                                    localId: 'antigravity',
                                },
                                generation: 42,
                                operations: {
                                    listCandidates: true,
                                    resolveLinkIdentity: true,
                                    pageTranscript: true,
                                    readAfterTranscript: true,
                                },
                                sources: [{
                                    sourceKind: 'antigravityCliPrint',
                                }],
                            },
                        },
                    },
                },
            },
        }
        : {
            phase: 'loading',
            inputs: null,
        },
}));

describe('useResumeCapabilityOptions', () => {
    it('supplies the current daemon Agent identity and source contract to resume policy', async () => {
        projectionState.phase = 'ready';
        const { useResumeCapabilityOptions } = await import('./useResumeCapabilityOptions');
        const hook = await renderHook(() => useResumeCapabilityOptions({
            agentId: 'antigravity',
            machineId: 'machine-1',
            serverId: 'server-1',
            settings: makeSettings(),
        }));

        expect(hook.getCurrent().resumeCapabilityOptions.linkedSessionCurrentAgent).toEqual({
            identity: {
                pluginId: 'happier.agent.antigravity',
                localId: 'antigravity',
            },
            sourceKinds: ['antigravityCliPrint'],
        });
        expect(hook.getCurrent().resumeCapabilityOptions.currentAgentCapabilities).toMatchObject({
            agentId: 'antigravity',
            generation: 42,
            capabilities: {
                sessions: { open: ['create', 'resume', 'fork'] },
                executionRuns: { open: ['create', 'resume', 'fork'] },
                surfaces: ['terminal'],
            },
        });
    });

    it('fails linked identity resolution closed while the daemon projection is not ready', async () => {
        projectionState.phase = 'loading';
        const { useResumeCapabilityOptions } = await import('./useResumeCapabilityOptions');
        const hook = await renderHook(() => useResumeCapabilityOptions({
            agentId: 'antigravity',
            machineId: 'machine-1',
            serverId: 'server-1',
            settings: makeSettings(),
        }));

        expect(hook.getCurrent().resumeCapabilityOptions.linkedSessionCurrentAgent).toBeNull();
        expect(hook.getCurrent().resumeCapabilityOptions.currentAgentCapabilities).toBeNull();
    });
});
