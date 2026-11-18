import { expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { selectSessionModelPickerSourceGroups } from './selectSessionModelPickerSourceGroups';

it('groups only explicit upstream matches and counts distinct routes', () => {
    const upstreamRef = { vendor: 'openai', vendorModelId: 'gpt-4' };
    const provider = (providerConnectionId: string, modelId: string, ref?: typeof upstreamRef) => ({
        value: { agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse(providerConnectionId), modelId },
        label: 'GPT-4',
        source: { label: 'Gateway', native: false },
        upstreamRef: ref,
    });
    const a = provider('123e4567-e89b-42d3-a456-426614174001', 'openai/gpt-4', upstreamRef);
    const alias = { ...a, value: { ...a.value, modelId: 'openai/gpt-4-preview' } };
    const b = provider('123e4567-e89b-42d3-a456-426614174002', 'gpt-4', upstreamRef);
    const unknown = provider('123e4567-e89b-42d3-a456-426614174003', 'gpt-4');
    const different = provider('123e4567-e89b-42d3-a456-426614174004', 'gpt-4', { ...upstreamRef, vendor: 'other' });
    const groups = selectSessionModelPickerSourceGroups([
        { id: 'favorites', options: [a] },
        { id: 'sources', options: [a, alias, b, unknown, different] },
    ]);
    expect(groups.map(group => group.sourceCount)).toEqual([2, 1, 1]);
    expect(groups[0]?.sources.map(source => source.options.map(option => option.value))).toEqual([
        [a.value, alias.value], [b.value],
    ]);
});

it('counts an exact match on a hidden connection and keeps a signed-out route for the menu', () => {
    const upstreamRef = { vendor: 'openai', vendorModelId: 'gpt-4' };
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const connectionId = ProviderConnectionIdSchema.parse('pc_hidden');
    const groups = selectSessionModelPickerSourceGroups([{ id: 'models', options: [
        { value: { agentTargetKey, providerConnectionId: null, modelId: 'gpt-4' }, label: 'GPT-4', upstreamRef },
        { value: { agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('pc_signed_out'), modelId: 'gpt-4' },
            label: 'GPT-4', upstreamRef, availability: 'unavailable', sourceState: 'signed-out' },
        { value: { agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('pc_needs_key'), modelId: 'gpt-4' },
            label: 'GPT-4', upstreamRef, availability: 'unavailable', sourceState: 'needs-key' },
    ] }], { agentTargetKey, hiddenSources: [
        { connectionId, upstreamModels: [{ upstreamRef, endpointHealth: 'available' }] },
        { connectionId: ProviderConnectionIdSchema.parse('pc_hidden_auth'), upstreamModels: [{ upstreamRef, endpointHealth: 'unauthorized' }] },
        { connectionId: ProviderConnectionIdSchema.parse('pc_other'), upstreamModels: [{ upstreamRef: { ...upstreamRef, vendor: 'other' }, endpointHealth: 'available' }] },
    ] });
    expect(groups).toMatchObject([{ sourceCount: 2, sources: [
        { providerConnectionId: null, state: 'ready' },
        { providerConnectionId: 'pc_signed_out', state: 'signed-out' },
        { providerConnectionId: 'pc_needs_key', state: 'needs-key' },
        { providerConnectionId: connectionId, state: 'ready', hidden: true, options: [] },
        { providerConnectionId: 'pc_hidden_auth', state: 'needs-key', hidden: true, options: [] },
    ] }]);
});
