import { expect, it, vi } from 'vitest';

import * as strictJson from '../../protocol/src/plugins/contributions/strictJsonValue.js';
import { defineProtocolObject, defineProtocolString } from '../../protocol/src/plugins/actions/protocolComposableSchema.js';
import { definePlugin } from './definePlugin.js';
import { defineContributionPoint, defineContributionProtocol } from './targetedContributionAuthoring.js';
import { parsePluginManifest } from './manifest.js';

it('captures author input without building unused Action descriptors or copying owned parsers', () => {
    const clones = vi.spyOn(strictJson, 'cloneStrictPluginJsonValue');
    try {
        const inputSchema = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
        const action = { title: 'Read', surfaces: ['plugin'] as const, inputSchema, run: () => undefined };
        const plugin = definePlugin({ id: 'test.cold-schema', version: '1.0.0', actions: { read: action } });
        action.title = 'Changed after capture';
        const documents = () => clones.mock.calls.filter(([, path]) => path === 'schema').length;
        console.info('cold-plugin-schema-documents', documents());
        expect(plugin.actionContracts.read.localId).toBe('read');
        expect(documents()).toBe(0);
        expect(plugin.manifest.id).toBe('test.cold-schema');
        const contributes = plugin.manifest.contributes;
        expect(contributes.actions?.[0]?.title).toBe('Read');
        expect(contributes.actions?.[0]?.inputSchema).toBe(inputSchema.jsonSchema);
        expect(plugin.manifest.contributes).toBe(contributes);
        const afterFirstRead = documents();
        expect(afterFirstRead).toBeGreaterThan(0);
        expect(JSON.parse(JSON.stringify(plugin.manifest)).contributes.actions[0].inputSchema)
            .toEqual(inputSchema.jsonSchema);
        expect(documents()).toBe(afterFirstRead);
    } finally {
        clones.mockRestore();
    }
});

it('retains contribution point identities without projecting their unused schema documents', () => {
    const clones = vi.spyOn(strictJson, 'cloneStrictPluginJsonValue');
    try {
        const schema = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
        const action: { surfaces: readonly ['plugin']; dangerLevel: 'safe' | 'writesRemote' } = {
            surfaces: ['plugin'], dangerLevel: 'safe',
        };
        const operations = { read: { required: true, input: { kind: 'protocolDefined', schema },
            resultSchema: schema, action } } as const;
        const one = defineContributionProtocol({ id: 'cold-point', version: 1, operations });
        const two = defineContributionProtocol({ id: 'cold-point', version: 2, operations });
        action.dangerLevel = 'writesRemote';
        const plugin = definePlugin({ id: 'test.cold-point-owner', version: '1.0.0', contributionPoints: {
            single: one.point(), combined: defineContributionPoint([one, two]),
        } });
        expect(plugin.contributionPoints.single.protocol).toEqual({ id: 'cold-point', version: 1 });
        expect(clones.mock.calls.filter(([, path]) => path === 'schema')).toHaveLength(0);
        const parsed = parsePluginManifest(structuredClone(plugin.manifest));
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        expect(parsed.manifest.contributes.pluginContributionPoints).toHaveLength(2);
        expect(parsed.manifest.contributes.pluginContributionPoints?.[0]?.protocols[0]?.operations.read?.action.dangerLevel).toBe('safe');
        const afterRead = clones.mock.calls.length;
        expect(plugin.manifest).toBe(plugin.manifest);
        expect(clones.mock.calls).toHaveLength(afterRead);
    } finally {
        clones.mockRestore();
    }
});
