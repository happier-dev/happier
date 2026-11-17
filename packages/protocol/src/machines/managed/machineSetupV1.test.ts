import { describe, expect, it } from 'vitest';
import { MachineSetupV1Schema, MachineSetupV1ReadSchema, mergeMachineSetupsV1, readMachineSetupAppIdentityV1 } from './machineSetupV1.js';
import { ManagedMachinePresetV1ReadSchema, ManagedMachinePresetCreateInputV1Schema } from './managedMachinePresetV1.js';
import { ManagedMachinePresetContentV1Schema } from './managedMachinePresetContentV1.js';
import { MachineSetupSourceV1Schema } from '../setup/machineSetupSourcesV1.js';

describe('MachineSetupV1', () => {
    it('retains catalog agent declarations through preset storage and merges duplicate selections once', () => {
        const setup = MachineSetupV1Schema.parse({ items: [{ kind: 'agent', agentId: 'catalog.example/agent' }] });
        expect(MachineSetupV1ReadSchema.parse(JSON.parse(JSON.stringify(setup)))).toEqual(setup);
        expect(mergeMachineSetupsV1([setup, setup])).toEqual({ ok: true, setup });
        const created = ManagedMachinePresetCreateInputV1Schema.parse({ homeId: 'home', id: 'agent-preset',
            owner: { kind: 'account', accountId: 'account' }, contentEncryptionMode: 'plain',
            content: { t: 'plain', v: { v: 1, name: 'Agent setup', setup,
                launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} } } },
            recipients: [], controller: { machineId: 'controller', installationId: 'installation' } });
        const read = ManagedMachinePresetV1ReadSchema.parse(JSON.parse(JSON.stringify({ ...created, revision: 1 })));
        expect(read.content).toMatchObject({ t: 'plain', v: { setup } });
        const source = { kind: 'accountPreset', presetId: 'agent-preset', presetRevision: 4,
            setupRevision: 2, contentEncryptionMode: 'plain', setup };
        const sources = [source, { kind: 'direct', setup: {} }];
        expect(MachineSetupSourceV1Schema.parse(sources)).toEqual(sources);
    });
    it('preserves an authored app continuity key through source copies and capture without inventing legacy keys', () => {
        const definition = { name: 'Dashboard', project: { kind: 'create' as const }, bindings: [],
            definition: { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] } };
        const item = { kind: 'app' as const, authoredKey: 'authored-dashboard', definition };
        const setup = MachineSetupV1Schema.parse({ items: [item] });
        const sources = MachineSetupSourceV1Schema.parse([{ kind: 'direct', setup }]);
        expect(mergeMachineSetupsV1(sources.map(source => source.setup)))
            .toEqual({ ok: true, setup: { items: [item] } });
        expect(readMachineSetupAppIdentityV1({ ...item, definition: { ...definition,
            definition: { ...definition.definition, document: 'services: {updated: {image: example}}' } } }))
            .toBe(readMachineSetupAppIdentityV1(item));
        expect(readMachineSetupAppIdentityV1({ ...item, authoredKey: 'another-authored-app' }))
            .not.toBe(readMachineSetupAppIdentityV1(item));
        expect(readMachineSetupAppIdentityV1({ kind: 'app', definition })).toBeUndefined();
        expect(MachineSetupV1ReadSchema.parse({ items: [{ kind: 'app', definition }] }).items?.[0])
            .not.toHaveProperty('authoredKey');
    });
    it('reads the retained single script once and emits only the canonical ordered list', () => {
        const body = '\r\necho retained\r\n';
        const check = { executable: '/usr/bin/test', args: ['-f', '/tmp/ready'], unsatisfiedExitCodes: [1] };
        expect(MachineSetupV1ReadSchema.parse({ setupScript: body, setupScriptAffects: 'none', setupScriptCheck: check }))
            .toEqual({ scripts: [{ body, affects: 'none', check }] });
        expect(MachineSetupV1ReadSchema.parse({ setupScript: '' })).toEqual({ scripts: [{ body: '' }] });
        expect(MachineSetupV1ReadSchema.parse({})).toEqual({});
        expect(MachineSetupV1Schema.safeParse({ setupScript: body }).success).toBe(false);
        expect(MachineSetupV1Schema.parse({ scripts: [{ body, affects: 'none', check }] }))
            .toEqual({ scripts: [{ body, affects: 'none', check }] });
    });
    it('captures both Presets scripts verbatim in source order through the one setup union', () => {
        const base = { homeId: 'home', revision: 1, owner: { kind: 'account', accountId: 'account' },
            contentEncryptionMode: 'plain' as const,
            content: { t: 'plain' as const, v: { v: 1 as const, name: 'Source',
                launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} } } },
            recipients: [], controller: { machineId: 'controller', installationId: 'installation' } };
        const first = ManagedMachinePresetV1ReadSchema.parse({ ...base, id: 'first',
            content: { ...base.content, v: { ...base.content.v,
                setup: { scripts: [{ body: '\r\necho first\r\n', affects: 'none' }] } } } });
        const check = { executable: '/usr/bin/test', args: ['-e', '/tmp/second'], unsatisfiedExitCodes: [1] };
        const second = ManagedMachinePresetV1ReadSchema.parse({ ...base, id: 'second',
            content: { ...base.content, v: { ...base.content.v,
                setup: { scripts: [{ body: 'echo second\r\n', check }] } } } });
        if (first.content.t !== 'plain' || second.content.t !== 'plain') throw new Error('Expected Plain preset bodies');
        const firstContent = ManagedMachinePresetContentV1Schema.parse(first.content.v);
        const secondContent = ManagedMachinePresetContentV1Schema.parse(second.content.v);
        const sources = MachineSetupSourceV1Schema.parse([
            { kind: 'accountPreset', presetId: first.id, presetRevision: first.revision,
                contentEncryptionMode: first.contentEncryptionMode, setup: firstContent.setup },
            { kind: 'accountPreset', presetId: second.id, presetRevision: second.revision,
                contentEncryptionMode: second.contentEncryptionMode, setup: secondContent.setup },
            { kind: 'direct', setup: {} },
        ]);
        const captured = mergeMachineSetupsV1(sources.map(source => source.setup));
        const scripts = [{ body: '\r\necho first\r\n', affects: 'none' }, { body: 'echo second\r\n', check }];
        expect(captured).toEqual({ ok: true, setup: { scripts } });
        if (!captured.ok) throw new Error('Expected captured setup');
        const { revision: _revision, ...creation } = base;
        const created = ManagedMachinePresetCreateInputV1Schema.parse({ ...creation, id: 'captured',
            content: { t: 'plain', v: { ...base.content.v, setup: captured.setup } } });
        expect(ManagedMachinePresetV1ReadSchema.parse(JSON.parse(JSON.stringify({ ...created, revision: 1 }))).content)
            .toEqual({ t: 'plain', v: { ...base.content.v, setup: { scripts } } });
    });
    it('retains inert Compose and pinned catalog app intent, never generated credentials or app references', () => {
        const base = { name: 'Dashboard', project: { kind: 'create' }, bindings: [
            { purpose: 'variable', name: 'PUBLIC_URL', phase: 'runtime', source: { kind: 'value', value: 'https://example.test' } },
            { purpose: 'variable', name: 'PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'password' } },
        ] };
        const compose = { ...base, definition: { from: 'compose', document: 'services: {}\r\n', profiles: [], services: [] } };
        const catalog = { ...base, project: { kind: 'existing', projectSourceId: 'project-1' }, definition: {
            from: 'catalogApp', templateRef: { sourceId: 'registry:example', itemId: 'dashboard', version: '1',
                ref: { kind: 'gitTree', repo: 'https://example.test/apps.git', path: 'dashboard', commit: 'abc', treeSha: 'def' } },
        } };
        for (const definition of [compose, catalog]) {
            const value = { items: [{ kind: 'app', definition }] };
            expect(MachineSetupV1Schema.safeParse(value).success).toBe(true);
            expect(MachineSetupV1ReadSchema.parse(value)).toEqual(value);
            expect(MachineSetupV1Schema.safeParse({ items: [{ kind: 'app', definition: { ...definition, environmentId: 'created' } }] }).success).toBe(false);
        }
        const addressed = { items: [{ kind: 'app', definition: { ...catalog,
            domainBindings: [{ templateDomainId: 'console', hostname: 'dashboard.example.test' }] } }] };
        expect(MachineSetupV1Schema.parse(addressed)).toEqual(addressed);
        expect(mergeMachineSetupsV1(MachineSetupSourceV1Schema.parse([{ kind: 'direct', setup: addressed }])
            .map(source => source.setup))).toEqual({ ok: true, setup: addressed });
        expect(MachineSetupV1ReadSchema.parse(addressed)).toEqual(addressed);
        expect(MachineSetupV1Schema.safeParse({ items: [{ kind: 'app', definition: { ...compose,
            domainBindings: addressed.items[0]!.definition.domainBindings } }] }).success).toBe(false);
        for (const source of [{ kind: 'generated', key: 'password', value: 'secret' }, { kind: 'secret', value: 'secret' }]) {
            expect(MachineSetupV1Schema.safeParse({ items: [{ kind: 'app', definition: { ...compose,
                bindings: [{ purpose: 'variable', name: 'PASSWORD', phase: 'runtime', source }] } }] }).success).toBe(false);
        }
        expect(MachineSetupV1Schema.safeParse({ items: [{ kind: 'app', definition: { ...catalog,
            definition: { ...catalog.definition, templateRef: { sourceId: 'registry:example', itemId: 'dashboard' } } } }] }).success).toBe(false);
    });
    it('keeps ordered exact recipe selections and retained script bodies in the existing setup value', () => {
        const selection = { ref: { pluginId: 'example.machine', recipeId: 'fonts', revision: '1' }, inputs: { family: 'sans' } };
        const setup = { items: [{ kind: 'setupRecipe', selection }, { kind: 'softwareRecipe', selection: {
            ...selection, ref: { ...selection.ref, recipeId: 'ffmpeg', revision: '2' }, inputs: {} } }],
            scripts: [{ body: '\r\necho prepared\r\n' }], toolchain: { adapterId: 'mise', config: '[tools]\nnode="22"\n' } };
        expect(MachineSetupV1Schema.safeParse(setup).success).toBe(true);
        expect(MachineSetupV1ReadSchema.parse(setup)).toEqual(setup);
        for (const item of [{ kind: 'setupRecipe', selection: { ...selection, ref: { ...selection.ref, revision: '' } } },
            { kind: 'softwareRecipe', selection: { ...selection, callback: 'install' } }, { kind: 'setupRecipe', selection: {
                ...selection, ref: { ...selection.ref, latest: true } } }]) {
            expect(MachineSetupV1Schema.safeParse({ items: [item] }).success).toBe(false);
        }
        for (const body of ['', 'echo unchanged', undefined]) {
            const retained = body === undefined ? {} : { scripts: [{ body }] };
            expect(MachineSetupV1Schema.parse(retained)).toEqual(retained);
        }
    });
});
