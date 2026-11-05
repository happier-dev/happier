import { readManagedMachineActionOutputV1 } from '@/sync/api/machines/managedMachineResponse';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MachineProvisionerContributionV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedCredentialSelectionV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { PluginJsonValueV2Schema, type PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { normalizePluginActionInputHintsV2, PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { FlyLaunchQueryV1Schema, FlyLaunchV1Schema } from '../../../../../../../packages/plugins/machine-fly/src/machine/schemas';
import { CRABBOX_PLUGIN } from '../../../../../../../packages/plugins/machine-crabbox/src/manifest';
import { CUA_PLUGIN } from '../../../../../../../packages/plugins/machine-cua/src/manifest';
import { DEVCONTAINER_PLUGIN } from '../../../../../../../packages/plugins/devcontainer/src/manifest';
import { resolveHappierActionFieldPresentation } from '@happier-dev/plugin-ui/presentation';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, selectManagedConfiguratorDimension, managedConfiguratorDimensionSelection, managedConfiguratorDimensionChoices, managedConfiguratorFacts, managedConfiguratorAcquireInput, managedConfiguratorOptionsSelectors, setManagedConfiguratorOptionsSelectors, managedConfiguratorCredentialSelections, managedConfiguratorRetentionCapabilities } from './managedConfiguratorModel';

const descriptor = MachineProvisionerContributionV1Schema.parse({
    id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
    launchSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, required: ['cpu'], additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
});
const provisioner = { contribution: { pluginId: 'custom.compute', localId: 'vm' }, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, descriptor };
const controller = { machineId: 'host', installationId: 'installation' };

const emptyDimensions = () => ({ size: [], image: [], location: [], network: [], duration: [] });
const options = {
    base: { launch: {} },
    dimensions: { ...emptyDimensions(), size: [
        { id: 'small', title: 'Small', assignments: [{ path: 'cpu', value: 2 }], nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 2 } },
            prices: [{ amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }] },
        { id: 'large', title: 'Large', assignments: [{ path: 'cpu', value: 4 }], nativeFacts: { size: { id: 'large', title: 'Large', cpuCores: 4 } } },
    ] },
};
const fresh = (name = 'Guest') => createManagedConfiguratorDraft({ provisioner, controller, name });
const small = () => selectManagedConfiguratorDimension(refreshManagedConfiguratorOptions(fresh(), options), 'size', 'small');

describe('managed configurator draft owner', () => {
    it('reads candidate entries only once per sizing row instead of rescanning sibling launches', () => {
        const count = 256;
        const entries = Array.from({ length: count }, (_, index) => ({ id: `native-${index}`, title: `Native ${index}`,
            assignments: [{ path: 'cpu', value: index + 1 }] }));
        let elementReads = 0;
        // Instrument real array access, not the projector: rendering N rows must
        // consume N catalog entries, not perform N full-catalog id searches.
        const observed = new Proxy(entries, { get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) elementReads++;
            return Reflect.get(target, key, receiver);
        } });
        const draft = { ...fresh(), options: { base: { launch: {} }, dimensions: { ...emptyDimensions(), size: observed } }, dimensionSelection: {} };
        const rows = managedConfiguratorDimensionChoices(draft, 'size');
        expect(rows).toHaveLength(count);
        expect(rows[0]?.choice.nativeFacts?.size?.id).toBe('native-0');
        expect(rows.at(-1)?.choice.nativeFacts?.size?.id).toBe(`native-${count - 1}`);
        expect(elementReads).toBe(count);
    });
    it('retains a legacy complete-choice identity when native sizes coincide and the reviewed row disappears', () => {
        const read = (choices: unknown[]) => {
            const result = readManagedMachineActionOutputV1('machines.provisioners.options', { choices });
            if (!result.success) throw new Error('Legacy catalog not admitted');
            return result.data;
        };
        const choices = [{ id: 'linux-west', title: 'Linux west', launch: { cpu: 2 },
            nativeFacts: { size: { id: 'native-size', title: 'Native size', cpuCores: 2 }, image: { id: 'linux', title: 'Linux' } } },
        { id: 'windows-east', title: 'Windows east', launch: { cpu: 4 },
            nativeFacts: { size: { id: 'native-size', title: 'Native size', cpuCores: 4 }, image: { id: 'windows', title: 'Windows' } } }];
        const selected = selectManagedConfiguratorDimension(refreshManagedConfiguratorOptions(fresh(), read(choices)), 'size', 'windows-east');
        expect(managedConfiguratorDimensionSelection(selected)).toEqual({ size: 'windows-east' });
        expect(selected.selected?.nativeFacts?.size?.id).toBe('native-size');
        expect(managedConfiguratorAcquireInput(selected, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 4 } } });
        const changed = refreshManagedConfiguratorOptions(selected, read([choices[0]!]));
        expect(managedConfiguratorAcquireInput(changed, 'home')).toBeNull();
        expect(changed.selected?.launch).toEqual({ cpu: 4 });
        expect(managedConfiguratorDimensionChoices(changed, 'size').map(row => [row.choice.id, row.choice.title, row.available]))
            .toEqual([['linux-west', 'Linux west', true], ['windows-east', 'Windows east', false]]);
    });
    it('selects the sole size a free-form host echoes from the form it was asked with, and only that one', () => {
        // Cua-style: the form's CPU field is the size; the read answers with one size assigning what the form sent.
        const echo = { base: { launch: {} }, dimensions: { ...emptyDimensions(), size: [{ id: '2cpu', title: '2 CPU',
            assignments: [{ path: 'cpu', value: 2 }], nativeFacts: { size: { id: '2cpu', title: '2 CPU', cpuCores: 2 } } }] } };
        expect(managedConfiguratorDimensionSelection(refreshManagedConfiguratorOptions(fresh(), echo, { cpu: 2 }))).toEqual({ size: '2cpu' });
        expect(managedConfiguratorAcquireInput(refreshManagedConfiguratorOptions(fresh(), echo, { cpu: 2 }), 'home')?.selection)
            .toMatchObject({ launch: { choices: { cpu: 2 } } });
        // A form that asked for something else, or no form at all, doesn't make that size the person's choice.
        expect(managedConfiguratorDimensionSelection(refreshManagedConfiguratorOptions(fresh(), echo, { cpu: 4 }))).toEqual({});
        expect(managedConfiguratorDimensionSelection(refreshManagedConfiguratorOptions(fresh(), echo))).toEqual({});
    });
    it('admits a fully qualified form base with matching singleton facts without redundant picks', () => {
        const draft = refreshManagedConfiguratorOptions(fresh(), { base: { launch: { cpu: 2 } }, dimensions: {
            ...emptyDimensions(), size: [{ id: 'native', title: 'Native sizing', assignments: [],
                nativeFacts: { size: { id: 'native', title: 'Native sizing', cpuCores: 2 } } }],
            image: [{ id: 'linux', title: 'Linux', assignments: [] }],
        } });
        expect(managedConfiguratorDimensionSelection(draft)).toEqual({ size: 'native', image: 'linux' });
        expect(managedConfiguratorAcquireInput(draft, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 2 } } });
        const failedEdit = refreshManagedConfiguratorOptions(setManagedConfiguratorOptionsSelectors(draft, { cpu: 4 }), {
            dimensions: emptyDimensions(), code: 'provider_unavailable',
        });
        expect(failedEdit.selected?.launch).toEqual({ cpu: 2 });
        expect(managedConfiguratorAcquireInput(failedEdit, 'home')).toBeNull();
        const changed = refreshManagedConfiguratorOptions(failedEdit, {
            base: { launch: { cpu: 4 } }, dimensions: { ...emptyDimensions(),
                size: [{ id: 'updated', title: 'Updated native sizing', assignments: [], nativeFacts: { size: { id: 'updated', title: 'Updated native sizing', cpuCores: 4 } } }],
                image: [{ id: 'linux', title: 'Linux', assignments: [] }],
            },
        });
        expect(managedConfiguratorAcquireInput(changed, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 4 } } });
        const drifted = refreshManagedConfiguratorOptions(changed, { base: { launch: { cpu: 8 } }, dimensions: {
            ...emptyDimensions(), size: [{ id: 'updated', title: 'Updated native sizing', assignments: [] }],
            image: [{ id: 'linux', title: 'Linux', assignments: [] }],
        } });
        expect(drifted.selected?.launch).toEqual({ cpu: 4 });
        expect(managedConfiguratorAcquireInput(drifted, 'home')).toBeNull();
        const incomplete = refreshManagedConfiguratorOptions(fresh(), options);
        expect(managedConfiguratorAcquireInput(incomplete, 'home')).toBeNull();
    });
    it('projects independent dimensions once, including partial prices, constraints and the visible network default', () => {
        const price = { amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 };
        const catalog = {
            base: { launch: {} },
            dimensions: {
                size: [{ id: 'small', title: 'Small', assignments: [{ path: 'cpu', value: 2 }], nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 2 } }, prices: [price] },
                    { id: 'large', title: 'Large', assignments: [{ path: 'cpu', value: 4 }], nativeFacts: { size: { id: 'large', title: 'Large', cpuCores: 4 } } }],
                image: [], location: [{ id: 'west', title: 'West', assignments: [], nativeFacts: { location: { id: 'west', title: 'West' } } },
                    { id: 'east', title: 'East', assignments: [], nativeFacts: { location: { id: 'east', title: 'East' } } }],
                network: [{ id: 'ipv4', title: 'IPv4', assignments: [], nativeFacts: { network: { id: 'ipv4', title: 'IPv4' } },
                    prices: [{ ...price, amount: '0.001', when: [{ dimension: 'location' as const, optionIds: ['west'] }] }] }], duration: [],
            },
            constraints: [{ when: { dimension: 'size' as const, optionIds: ['large'] }, requires: { dimension: 'location' as const, optionIds: ['east'] } }],
        };
        const loaded = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner, controller, name: 'Guest' }), catalog);
        expect(managedConfiguratorDimensionSelection(loaded)).toEqual({ network: 'ipv4' });
        expect(managedConfiguratorDimensionChoices(loaded, 'size')).toHaveLength(2);
        expect(managedConfiguratorDimensionChoices(loaded, 'size')[0]?.choice.prices).toEqual([price]);
        const picked = selectManagedConfiguratorDimension(selectManagedConfiguratorDimension(loaded, 'size', 'small'), 'location', 'west');
        expect(managedConfiguratorAcquireInput(picked, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 2 } } });
        expect(managedConfiguratorFacts(picked)?.prices?.map(value => value.amount)).toEqual(['0.005', '0.001']);
        expect(managedConfiguratorDimensionChoices(picked, 'size')[1]).toMatchObject({ available: false, selectable: true });
        const incompatible = selectManagedConfiguratorDimension(picked, 'size', 'large');
        expect(managedConfiguratorAcquireInput(incompatible, 'home')).toBeNull();
        const east = selectManagedConfiguratorDimension(incompatible, 'location', 'east');
        expect(managedConfiguratorAcquireInput(east, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 4 } } });
        expect(managedConfiguratorFacts(east)?.prices).toBeUndefined();
    });
    it('consumes a pending form edit when dimension picks complete its native review', () => {
        const dimensions = { ...emptyDimensions(), size: [{ id: 'small', title: 'Small', assignments: [] }],
            image: [{ id: 'linux', title: 'Linux', assignments: [] }, { id: 'debian', title: 'Debian', assignments: [] }] };
        const pending = refreshManagedConfiguratorOptions(setManagedConfiguratorOptionsSelectors(small(), { cpu: 4 }), {
            base: { launch: { cpu: 4 } }, dimensions,
        });
        expect(managedConfiguratorAcquireInput(pending, 'home')).toBeNull();
        const reviewed = selectManagedConfiguratorDimension(pending, 'image', 'linux');
        expect(managedConfiguratorAcquireInput(reviewed, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 4 } } });
        const drifted = refreshManagedConfiguratorOptions(reviewed, { base: { launch: { cpu: 8 } }, dimensions });
        expect(drifted.selected?.launch).toEqual({ cpu: 4 });
        expect(managedConfiguratorAcquireInput(drifted, 'home')).toBeNull();
    });
    it('admits a Devcontainer review query entered through its declared shared Action fields', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners?.[0]);
        const action = PluginActionContributionV2Schema.parse(DEVCONTAINER_PLUGIN.manifest.contributes.actions?.find(action => action.id === descriptor.actions.options));
        const values = { workspaceFolder: '/projects/source', configPath: '/projects/source/.devcontainer/devcontainer.json' };
        let selectors: Readonly<Record<string, unknown>> = {};
        for (const field of resolveEffectiveActionInputFields({ inputHints: normalizePluginActionInputHintsV2(action.inputHints) }, {})) {
            selectors = writeInputPath(selectors, field.path, values[field.path as keyof typeof values]);
        }
        const draft = setManagedConfiguratorOptionsSelectors(createManagedConfiguratorDraft({
            provisioner: { contribution: { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: descriptor.id }, occurrenceId: 'devcontainer', acquireExecutionTarget: 'daemon' as const, descriptor },
            controller, name: 'Project child',
        }), selectors);
        expect(managedConfiguratorOptionsSelectors(draft, action.inputSchema!)).toEqual(values);
    });
    it('starts a Cua sandbox launch from the provider\u2019s declared size defaults, so its options read is complete without typing', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(CUA_PLUGIN.manifest.contributes.machineProvisioners?.find(entry => entry.id === 'local-sandbox'));
        const action = PluginActionContributionV2Schema.parse(CUA_PLUGIN.manifest.contributes.actions?.find(entry => entry.id === descriptor.actions.options));
        const hints = normalizePluginActionInputHintsV2(action.inputHints);
        const draft = createManagedConfiguratorDraft({ provisioner: { contribution: { pluginId: CUA_PLUGIN.manifest.id, localId: descriptor.id }, occurrenceId: 'cua', acquireExecutionTarget: 'daemon' as const, descriptor },
            controller, name: 'Sandbox' });
        expect(managedConfiguratorOptionsSelectors(draft, action.inputSchema!)).toEqual({});
        expect(managedConfiguratorOptionsSelectors(draft, action.inputSchema!, hints)).toEqual({ size: { cpu: 2, memoryBytes: 4 * 1024 ** 3 } });
        // What the person typed wins over the default; an unfilled field is still seeded.
        const edited = setManagedConfiguratorOptionsSelectors(draft, { size: { cpu: 8 } });
        expect(managedConfiguratorOptionsSelectors(edited, action.inputSchema!, hints)).toEqual({ size: { cpu: 8, memoryBytes: 4 * 1024 ** 3 } });
    });
    it('resolves the Cua sandbox options request from the generated bundled manifest projection, not null', () => {
        const projected = JSON.parse(readFileSync(new URL('../../../../../../cli/assets/bundled-plugin-manifests/machine-cua.json', import.meta.url), 'utf8'));
        const descriptor = MachineProvisionerContributionV1Schema.parse(projected.contributes.machineProvisioners.find((entry: { id: string }) => entry.id === 'local-sandbox'));
        const action = PluginActionContributionV2Schema.parse(projected.contributes.actions.find((entry: { id: string }) => entry.id === descriptor.actions.options));
        const hints = normalizePluginActionInputHintsV2(action.inputHints);
        const draft = createManagedConfiguratorDraft({ provisioner: { contribution: { pluginId: projected.id, localId: descriptor.id }, occurrenceId: 'cua', acquireExecutionTarget: 'daemon' as const, descriptor },
            controller, name: 'Sandbox' });
        expect(managedConfiguratorOptionsSelectors(draft, action.inputSchema!, hints)).toEqual({ size: { cpu: 2, memoryBytes: 4 * 1024 ** 3 } });
    });
    it('shows the Cua sandbox memory in GiB while the stored and submitted value stays bytes, and leaves unlabelled integers raw', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(CUA_PLUGIN.manifest.contributes.machineProvisioners?.find(entry => entry.id === 'local-sandbox'));
        const action = PluginActionContributionV2Schema.parse(CUA_PLUGIN.manifest.contributes.actions?.find(entry => entry.id === descriptor.actions.options));
        const fields = resolveEffectiveActionInputFields({ inputHints: normalizePluginActionInputHintsV2(action.inputHints) }, {});
        const memory = fields.find(field => field.path === 'size.memoryBytes');
        const cpu = fields.find(field => field.path === 'size.cpu');
        if (!memory || !cpu) throw new Error('The Cua sandbox options declare memory and CPU');
        const shown = resolveHappierActionFieldPresentation(memory, memory.defaultValue);
        expect(shown).toMatchObject({ kind: 'text', value: '4' });
        expect(shown.kind === 'text' && shown.parseText('8')).toBe(8 * 1024 ** 3);
        const rawCpu = resolveHappierActionFieldPresentation(cpu, 2);
        expect(rawCpu.kind === 'text' && [rawCpu.value, rawCpu.parseText('4')]).toEqual(['2', 4]);
    });
    it('keeps actual Fly volume branch switches queryable without rewriting the retained launch', () => {
        const fly = { ...provisioner, contribution: { pluginId: 'happier.machine.fly', localId: 'fly' },
            descriptor: { ...descriptor, launchSchema: FlyLaunchV1Schema.jsonSchema } };
        const base = { app: { name: 'reviewed-app', ownership: 'existing', organizationSlug: 'reviewed-org' },
            region: 'iad', guest: { cpuKind: 'shared', cpus: 2, memoryMb: 1024 } };
        for (const [original, nextKind, nextField, nextValue] of [
            [{ kind: 'create', sizeGb: 10 }, 'attach', 'volume.volumeId', 'reviewed-volume'],
            [{ kind: 'attach', volumeId: 'reviewed-volume' }, 'create', 'volume.sizeGb', 20],
        ] as const) {
            const launch = PluginJsonValueV2Schema.parse({ ...base, volume: original });
            if (!launch || typeof launch !== 'object' || Array.isArray(launch)) throw new Error('Expected a native Fly launch object');
            const saved = { ...createManagedConfiguratorDraft({ provisioner: fly, controller, name: 'Saved Fly',
                preset: { id: 'fly-preset', revision: 1 } }), selected: { id: 'preset:fly-preset', title: 'Saved Fly', launch } };
            expect(managedConfiguratorOptionsSelectors(saved, FlyLaunchQueryV1Schema.jsonSchema)).toEqual(launch);
            // The same generic field owner preserves hidden sibling values when the discriminant changes.
            const query = writeInputPath(writeInputPath(launch, 'volume.kind', nextKind), nextField, nextValue);
            const edited = setManagedConfiguratorOptionsSelectors(saved, query);
            expect(managedConfiguratorOptionsSelectors(edited, FlyLaunchQueryV1Schema.jsonSchema)).toEqual(query);
            expect(edited.selected?.launch).toEqual(launch);
            expect(managedConfiguratorAcquireInput(edited, 'home')).toBeNull();
            // Persisted executable launches stay closed; only the declared draft query can accept inactive fields.
            expect(FlyLaunchV1Schema.safeParse(query).success).toBe(false);
        }
    });

    it('projects frozen native values into an independent mutable wire snapshot', () => {
        const launch = { sizes: [2, 4] };
        Object.freeze(launch.sizes);
        Object.freeze(launch);
        const native = { ...provisioner, descriptor: { ...descriptor, launchSchema: {
            type: 'object', properties: { sizes: { type: 'array', items: { type: 'integer' } } },
            required: ['sizes'], additionalProperties: false,
        } satisfies PluginJsonSchemaV2 } };
        const draft = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: native, controller, name: 'Guest' }),
            { base: { launch }, dimensions: emptyDimensions() });
        const choices = managedConfiguratorFacts(draft)?.launch.choices;
        if (!choices || typeof choices !== 'object' || Array.isArray(choices) || !Array.isArray(choices.sizes)) throw new Error('Expected native sizes');
        choices.sizes.push(8);
        expect(choices.sizes).toEqual([2, 4, 8]);
        expect(draft.selected?.launch).toEqual({ sizes: [2, 4] });
    });

    it('uses a validated scalar base without inventing object selectors', () => {
        const native = { ...provisioner, descriptor: { ...descriptor, launchSchema: { type: 'string', enum: ['small'] } satisfies PluginJsonSchemaV2 } };
        const draft = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: native, controller, name: 'Guest' }),
            { base: { launch: 'small' }, dimensions: emptyDimensions() });
        expect(managedConfiguratorAcquireInput(draft, 'home')?.selection).toMatchObject({ launch: { choices: 'small' } });
    });

    it('keeps a saved selection and its prices when a refresh removes it, until an explicit replacement is chosen', () => {
        const selected = small();
        const removed = refreshManagedConfiguratorOptions(selected, { ...options, dimensions: { ...options.dimensions, size: options.dimensions.size.slice(1) } });
        expect(removed.selected).toEqual(selected.selected);
        expect(managedConfiguratorFacts(removed)?.optionStatus).toBe('unavailable');
        expect(managedConfiguratorFacts(removed)?.prices?.[0]?.amount).toBe('0.005');
        expect(managedConfiguratorAcquireInput(removed, 'home')).toBeNull();
        expect(managedConfiguratorDimensionChoices(removed, 'size').find(row => row.choice.id === 'small')).toMatchObject({ available: false, selectable: false });
        const reviewed = selectManagedConfiguratorDimension(removed, 'size', 'large');
        expect(managedConfiguratorAcquireInput(reviewed, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 4 } } });
        expect(managedConfiguratorFacts(reviewed)?.prices).toBeUndefined();
    });

    it('recovers the independent selector ids of an exact saved launch without replacing an unavailable launch', () => {
        const saved = { ...createManagedConfiguratorDraft({ provisioner, controller, name: 'Saved', preset: { id: 'saved', revision: 3 } }),
            selected: { id: 'preset:saved', title: 'Saved', launch: { cpu: 2 } } };
        const refreshed = refreshManagedConfiguratorOptions(saved, options);
        expect(managedConfiguratorDimensionSelection(refreshed)).toEqual({ size: 'small' });
        expect(managedConfiguratorFacts(refreshed)?.optionStatus).toBe('current');
        expect(managedConfiguratorFacts(refreshed)?.nativeFacts?.size?.cpuCores).toBe(2);
        const unavailable = refreshManagedConfiguratorOptions(saved, { ...options, dimensions: { ...options.dimensions, size: options.dimensions.size.slice(1) } });
        expect(unavailable.selected).toEqual(saved.selected);
        expect(managedConfiguratorAcquireInput(unavailable, 'home')).toBeNull();
    });

    it('revalidates saved sizing through only the declared same-path options schema', () => {
        const schema = { type: 'object', properties: { imageId: { type: 'string' }, size: { type: 'object', properties: {
            cpu: { type: 'integer', minimum: 1 } }, required: ['cpu'], additionalProperties: false } }, additionalProperties: false } satisfies PluginJsonSchemaV2;
        const launch = { on: 'local', imageId: 'linux', size: { cpu: 4 } };
        const saved = { ...createManagedConfiguratorDraft({ provisioner, controller, name: 'Saved', preset: { id: 'saved', revision: 3 } }),
            selected: { id: 'preset:saved', title: 'Saved', launch } };
        expect(managedConfiguratorOptionsSelectors(saved, schema)).toEqual({ imageId: 'linux', size: { cpu: 4 } });
        expect(managedConfiguratorOptionsSelectors({ ...saved, optionsSelectors: launch }, schema)).toBeNull();
        const edited = setManagedConfiguratorOptionsSelectors(small(), { imageId: 'new', size: { cpu: 8 } });
        expect(managedConfiguratorAcquireInput(edited, 'home')).toBeNull();
        expect(edited.selected?.launch).toEqual({ cpu: 2 });
        expect(managedConfiguratorOptionsSelectors(edited, schema)).toEqual({ imageId: 'new', size: { cpu: 8 } });
    });

    it('qualifies selected BYOC retention and native duration without a host provider branch', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(CUA_PLUGIN.manifest.contributes.machineProvisioners?.find(entry => entry.id === 'byoc'));
        for (const cloud of ['modal', 'aws', 'gcp'] as const) {
            const finite = cloud === 'modal';
            const launch = PluginJsonValueV2Schema.parse({ cloud, region: 'west', nativeImageId: 'linux', nativeSizeId: 'native-size',
                nativeLifetime: finite ? { kind: 'finite', durationSeconds: 7200 } : { kind: 'no-native-ttl' } });
            const retention = finite ? { supportedIntents: ['delete' as const], finiteOnly: true } : { supportedIntents: ['start' as const, 'stop' as const, 'delete' as const], finiteOnly: false };
            const draft = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({
                provisioner: { contribution: { pluginId: CUA_PLUGIN.manifest.id, localId: descriptor.id }, occurrenceId: 'byoc', acquireExecutionTarget: 'daemon' as const, descriptor }, controller, name: 'BYOC',
                preset: { id: 'saved', revision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true },
            }), { base: { launch, retention, ...(finite ? { nativeFacts: { duration: { id: '7200', title: '2 hours', afterMs: 7_200_000 } } } : {}) }, dimensions: emptyDimensions() });
            const facts = managedConfiguratorFacts(draft);
            expect(facts?.retentionCapabilities).toEqual(retention);
            expect(facts?.retention.kind).toBe(finite ? 'unused' : 'until-delete');
            expect(facts?.wakeOnAcceptedMessage).toBe(!finite);
            expect(managedConfiguratorAcquireInput(draft, 'home')?.reviewedFacts?.retentionCapabilities).toEqual(retention);
            if (finite) expect(facts?.nativeFacts?.duration?.afterMs).toBe(7_200_000);
        }
    });

    it('selects native duration alternatives through the same projection and captures the exact expiry fact', () => {
        const native = { ...provisioner, descriptor: { ...descriptor, retention: { supportedIntents: ['delete' as const], finiteOnly: true } } };
        const draft = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: native, controller, name: 'Lease' }), {
            base: { launch: {} }, dimensions: { ...emptyDimensions(), duration: [
                { id: 'short', title: '1 hour', assignments: [{ path: 'cpu', value: 2 }], nativeFacts: { duration: { id: 'short', title: '1 hour', afterMs: 3_600_000 } } },
                { id: 'long', title: '2 hours', assignments: [{ path: 'cpu', value: 4 }], nativeFacts: { duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } } },
            ] },
        });
        expect(managedConfiguratorAcquireInput(draft, 'home')).toBeNull();
        const selected = selectManagedConfiguratorDimension(draft, 'duration', 'long');
        expect(managedConfiguratorFacts(selected)?.nativeFacts?.duration?.afterMs).toBe(7_200_000);
        expect(managedConfiguratorAcquireInput(selected, 'home')).toMatchObject({ selection: { launch: { choices: { cpu: 4 } },
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false } });
    });
    it('exposes selected native retention before duration selection so a finite launch can complete', () => {
        const retention = { supportedIntents: ['delete' as const], finiteOnly: true };
        const draft = refreshManagedConfiguratorOptions(fresh(), { base: { launch: { cpu: 2 }, retention }, dimensions: {
            ...emptyDimensions(), duration: [{ id: 'short', title: '1 hour', assignments: [],
                nativeFacts: { duration: { id: 'short', title: '1 hour', afterMs: 3_600_000 } } },
                { id: 'long', title: '2 hours', assignments: [], nativeFacts: { duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } } }],
        } });
        expect(draft.selected).toBeNull();
        expect(managedConfiguratorRetentionCapabilities(draft)).toEqual(retention);
    });

    it('captures every labelled native charge without dropping attachments or converting units', () => {
        const prices = [{ amount: '3.75', currency: 'EUR', unit: 'month', source: 'native', observedAt: 20, label: 'Compute' },
            { amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: 30, label: 'IPv4' },
            { amount: '0.04', currency: 'USD', unit: 'GiB-month', source: 'native-storage', observedAt: 40, label: 'Volume' }];
        const draft = refreshManagedConfiguratorOptions(fresh(), { base: { launch: { cpu: 2 }, prices }, dimensions: emptyDimensions() });
        expect(managedConfiguratorFacts(draft)).toMatchObject({ prices });
        expect(managedConfiguratorAcquireInput(draft, 'home')?.reviewedFacts?.prices).toEqual(prices);
    });

    it('preserves qualified Account credentials through a saved launch refresh and a different size', () => {
        const credential = ManagedCredentialSelectionV1Schema.parse({ purpose: { consumer: provisioner.contribution, purpose: 'provision' },
            account: { service: { pluginId: 'custom.compute', localId: 'connection' }, accountId: 'selected-account' } });
        const saved = { ...createManagedConfiguratorDraft({ provisioner, controller, name: 'Saved', credentials: [credential], preset: { id: 'saved', revision: 1 } }),
            selected: { id: 'preset:saved', title: 'Saved', launch: { cpu: 2 } } };
        const refreshed = refreshManagedConfiguratorOptions(saved, options);
        expect(managedConfiguratorFacts(refreshed)?.launch.credentials).toEqual([credential]);
        const acquired = managedConfiguratorAcquireInput(selectManagedConfiguratorDimension(refreshed, 'size', 'large'), 'home');
        expect(acquired?.selection).toMatchObject({ kind: 'one-off', homeId: 'home', launch: { choices: { cpu: 4 }, credentials: [credential] } });
        expect(acquired?.reviewedFacts?.launch).toMatchObject({ choices: { cpu: 4 }, credentials: [credential] });
    });

    it('uses current descriptor credential requirements without disclosing a waived Crabbox credential', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(CRABBOX_PLUGIN.manifest.contributes.machineProvisioners?.[0]);
        const contribution = { pluginId: CRABBOX_PLUGIN.manifest.id, localId: descriptor.id };
        const credential = { purpose: { consumer: contribution, purpose: 'crabbox-coordinator' }, account: {
            service: { pluginId: contribution.pluginId, localId: 'coordinator' }, accountId: 'reviewed-coordinator' } };
        const crabbox = { contribution, occurrenceId: 'crabbox', acquireExecutionTarget: 'daemon' as const, descriptor,
            credentialPurposes: [{ purpose: credential.purpose, options: [{ value: credential.account, label: 'Coordinator' }] }] };
        const launch = { backendId: 'local-container', transport: 'direct', namespace: 'local', target: 'linux', nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
        const direct = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: crabbox, controller, name: 'Local', credentials: [credential] }),
            { base: { launch }, dimensions: emptyDimensions() });
        expect(managedConfiguratorCredentialSelections(direct, crabbox)).toEqual([]);
        expect(managedConfiguratorFacts(direct)?.launch.credentials ?? []).toEqual([]);
        expect(managedConfiguratorAcquireInput(direct, 'home')?.selection).toMatchObject({ launch: { choices: launch } });
        expect(managedConfiguratorCredentialSelections({ ...direct, optionsSelectors: { transport: 'direct', backendId: 'aws' } }, crabbox)).toEqual([credential]);
    });

    it('rejects invalid or missing executable bases and failed native checks', () => {
        const invalid = refreshManagedConfiguratorOptions(fresh(), { base: { launch: { cpu: 2, credential: 'secret' } }, dimensions: emptyDimensions() });
        expect(managedConfiguratorAcquireInput(invalid, 'home')).toBeNull();
        expect(managedConfiguratorAcquireInput(refreshManagedConfiguratorOptions(fresh(), { dimensions: emptyDimensions() }), 'home')).toBeNull();
        expect(managedConfiguratorAcquireInput({ ...small(), check: { available: false } }, 'home')).toBeNull();
    });
});
