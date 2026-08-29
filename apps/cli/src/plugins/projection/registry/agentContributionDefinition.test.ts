import { describe, expect, it } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';

import {
    readAgentExecutionRunCapabilities,
    readAgentPrimaryRuntime,
    readAgentSessionCapabilities,
} from './agentContributionDefinition';

describe('Agent contribution definition discriminants', () => {
    it('keeps auxiliary-only Agents out of primary runtime and capability consumers', () => {
        const auxiliaryOnly = PluginAgentContributionV2Schema.parse({
            id: 'external-agent',
            title: 'External Agent',
            capabilities: { surfaces: ['externalSessions'] },
            surfaces: {
                externalSession: {
                    sources: [{
                        sourceKind: 'fixture',
                        schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
                        key: { segments: [{ kind: 'literal', value: 'fixture' }] },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        });

        expect(readAgentPrimaryRuntime(auxiliaryOnly)).toBeNull();
        expect(readAgentSessionCapabilities(auxiliaryOnly)).toBeNull();
        expect(readAgentExecutionRunCapabilities(auxiliaryOnly)).toBeNull();
    });

    it('rejects a Session-primary executionRuns block and derives Runs only from Session facts', () => {
        const sessionPrimary = {
            id: 'primary-agent',
            title: 'Primary Agent',
            runtime: { kind: 'custom' },
            primary: 'sessions',
            capabilities: {
                sessions: {
                    open: ['create', 'resume'],
                    delivery: ['newTurn'],
                    cancel: true,
                },
                executionRuns: {
                    open: ['create'],
                    checkpoint: false,
                    stop: true,
                },
            },
        } as const;

        expect(PluginAgentContributionV2Schema.safeParse(sessionPrimary).success).toBe(false);

        const primary = PluginAgentContributionV2Schema.parse({
            ...sessionPrimary,
            capabilities: {
                sessions: sessionPrimary.capabilities.sessions,
            },
        });

        expect(readAgentPrimaryRuntime(primary)).toEqual({ kind: 'custom' });
        expect(readAgentSessionCapabilities(primary)?.open).toEqual(['create', 'resume']);
        expect(readAgentExecutionRunCapabilities(primary)).toEqual({
            open: ['create', 'resume'],
            checkpoint: true,
            stop: true,
        });
    });

    it('does not mistake continuation verification for provider Session identity', () => {
        const primary = PluginAgentContributionV2Schema.parse({
            id: 'create-only-agent',
            title: 'Create-only Agent',
            runtime: { kind: 'custom' },
            primary: 'sessions',
            capabilities: {
                sessions: {
                    open: ['create'],
                    delivery: ['newTurn'],
                    cancel: false,
                    continuationVerification: {
                        intents: ['resume'],
                        requirement: 'required',
                    },
                },
            },
        });

        expect(readAgentExecutionRunCapabilities(primary)).toEqual({
            open: ['create'],
            checkpoint: false,
            stop: false,
        });
    });
});
