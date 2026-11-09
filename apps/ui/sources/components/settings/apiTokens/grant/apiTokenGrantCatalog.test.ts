import { describe, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/selection/v1';

import { buildApiTokenGrantModelOptions, type ApiTokenGrantProviderModelGroup } from './apiTokenGrantCatalog';

const AGENT = 'agent:claude/claude';
const ref = (value: unknown): ProviderBoundModelRef => ProviderBoundModelRefSchema.parse(value);
const OPENROUTER_REF = ref({ agentTargetKey: AGENT, providerConnectionId: 'conn_openrouter', modelId: 'deepseek/deepseek-v4' });

/** One connection group as the daemon's provider-model projection returns it (only the fields the grant reads). */
const OPENROUTER: ApiTokenGrantProviderModelGroup = {
    connectionId: OPENROUTER_REF.providerConnectionId!,
    providerName: 'OpenRouter',
    connectionName: 'Work',
    connectionRole: 'named',
    connectionDisplayNameMode: 'custom',
    rows: [{
        ref: OPENROUTER_REF,
        descriptor: { id: OPENROUTER_REF.modelId, name: 'DeepSeek V4' },
    }],
};

describe('grant model options', () => {
    it('offers the provider-connected models of the model projection with their full provider-bound ref', () => {
        const options = buildApiTokenGrantModelOptions({
            agentTargetKey: AGENT,
            nativeModels: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet', description: 'Balanced' }],
            providerGroups: [OPENROUTER],
            granted: null,
        });

        expect(options.map((option) => option.ref)).toEqual([
            { agentTargetKey: AGENT, providerConnectionId: null, modelId: 'claude-sonnet-4-5' },
            OPENROUTER_REF,
        ]);
        const provider = options[1]!;
        expect(provider.name).toBe('DeepSeek V4');
        // The row names its connection, as the agent-wide model manager does.
        expect(provider.description).toBe('OpenRouter · Work');
    });

    it('never offers a native automatic placeholder as a finite grant model', () => {
        const providerDefault = ref({ agentTargetKey: AGENT, providerConnectionId: 'conn_default', modelId: 'default' });
        const options = buildApiTokenGrantModelOptions({
            agentTargetKey: AGENT,
            nativeModels: [
                { id: 'default', name: 'Default' },
                { id: 'claude-sonnet-4-5', name: 'Claude Sonnet' },
            ],
            providerGroups: [{ ...OPENROUTER, rows: [{
                ref: providerDefault,
                descriptor: { id: providerDefault.modelId, name: 'Provider default' },
            }] }],
            granted: null,
        });

        expect(options.map((option) => option.ref)).toEqual([
            { agentTargetKey: AGENT, providerConnectionId: null, modelId: 'claude-sonnet-4-5' },
            providerDefault,
        ]);
    });

    it('keeps a granted model this computer does not offer, so it can still be seen and removed', () => {
        const missing = ref({ agentTargetKey: AGENT, providerConnectionId: 'conn_gone', modelId: 'old-model' });
        const options = buildApiTokenGrantModelOptions({
            agentTargetKey: AGENT,
            nativeModels: [],
            providerGroups: [OPENROUTER],
            granted: [missing, OPENROUTER_REF],
        });

        expect(options.map((option) => option.ref)).toEqual([OPENROUTER_REF, missing]);
        expect(options[1]).toMatchObject({ name: 'old-model', description: null });
    });

    it('ignores granted refs and projection rows that belong to another agent', () => {
        const other = ref({ agentTargetKey: 'agent:codex/codex', providerConnectionId: null, modelId: 'gpt-6' });
        const options = buildApiTokenGrantModelOptions({
            agentTargetKey: AGENT,
            nativeModels: [],
            providerGroups: [{ ...OPENROUTER, rows: [{ ...OPENROUTER.rows[0]!, ref: { ...OPENROUTER_REF, agentTargetKey: 'agent:codex/codex' } }] }],
            granted: [other],
        });

        expect(options).toEqual([]);
    });
});
