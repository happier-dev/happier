import { afterEach, expect, it, vi } from 'vitest';
import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { createPluginSkillSourceIdentityPublication } from './pluginSkillSourceIdentity';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiContributionSupplyV1 } from '@/sync/domains/plugins/ui/projectionOrigins';

afterEach(() => vi.restoreAllMocks());

it('observes only selected plugin declarations while retaining changes to those declarations', () => {
    const selected = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '1.0.0',
        definition: { id: 'selected', directory: './selected' } });
    const unrelated = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '1.0.0',
        definition: { id: 'other', directory: './other' } });
    const owner = createPluginSkillSourceIdentityPublication([selected.id]);
    const first = owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [selected.id]: selected } });
    expect(owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [selected.id]: selected, [unrelated.id]: unrelated } })).toBe(first);
    expect(owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [selected.id]: { ...selected, pluginVersion: '2.0.0' } } })).not.toBe(first);
});

it('invalidates the former revision fields without treating runtime generation or plugin labels as content', () => {
    const entry = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '1.0.0',
        definition: { id: 'check', directory: './resources/check' } });
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_skills',
        materializationRef: { machineId: 'supplier', pluginId: entry.pluginId, materializationId: 'installation' } });
    const otherOrigin = PluginMachineExecutionOriginV1Schema.parse({ ...origin, serverIdentityId: 'srv_other' });
    const supply: PluginUiContributionSupplyV1 = { machineId: 'supplier', serverId: 'server', phase: 'current',
        interactionEnabled: true, executionOrigin: origin, occurrenceId: 'runtime', pluginVersion: '1.0.0',
        sourceCustody: null, executionTargetDefault: false };
    const base = { ...entry, occurrenceId: 'runtime', executionOrigin: origin, hostOrigin: supply,
        hostCompatibility: 'compatible', hostSupplies: [supply] };
    const variants: readonly Partial<typeof base>[] = [
        { pluginVersion: '2.0.0' }, { definition: { ...entry.definition, directory: './resources/edited' } },
        { occurrenceId: 'replacement' }, { executionOrigin: otherOrigin }, { hostOrigin: { ...supply, executionOrigin: otherOrigin } },
        { hostCompatibility: 'conflict' },
        ...[{ machineId: 'other' }, { serverId: 'other' }, { occurrenceId: 'replacement' }, { pluginVersion: '2.0.0' },
            { executionOrigin: otherOrigin }, { phase: 'unavailable' as const }, { interactionEnabled: false }]
            .map(change => ({ hostSupplies: [{ ...supply, ...change }] })),
    ];
    for (const changed of variants) {
        const owner = createPluginSkillSourceIdentityPublication();
        const first = owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [entry.id]: base } });
        expect(owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [entry.id]: { ...base, ...changed } } })).not.toBe(first);
    }
    const owner = createPluginSkillSourceIdentityPublication();
    const first = owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [entry.id]: base } });
    const generationOnlyEntry = {
        ...base, pluginName: 'Presentation-only label', hostOrigin: { ...supply, generation: 999 },
        hostSupplies: [{ ...supply, generation: 999 }],
    };
    expect(owner.publish({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 999,
        skillsById: { [entry.id]: generationOnlyEntry } })).toBe(first);
    expect(owner.publish(null)).not.toBe(first);
});

it('retains the Skills source revision across supplying-generation-only publications', () => {
    const owner = createPluginSkillSourceIdentityPublication();
    const entry = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '1.0.0',
        definition: { id: 'check', directory: './resources/check' } });
    const supply = { machineId: 'supplier', serverId: 'server', phase: 'current' as const,
        interactionEnabled: true, executionOrigin: null, occurrenceId: 'runtime', pluginVersion: '1.0.0',
        sourceCustody: null, executionTargetDefault: false };
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [entry.id]: { ...entry, hostSupplies: [supply] } } };
    const first = owner.publish(projection);
    const generationOnlyProjection = { ...projection, generation: 999,
        skillsById: { [entry.id]: { ...entry, hostSupplies: [{ ...supply, generation: 999 }] } } };
    expect(owner.publish(generationOnlyProjection)).toBe(first);
});

it('reads the retained Skills source revision without serializing unchanged declaration facts', () => {
    const owner = createPluginSkillSourceIdentityPublication();
    const entry = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '1.0.0',
        definition: { id: 'check', directory: './resources/check' } });
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: Object.freeze({ [entry.id]: entry }) };
    const first = owner.publish(projection);
    const stringify = vi.spyOn(JSON, 'stringify');
    const entries = vi.spyOn(Object, 'entries');
    for (let generation = 1; generation <= 100; generation++) {
        expect(owner.publish(projection)).toBe(first);
        expect(owner.publish({ ...projection, generation })).toBe(first);
    }
    const calls = stringify.mock.calls.length;
    const walks = entries.mock.calls.filter(([value]) => value === projection.skillsById).length;
    console.info('Skills retained source reads', { reads: 200, serializations: calls, declarationWalks: walks });
    expect(calls).toBe(0);
    expect(walks).toBe(0);
    expect(owner.publish({ ...projection, skillsById: Object.freeze({ [entry.id]: {
        ...entry, pluginVersion: '2.0.0', definition: { ...entry.definition, directory: './resources/check-v2' },
    } }) })).not.toBe(first);
    expect(owner.publish(null)).not.toBe(first);
});
