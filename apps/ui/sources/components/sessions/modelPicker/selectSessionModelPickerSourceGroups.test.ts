import { expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { createMuseCatalog } from '../../../../../../packages/plugins/muse/src/agent/catalog';
import { CLIPROXYAPI_STATIC_MODELS } from '../../../../../../packages/plugins/cliproxyapi/src/provider/staticModels.generated';
import { selectSessionModelPickerSourceGroups } from './selectSessionModelPickerSourceGroups';

it('groups each Muse model across its native catalog and two gateway connections', async () => {
    const modelIds = ['muse-spark-1.3', 'muse-spark-1.3-contributor'];
    const { models: native } = await createMuseCatalog({
        request: async () => ({ models: modelIds.map(modelId => ({ providerId: 'meta', modelId })) }),
    }).refresh();
    const gateway = CLIPROXYAPI_STATIC_MODELS.meta.filter(model => modelIds.includes(model.id));
    const agentTargetKey = 'agent:happier.agent.muse/muse';
    const connections = ['pc_muse_primary', 'pc_muse_secondary'].map(id => ProviderConnectionIdSchema.parse(id));
    const groups = selectSessionModelPickerSourceGroups([{ id: 'models', options: [
        ...(native ?? []).map(model => ({
            value: { agentTargetKey, providerConnectionId: null, modelId: model.id },
            label: model.name,
            upstreamRef: model.upstreamRef,
        })),
        ...connections.flatMap(providerConnectionId => gateway.map(model => ({
            value: { agentTargetKey, providerConnectionId, modelId: model.id },
            label: model.name,
            upstreamRef: model.upstreamRef,
        }))),
    ] }]);
    expect(groups.map(group => ({
        upstreamRef: group.upstreamRef,
        connections: group.sources.map(source => source.providerConnectionId),
        sourceCount: group.sourceCount,
    }))).toEqual(modelIds.map(vendorModelId => ({
        upstreamRef: { vendor: 'meta', vendorModelId }, connections: [null, ...connections], sourceCount: 3,
    })));
});

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
