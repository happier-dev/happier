import { describe, expect, it } from 'vitest';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { projectAgentModelChoices, type AgentModelChoiceSource } from './projectAgentModelChoices';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

describe('shared background Agent/model choices', () => {
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'], acpCatalogSnapshot: {
        status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'codex', name: 'custom', title: 'Custom runner', launch: { kind: 'command', command: 'acp', args: [] }, createdAt: 1, updatedAt: 1,
        }] }),
    } });
    const models = [{ id: 'structured', name: 'Structured', costTier: 'low' as const, capabilities: { structuredOutput: 'supported' as const } },
        { id: 'text-only', name: 'Text', capabilities: { structuredOutput: 'unsupported' as const } }];
    const sources: readonly AgentModelChoiceSource[] = entries.map(entry => ({ entry, models, catalogModels: models, runnerCapable: true, discoverable: true }));
    const configuredKey = 'agent:happier.agent.custom-acp/custom-acp:definition:codex';

    it('keeps an installed Agent canonical key across offered, selected and default model profiles', () => {
        const [entry] = getResolvedBackendCatalogEntries({ enabledAgentIds: [], mergedProviderProjectionById: {
            'sample-agent': { agentId: 'sample-agent', identity: { pluginId: 'example.agent', localId: 'sample' }, title: 'Sample' },
        } });
        if (!entry) throw new Error('Expected the installed Agent catalog entry');
        const canonicalKey = 'agent:example.agent/sample';
        expect(entry.backendTargetKey).toBe(canonicalKey);
        const selected = ProviderBoundModelRefSchema.parse({ agentTargetKey: canonicalKey, providerConnectionId: null, modelId: 'custom/model' });
        const result = projectAgentModelChoices({ purpose: 'runner', sources: [{ entry, models, catalogModels: models,
            runnerCapable: true, discoverable: true }], selected, defaultModelTitle: 'Default' });
        const [group] = result.groups;
        expect(group?.targetKey).toBe(canonicalKey);
        expect(group?.offered.every(profile => profile.modelSelector?.backendTargetKey === canonicalKey)).toBe(true);
        expect(result.defaultProfile?.modelSelector).toEqual({ backendTargetKey: canonicalKey, modelId: 'default' });
        expect([...result.selections.values()].find(choice => choice.modelSelector.modelId === 'custom/model')?.modelSelection).toEqual(selected);
    });

    it('retains stale configured display models without admitting them as selectable models', () => {
        const result = projectAgentModelChoices({ purpose: 'runner',
            sources: sources.map(source => ({ ...source, selectable: source.entry.kind !== 'configuredBackend' })),
            defaultModelTitle: 'Default' });
        const group = result.groups.find(candidate => candidate.targetKey === configuredKey)!;
        expect(group.offered.length).toBeGreaterThan(0);
        expect(group.selectable).toBe(false);
        expect([...result.selections.values()].some(selection => selection.modelSelection.agentTargetKey === configuredKey)).toBe(false);
        expect(result.groups.find(candidate => candidate.entry.kind === 'builtInAgent')?.selectable).toBe(true);
    });

    it('offers only the executing catalog candidates and never defaults a signed-out static route', () => {
        const connectedProfiles = buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(configuredKey), models });
        const connected = projectAgentModelChoices({ purpose: 'walkthrough', sources, executableProfiles: connectedProfiles, automaticProfiles: [], defaultModelTitle: 'Default' });
        expect(connected.catalogProfiles).toEqual(connectedProfiles);
        expect(connected.defaultProfile).toBeNull();
        expect([...connected.selections.values()].every(selection => selection.modelSelection.agentTargetKey === configuredKey)).toBe(true);
        const native = sources.find(source => source.entry.kind === 'builtInAgent');
        if (!native) throw new Error('Expected native grouping metadata');
        const orderedProfiles = [...connectedProfiles, ...buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(native.entry.backendTarget), models })];
        const ordered = projectAgentModelChoices({ purpose: 'walkthrough', sources, executableProfiles: orderedProfiles,
            automaticProfiles: orderedProfiles.filter(profile => profile.modelSelector?.backendTargetKey !== configuredKey), defaultModelTitle: 'Default' });
        expect(ordered.defaultProfile?.modelSelector?.backendTargetKey).toBe(buildBackendTargetKeyV2(native.entry.backendTarget));
        expect(ordered.catalogProfiles).toEqual(orderedProfiles);
        for (const executableProfiles of [[], undefined]) {
            const unavailable = projectAgentModelChoices({ purpose: 'walkthrough', sources, executableProfiles, defaultModelTitle: 'Default' });
            expect(unavailable.defaultProfile).toBeNull();
            expect(unavailable.selections.size).toBe(0);
        }
    });

    it('shares grouping, cost/default facts and exact configured identity while filtering by purpose', () => {
        const selected = ProviderBoundModelRefSchema.parse({ agentTargetKey: configuredKey, providerConnectionId: null, modelId: 'custom/model' });
        const executableProfiles = sources.flatMap(source => buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(source.entry.backendTarget), models }));
        const walkthrough = projectAgentModelChoices({ purpose: 'walkthrough', sources, executableProfiles, automaticProfiles: executableProfiles, selected, defaultModelTitle: 'Default' });
        expect(walkthrough.groups).toHaveLength(2);
        expect(walkthrough.groups.every(group => group.offered.length === 1 && group.hiddenModelCount === 1)).toBe(true);
        expect(walkthrough.defaultProfile).toMatchObject({ costTier: 'low', modelSelector: { modelId: 'structured' } });
        expect([...walkthrough.selections.values()].some(choice => choice.modelSelection.modelId === 'custom/model')).toBe(false);
        const runner = projectAgentModelChoices({ purpose: 'runner', sources, selected, defaultModelTitle: 'Default' });
        const group = runner.groups.find(candidate => candidate.targetKey === configuredKey)!;
        expect(group.offered.map(model => model.modelSelector?.modelId)).toEqual(['default', 'structured', 'text-only', 'custom/model']);
        expect(group.customModelIdAllowed).toBe(true);
        const custom = [...runner.selections.values()].find(choice => choice.modelSelection.modelId === 'custom/model')!;
        expect(custom.backendTarget).toMatchObject({ backendId: 'codex', configuredBackendId: 'codex' });
        expect(custom.modelSelection).toEqual(selected);
        expect(runner.defaultProfile?.modelSelector).toMatchObject({ backendTargetKey: configuredKey, modelId: 'default' });
    });
    it('does not offer declared non-runner targets or substitute another target for an unavailable custom choice', () => {
        const selected = ProviderBoundModelRefSchema.parse({ agentTargetKey: configuredKey, providerConnectionId: null, modelId: 'custom/model' });
        const result = projectAgentModelChoices({ purpose: 'runner', sources: sources.map(source => ({ ...source, runnerCapable: false })), selected, defaultModelTitle: 'Default' });
        expect(result.groups).toEqual([]);
        expect(result.selections.size).toBe(0);
        expect(result.defaultProfile).toBeNull();
    });
});
