import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';

import { readAccountAgentProviderDeclarations, readAccountProviderDeclarations } from './accountProviderDeclarations';
import { projectProviderDeclarationDetail } from './providerDeclarationDetail';

describe('Provider declaration details', () => {
    const agents = readAccountAgentProviderDeclarations({ kind: 'account' });
    const sample = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.id === 'deepseek')!;

    it('retains declared catalog identity and API-key facts without claiming runtime verification or a package version', () => {
        const detail = projectProviderDeclarationDetail(sample, agents);
        expect(detail.auth).toEqual({ kind: 'apiKey', required: true, keyUrl: sample.definition.credential!.keyUrl });
        expect(detail.models).toBe(sample.definition.catalog);
        expect(detail.source).toEqual({ contributionKey: sample.contributionKey, provenance: 'first_party',
            websiteUrl: sample.definition.websiteUrl });
        expect(detail.nextStep).toEqual({ kind: 'apiKey' });
        expect(detail.worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude')).toBe(true);
        expect(detail.worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.codex/codex')).toBe(false);
    });

    it('omits undeclared auth and source facts', () => {
        const { credential: _credential, websiteUrl: _website, managedRuntime: _runtime,
            legacyProfileMigrations: _legacy, ...definition } = sample.definition;
        const detail = projectProviderDeclarationDetail({ ...sample, provenance: 'external', definition: ProviderContributionV1Schema.parse({
            ...definition,
            catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'image', name: 'Image', capabilities: { toolRoundTrips: 'unsupported' } }] },
        }) }, []);
        expect(detail).not.toHaveProperty('auth');
        expect(detail).not.toHaveProperty('nextStep');
        expect(detail).not.toHaveProperty('connectedAccounts');
        expect(detail.source).toEqual({ contributionKey: sample.contributionKey, provenance: 'external' });
        expect(detail.worksWith).toEqual([]);
    });

    it('uses model capability evidence rather than protocol overlap to establish an Agent fit', () => {
        const incompatible = { ...sample, definition: ProviderContributionV1Schema.parse({
            ...sample.definition, legacyProfileMigrations: undefined,
            catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'image', name: 'Image', capabilities: { toolRoundTrips: 'unsupported' } }] },
        }) };
        const detail = projectProviderDeclarationDetail(incompatible, agents);
        expect(detail.auth?.required).toBe(true);
        expect(detail.worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude')).toBe(false);
    });

    it('keeps optional keys optional and probe-only model membership unknown', () => {
        const detail = projectProviderDeclarationDetail({ ...sample, definition: ProviderContributionV1Schema.parse({
            ...sample.definition, legacyProfileMigrations: undefined, credential: { ...sample.definition.credential, required: false },
            catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [
                { endpointTemplateId: 'deepseek-openai-chat', path: '/v1/models', parser: 'openai-models' },
            ] },
        }) }, agents);
        expect(detail.auth?.required).toBe(false);
        expect(detail).not.toHaveProperty('nextStep');
        expect(detail.models.source).toBe('probe');
        expect(detail.models).not.toHaveProperty('staticModels');
        expect(detail.worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude')).toBe(false);
        expect(readAccountAgentProviderDeclarations({ kind: 'machine', projection: null })).toEqual([]);
        const required = projectProviderDeclarationDetail({ ...sample, definition: { ...sample.definition, catalog: detail.models } }, agents);
        expect(required.worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude')).toBe(false);
    });
});
