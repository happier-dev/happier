import { expect, it } from 'vitest';
import { readConcreteAgentPresentation } from '@happier-dev/agents/presentation';
import { resolveAgentCatalogProjection, resolveAgentCatalogTitle } from './agentCatalogProjection';
import { getAgentPickerOptions } from '@/agents/catalog/agentPickerOptions';
import { describeApprovalAgent } from '@/components/approvals/approvalRequesterLabels';

it('retains the catalog display name when Connect changes between cached and Machine declarations', () => {
    const title = readConcreteAgentPresentation('ohMyPi')!.name;
    const params = { enabledAgentIds: ['ohMyPi'] };
    expect(resolveAgentCatalogTitle('ohMyPi')).toBe(title);
    expect(resolveAgentCatalogProjection('ohMyPi', params).title).toBe(title);
    expect(resolveAgentCatalogProjection('ohMyPi', { ...params, mergedProviderProjectionById: {
        ohMyPi: { agentId: 'ohMyPi', title },
    } }).title).toBe(title);
});

it('uses the same declared name for legacy picker and approval consumers', () => {
    const title = readConcreteAgentPresentation('ohMyPi')!.name;
    expect(getAgentPickerOptions(['ohMyPi'])[0]).toMatchObject({ title });
    expect(describeApprovalAgent('ohMyPi')).toBe(title);
});
