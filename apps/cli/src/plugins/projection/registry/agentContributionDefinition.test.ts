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

    it('reads optional primary capabilities from the declared primary Agent shape', () => {
        const primary = PluginAgentContributionV2Schema.parse({
            id: 'primary-agent',
            title: 'Primary Agent',
            runtime: { kind: 'custom' },
            primary: 'sessions',
            capabilities: {
                sessions: {
                    open: ['create'],
                    delivery: ['newTurn'],
                    cancel: true,
                },
                executionRuns: {
                    open: ['create'],
                    checkpoint: false,
                    stop: true,
                },
            },
        });

        expect(readAgentPrimaryRuntime(primary)).toEqual({ kind: 'custom' });
        expect(readAgentSessionCapabilities(primary)?.open).toEqual(['create']);
        expect(readAgentExecutionRunCapabilities(primary)?.open).toEqual(['create']);
    });
});
