import { describe, expect, it } from 'vitest';

import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { resolveLeasedAgentRuntime } from './agentRuntimeLease';

describe('leased Agent runtime resolution', () => {
    it('fails closed when a partial lease omits generation retirement ownership', async () => {
        const lease = Object.freeze({
            pluginId: 'acme.agent',
            pluginVersion: '1.0.0',
            agentId: 'assistant',
            generation: '7',
            immutableGenerationId: null,
            hasPrimaryRuntime: true,
            isCurrent: () => true,
            createRuntime: async () => Object.freeze({
                sessions: Object.freeze({
                    open: async () => {
                        throw new Error('not invoked');
                    },
                }),
            }),
        }) as unknown as AgentRuntimeRegistrationLease;

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
            pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'assistant', generation: '7', immutableGenerationId: null, hasPrimaryRuntime: true, isCurrent: () => true,
            retirementSignal,
            createRuntime: async () => nativeRuntime,
        });

        const resolved = await resolveLeasedAgentRuntime({ lease });

        expect(resolved).toBe(nativeRuntime);
    });
});
