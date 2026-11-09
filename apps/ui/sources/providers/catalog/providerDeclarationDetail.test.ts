import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';

import { readAccountAgentProviderDeclarations, readAccountProviderDeclarations } from './accountProviderDeclarations';
import { projectAgentProviderRows, projectProviderDeclarationDetail } from './providerDeclarationDetail';

describe('Provider declaration details', () => {
    const agents = readAccountAgentProviderDeclarations({ kind: 'account' });
    const sample = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.id === 'deepseek')!;

    it('projects Provider rows only for the addressed Agent using the shared works-with evidence', () => {
        const claude = agents.filter(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude');
        const codex = agents.filter(agent => agent.agentTargetKey === 'agent:happier.agent.codex/codex');
        expect(projectAgentProviderRows([sample], claude)).toEqual([{
            declaration: sample, detail: projectProviderDeclarationDetail(sample, claude),
        }]);
        expect(projectAgentProviderRows([sample], codex)).toEqual([]);
        expect(projectAgentProviderRows([sample], [])).toEqual([]);
        const installed = { ...claude[0]!, agentTargetKey: 'agent:acme.agent/claude', name: 'Acme assistant' };
        expect(projectAgentProviderRows([sample], [installed])[0]?.detail.worksWith)
            .toMatchObject([{ agentTargetKey: installed.agentTargetKey, name: installed.name }]);
    });

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

    it('retains the declared credential authority for generic setup and review', () => {
        const authorityDescription = { key: 'credential.scope', fallback: 'This credential can run requests across the account.' };
        const declaration = { ...sample, definition: { ...sample.definition,
            credential: { ...sample.definition.credential!, authorityDescription,
                transports: sample.definition.credential!.transports.map(transport => ({ ...transport,
                    additionalCredentials: [{ slotId: 'upstreamKey', label: 'Upstream API key',
                        destination: { kind: 'httpHeader' as const, name: 'x-upstream-key', format: 'raw' as const } }],
                })),
            },
            catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
        } };
        const detail = projectProviderDeclarationDetail(declaration, []);
        expect(detail.auth).toMatchObject({ authorityDescription,
            additionalCredentials: [{ slotId: 'upstreamKey', label: 'Upstream API key', required: true }],
        });
    });

    it('uses model capability evidence rather than protocol overlap to establish an Agent fit', () => {
        const incompatible = { ...sample, definition: ProviderContributionV1Schema.parse({
            ...sample.definition, legacyProfileMigrations: undefined,
            catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'image', name: 'Image', capabilities: { toolRoundTrips: 'unsupported' } }] },
        }) };
        const detail = projectProviderDeclarationDetail(incompatible, agents);
        expect(detail.auth?.required).toBe(true);
        expect(detail.worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude')).toBe(false);
        expect(projectAgentProviderRows([incompatible], agents)).toEqual([]);
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
