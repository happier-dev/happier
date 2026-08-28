import { afterEach, describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';

function toolMessage(name: string, input: Record<string, unknown>): Message {
    return {
        kind: 'tool-call',
        id: `tool-${name}`,
        localId: null,
        createdAt: 1,
        children: [],
        tool: {
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
        },
    };
}

describe('session provider behavior Agent ownership', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('does not derive Claude team participants for an external Agent with Claude-shaped tools', async () => {
        const { deriveProviderSessionSubagents } = await import('./sessionProviderBehaviorRegistry');
        const metadata = {
            machineId: 'machine-external',
            runtimeDescriptorV1: { v: 1, agentId: 'acme.agent', agent: {} },
        };

        expect(deriveProviderSessionSubagents({
            flavor: 'claude',
            metadata,
            messages: [
                toolMessage('AgentTeamCreate', { team_name: 'acme-team' }),
                toolMessage('Agent', { team_name: 'acme-team', name: 'worker' }),
            ],
        })).toEqual([]);
    });

    it('uses the external Agent session behavior projected by the owning machine', async () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-external',
            descriptorsByAgentId: {
                'acme.agent': {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: 'acme.agent',
                    version: 1,
                    session: {
                        providerBehavior: {
                            kind: 'session.providerBehavior.v1',
                            participants: {
                                sidechainIds: {
                                    kind: 'toolCallInputString',
                                    toolNames: ['AcmeWorker'],
                                    inputKey: 'workerId',
                                },
                            },
                        },
                    },
                },
            },
        });
        const { deriveProviderParticipantSidechainIds } = await import('./sessionProviderBehaviorRegistry');
        const messages = [toolMessage('AcmeWorker', { workerId: 'worker-7' })];

        expect(deriveProviderParticipantSidechainIds({
            flavor: null,
            metadata: {
                machineId: 'machine-external',
                runtimeDescriptorV1: { v: 1, agentId: 'acme.agent', agent: {} },
            },
            messages,
        })).toEqual(['worker-7']);
        expect(deriveProviderParticipantSidechainIds({
            flavor: null,
            metadata: {
                machineId: 'different-machine',
                runtimeDescriptorV1: { v: 1, agentId: 'acme.agent', agent: {} },
            },
            messages,
        })).toEqual([]);
    });
});
