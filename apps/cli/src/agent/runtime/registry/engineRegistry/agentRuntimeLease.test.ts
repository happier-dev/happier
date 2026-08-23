import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { resolveLeasedAgentRuntime } from './agentRuntimeLease';

async function createUnexpectedAgentRuntimeSurfaceInvocationContext(): Promise<never> {
    throw new Error('Lease fixture should not create an Agent runtime surface invocation context');
}

describe('leased Agent runtime resolution', () => {
    it('fails closed when a partial lease omits generation retirement ownership', async () => {
        const lease: AgentRuntimeRegistrationLease = {
            pluginId: 'acme.agent',
            pluginVersion: '1.0.0',
            agentId: 'assistant',
            localAgentId: 'assistant',
            generation: '7',
            immutableGenerationId: null,
            hasPrimaryRuntime: true,
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            createRuntime: async () => Object.freeze({
                sessions: Object.freeze({
                    open: async () => {
                        throw new Error('not invoked');
                    },
                }),
            }),
        };
        expect(Reflect.deleteProperty(lease, 'retirementSignal')).toBe(true);

        await expect(resolveLeasedAgentRuntime({ lease })).rejects.toThrow(/retirement signal/i);
    });

    it('returns the registered native Agent runtime directly', async () => {
        const retirementSignal = new AbortController().signal;
        const nativeRuntime = Object.freeze({
            sessions: Object.freeze({
                open: async () => {
                    throw new Error('not invoked');
                },
            }),
        });
        const lease: AgentRuntimeRegistrationLease = Object.freeze({
            pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'assistant', localAgentId: 'assistant', generation: '7', immutableGenerationId: null, hasPrimaryRuntime: true, isCurrent: () => true,
            retirementSignal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            createRuntime: async () => nativeRuntime,
        });

        const resolved = await resolveLeasedAgentRuntime({ lease });

        expect(resolved).toBe(nativeRuntime);
    });

    it('projects host-bound surfaces onto the leased Agent runtime without replacing native surfaces', async () => {
        const retirementSignal = new AbortController().signal;
        const checkpoint = Object.freeze({
            checkpoint: vi.fn(async () => ({
                id: 'checkpoint-1',
                target: { kind: 'provider_checkpoint' as const, checkpointId: 'provider-1' },
                timing: 'idle' as const,
                checkpointScopes: ['conversation' as const],
                restoreScopes: ['conversation' as const],
            })),
        });
        const attach = Object.freeze({
            attach: vi.fn(async () => ({ ok: true as const, value: { exitCode: 0 } })),
        });
        const lease: AgentRuntimeRegistrationLease = Object.freeze({
            pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'assistant', localAgentId: 'assistant', generation: '7', immutableGenerationId: null, hasPrimaryRuntime: true, isCurrent: () => true,
            retirementSignal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            createRuntime: async () => Object.freeze({
                sessions: Object.freeze({
                    open: async () => {
                        throw new Error('not invoked');
                    },
                }),
                surfaces: Object.freeze({ checkpoint }),
            }),
        });

        const resolved = await resolveLeasedAgentRuntime({
            lease,
            resolveHostSurfaces: async () => Object.freeze({ attach }),
        });

        expect(resolved.surfaces?.attach).toBe(attach);
        expect(resolved.surfaces?.checkpoint).toBe(checkpoint);
    });

    it('fails closed when host and Agent runtime surfaces compete for the same family', async () => {
        const attach = Object.freeze({
            attach: vi.fn(async () => ({ ok: true as const, value: { exitCode: 0 } })),
        });
        const lease: AgentRuntimeRegistrationLease = Object.freeze({
            pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'assistant', localAgentId: 'assistant', generation: '7', immutableGenerationId: null, hasPrimaryRuntime: true, isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            createRuntime: async () => Object.freeze({
                executionRuns: Object.freeze({
                    open: async () => {
                        throw new Error('not invoked');
                    },
                }),
                surfaces: Object.freeze({ attach }),
            }),
        });

        await expect(resolveLeasedAgentRuntime({
            lease,
            resolveHostSurfaces: async () => Object.freeze({ attach }),
        })).rejects.toThrow(/competing.*attach/i);
    });

    it('rejects host-bound surfaces that settle after their runtime generation retires', async () => {
        const retirement = new AbortController();
        let current = true;
        const lease: AgentRuntimeRegistrationLease = Object.freeze({
            pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'assistant', localAgentId: 'assistant', generation: '7', immutableGenerationId: null, hasPrimaryRuntime: true, isCurrent: () => current,
            retirementSignal: retirement.signal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            createRuntime: async () => Object.freeze({
                executionRuns: Object.freeze({
                    open: async () => {
                        throw new Error('not invoked');
                    },
                }),
            }),
        });

        await expect(resolveLeasedAgentRuntime({
            lease,
            resolveHostSurfaces: async () => {
                current = false;
                retirement.abort();
                return Object.freeze({
                    attach: Object.freeze({
                        attach: vi.fn(async () => ({ ok: true as const, value: { exitCode: 0 } })),
                    }),
                });
            },
        })).rejects.toThrow(/retired while resolving host-bound surfaces/i);
    });
});
