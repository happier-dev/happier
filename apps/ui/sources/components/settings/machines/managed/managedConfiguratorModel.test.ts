import { describe, expect, it } from 'vitest';
import { MachineProvisionerContributionV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedCredentialSelectionV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { FlyLaunchQueryV1Schema, FlyLaunchV1Schema } from '../../../../../../../packages/plugins/machine-fly/src/machine/schemas';
import { CRABBOX_PLUGIN } from '../../../../../../../packages/plugins/machine-crabbox/src/manifest';
import { CUA_PLUGIN } from '../../../../../../../packages/plugins/machine-cua/src/manifest';
import { DEVCONTAINER_PLUGIN } from '../../../../../../../packages/plugins/devcontainer/src/manifest';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, selectManagedConfiguratorChoice, selectManagedConfiguratorDimension, managedConfiguratorDimensionSelection, managedConfiguratorDimensionChoices, managedConfiguratorFacts, managedConfiguratorAcquireInput, managedConfiguratorOptionsSelectors, setManagedConfiguratorOptionsSelectors, managedConfiguratorCredentialSelections } from './managedConfiguratorModel';

const descriptor = MachineProvisionerContributionV1Schema.parse({
    id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
    launchSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, required: ['cpu'], additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
});
const provisioner = { contribution: { pluginId: 'custom.compute', localId: 'vm' }, occurrenceId: 'occurrence', descriptor };
const controller = { machineId: 'host', installationId: 'installation' };
const options = { choices: [
    { id: 'small', title: 'Small', launch: { cpu: 2 }, prices: [{ amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }] },
    { id: 'large', title: 'Large', launch: { cpu: 4 } },
] };

describe('managed configurator draft owner', () => {
    it('admits a Devcontainer review query entered through its declared shared Action fields', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners?.[0]);
        const action = DEVCONTAINER_PLUGIN.manifest.contributes.actions.find(action => action.id === descriptor.actions.options)!;
        const values = { workspaceFolder: '/projects/source', configPath: '/projects/source/.devcontainer/devcontainer.json' };
        let selectors: unknown = {};
        for (const field of resolveEffectiveActionInputFields(action, {})) {
            selectors = writeInputPath(selectors, field.path, values[field.path as keyof typeof values]);
        }
        const draft = setManagedConfiguratorOptionsSelectors(createManagedConfiguratorDraft({
            provisioner: { contribution: { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: descriptor.id }, occurrenceId: 'devcontainer', descriptor },
            controller, name: 'Project child',
        }), selectors as Readonly<Record<string, unknown>>);
        expect(managedConfiguratorOptionsSelectors(draft, action.inputSchema!)).toEqual(values);
    });
    it('qualifies saved BYOC recipes using the current selected native variant, with descriptor fallback', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(CUA_PLUGIN.manifest.contributes.machineProvisioners?.find(entry => entry.id === 'byoc'));
        const byoc = { contribution: { pluginId: CUA_PLUGIN.manifest.id, localId: descriptor.id }, occurrenceId: 'byoc', descriptor };
        for (const cloud of ['modal', 'aws', 'gcp'] as const) {
            const finite = cloud === 'modal';
            const launch = { cloud, region: 'west', nativeImageId: 'linux', nativeSizeId: 'native-size',
                nativeLifetime: finite ? { kind: 'finite', durationSeconds: 7200 } : { kind: 'no-native-ttl' } };
            const loaded = MachineProvisionerOptionsResultV1Schema.parse({ choices: [{ id: 'native-choice', title: 'Native choice', launch,
                retention: finite ? { supportedIntents: ['delete'], finiteOnly: true }
                    : { supportedIntents: ['start', 'stop', 'delete'], finiteOnly: false },
                nativeFacts: { size: { id: 'native-size', title: 'Native size' }, image: { id: 'linux', title: 'Linux' },
                    location: { id: 'west', title: 'West' },
                    ...(finite ? { duration: { id: '7200', title: '2 hours', afterMs: 7_200_000 } } : {}) },
            }] });
            const saved = { ...createManagedConfiguratorDraft({ provisioner: byoc, controller, name: 'Saved BYOC',
                preset: { id: 'saved-byoc', revision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } }),
                selected: { id: 'preset:saved-byoc', title: 'Saved BYOC', launch } };
            const refreshed = refreshManagedConfiguratorOptions(saved, loaded);
            const facts = managedConfiguratorFacts(refreshed);
            expect(facts?.retentionCapabilities).toEqual(loaded.choices[0]!.retention);
            expect(facts?.retention.kind).toBe(finite ? 'unused' : 'until-delete');
            expect(facts?.wakeOnAcceptedMessage).toBe(!finite);
            expect(managedConfiguratorAcquireInput(refreshed, 'home')?.reviewedFacts?.retentionCapabilities).toEqual(facts?.retentionCapabilities);
            if (finite) {
                expect(facts?.nativeFacts?.duration?.afterMs).toBe(7_200_000);
                expect(managedConfiguratorAcquireInput(refreshed, 'home')?.selection).toMatchObject({ retention: { effect: 'delete' }, wakeOnAcceptedMessage: false });
                let fresh = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: byoc, controller, name: 'New BYOC' }), loaded);
                for (const [dimension, id] of [['size', 'native-size'], ['image', 'linux'], ['location', 'west']] as const)
                    fresh = selectManagedConfiguratorDimension(fresh, dimension, id);
                expect(managedConfiguratorAcquireInput(fresh, 'home')?.selection).toMatchObject({ launch: { choices: launch }, wakeOnAcceptedMessage: false });
                // A real duration alternative still requires an explicit selection of its complete launch.
                const ambiguous = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: byoc, controller, name: 'New BYOC' }), {
                    choices: [...loaded.choices, { ...loaded.choices[0]!, id: 'longer', launch: { ...launch, nativeLifetime: { kind: 'finite', durationSeconds: 10800 } },
                        nativeFacts: { ...loaded.choices[0]!.nativeFacts, duration: { id: '10800', title: '3 hours', afterMs: 10_800_000 } } }],
                });
                let staged = ambiguous;
                for (const [dimension, id] of [['size', 'native-size'], ['image', 'linux'], ['location', 'west']] as const)
                    staged = selectManagedConfiguratorDimension(staged, dimension, id);
                expect(managedConfiguratorAcquireInput(staged, 'home')).toBeNull();
            }
            const withoutQualification = refreshManagedConfiguratorOptions(saved, { choices: [{ id: 'native-choice', title: 'Native choice', launch }] });
            expect(managedConfiguratorFacts(withoutQualification)?.retentionCapabilities).toEqual(descriptor.retention);
        }
    });
    it('selects a dimension of a valid scalar launch without inventing object selectors', () => {
        const scalar = { ...provisioner, descriptor: { ...descriptor,
            launchSchema: { type: 'string', enum: ['small', 'large'] } satisfies PluginJsonSchemaV2 } };
        const loaded = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: scalar, controller, name: 'Guest' }), {
            choices: [{ id: 'scalar-small', title: 'Small', launch: 'small', nativeFacts: { size: { id: 'small', title: 'Small' } } }],
        });
        expect(managedConfiguratorDimensionChoices(loaded, 'size')[0]).toMatchObject({ available: true, selectable: true });
        const selected = selectManagedConfiguratorDimension(loaded, 'size', 'small');
        expect(managedConfiguratorAcquireInput(selected, 'home')?.selection).toMatchObject({ launch: { choices: 'small' } });
        const queried = { ...loaded, optionsSelectors: { search: 'small' } };
        expect(selectManagedConfiguratorDimension(queried, 'size', 'small').selected?.launch).toBe('small');
    });
    it('compares size quotes against the selected region and selectors, preserving unavailable combinations', () => {
        const facts = { size: { id: 'small', title: 'Small' }, image: { id: 'linux', title: 'Linux' } };
        const price = (amount: string) => [{ amount, currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }];
        const choices = [
            { id: 'west-small', title: 'West small', launch: { cpu: 2, ipv4: true, region: 'west' }, prices: price('1'), nativeFacts: { ...facts, location: { id: 'west', title: 'West' } } },
            { id: 'east-small', title: 'East small', launch: { cpu: 2, ipv4: true, region: 'east' }, prices: price('2'), nativeFacts: { ...facts, location: { id: 'east', title: 'East' } } },
            { id: 'east-ipv6', title: 'East IPv6', launch: { cpu: 2, ipv4: false, region: 'east' }, prices: price('3'), nativeFacts: { ...facts, location: { id: 'east', title: 'East' } } },
            { id: 'west-large', title: 'West large', launch: { cpu: 4, ipv4: true, region: 'west' }, prices: price('4'), nativeFacts: { ...facts, size: { id: 'large', title: 'Large' }, location: { id: 'west', title: 'West' } } },
        ];
        const native = { ...provisioner, descriptor: { ...descriptor, launchSchema: { type: 'object', properties: {
            cpu: { type: 'integer' }, ipv4: { type: 'boolean' }, region: { type: 'string' } }, required: ['cpu', 'ipv4', 'region'], additionalProperties: false } satisfies PluginJsonSchemaV2 } };
        const loaded = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: native, controller, name: 'Guest' }), { choices });
        const selected = { ...selectManagedConfiguratorChoice(loaded, 'west-small'), optionsSelectors: { ipv4: true } };
        const east = selectManagedConfiguratorDimension(selected, 'location', 'east');
        expect(east.selected?.id).toBe('east-small');
        expect(managedConfiguratorDimensionChoices(east, 'size').find(row => row.choice.nativeFacts?.size?.id === 'small'))
            .toMatchObject({ available: true, choice: { id: 'east-small', prices: price('2') } });
        expect(managedConfiguratorFacts(east)?.prices).toEqual(price('2'));
        expect(managedConfiguratorDimensionChoices(east, 'size').find(row => row.choice.nativeFacts?.size?.id === 'large'))
            .toMatchObject({ available: false, choice: { prices: undefined } });
        const ambiguous = { ...east, optionsSelectors: undefined };
        expect(managedConfiguratorDimensionChoices(ambiguous, 'size').find(row => row.choice.nativeFacts?.size?.id === 'small')?.choice.prices).toBeUndefined();
        expect(managedConfiguratorDimensionChoices(loaded, 'size').find(row => row.choice.nativeFacts?.size?.id === 'small')?.choice.prices).toBeUndefined();
        expect(selectManagedConfiguratorDimension({ ...east, optionsSelectors: { ipv4: false } }, 'size', 'small').selected?.id).toBe('east-ipv6');
    });
    it('retains preset setup in the draft and receipt while keeping one-off acquisition free of setup authority', () => {
        const environment = { setupScript: 'echo ready', secretRefs: { v: 1 as const, bindings: { API_TOKEN: { ref: 'setup-token' } } } };
        const initial = createManagedConfiguratorDraft({ provisioner, controller, name: 'Guest', environment,
            preset: { id: 'with-environment', revision: 2 } });
        const selected = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(initial, options), 'small');
        const refreshed = refreshManagedConfiguratorOptions(selected, options);
        expect(refreshed.environment).toEqual(environment);
        expect(managedConfiguratorFacts(refreshed)?.environment).toEqual(environment);
        const acquired = managedConfiguratorAcquireInput(refreshed, 'home');
        expect(acquired?.selection).not.toHaveProperty('environment');
        expect(acquired?.reviewedFacts?.environment).toBeUndefined();
    });
    it('drops coordinator selection from a reviewed direct Crabbox launch and restores its requirement for coordinator transport', () => {
        const descriptor = MachineProvisionerContributionV1Schema.parse(CRABBOX_PLUGIN.manifest.contributes.machineProvisioners?.[0]);
        const contribution = { pluginId: CRABBOX_PLUGIN.manifest.id, localId: descriptor.id };
        const credential = { purpose: { consumer: contribution, purpose: 'crabbox-coordinator' }, account: {
            service: { pluginId: contribution.pluginId, localId: 'coordinator' }, accountId: 'reviewed-coordinator' } };
        const crabbox = { contribution, occurrenceId: 'crabbox-occurrence', descriptor,
            credentialPurposes: [{ purpose: credential.purpose, options: [{ value: credential.account, label: 'Coordinator' }] }] };
        const launch = { backendId: 'local-container', transport: 'direct', namespace: 'local', target: 'linux', nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
        const direct = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: crabbox,
            controller, name: 'Local container', credentials: [credential] }), { choices: [{ id: 'local', title: 'Local container', launch }] }), 'local');
        expect(managedConfiguratorCredentialSelections(direct, crabbox)).toEqual([]);
        expect(managedConfiguratorAcquireInput(direct, 'home')?.selection).toMatchObject({ launch: { choices: launch } });
        expect(managedConfiguratorFacts(direct)?.launch.credentials ?? []).toEqual([]);
        const coordinator = { ...direct, selected: { id: 'remote', title: 'Coordinator', launch: { transport: 'coordinator' } } };
        expect(managedConfiguratorCredentialSelections(coordinator, crabbox)).toEqual([credential]);
        expect(managedConfiguratorCredentialSelections({ credentials: [credential] }, crabbox)).toEqual([credential]);
        expect(managedConfiguratorCredentialSelections({ ...direct, optionsSelectors: { transport: 'direct' } }, crabbox)).toEqual([credential]);
        expect(managedConfiguratorCredentialSelections({ ...direct, optionsSelectors: { transport: 'direct', backendId: 'aws' } }, crabbox)).toEqual([credential]);
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
            const launch = { ...base, volume: original };
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
    it('revalidates saved native sizing through only the declared same-path options schema', () => {
        const optionsSchema = { type: 'object', properties: {
            imageId: { type: 'string', minLength: 1 }, runtimeId: { type: 'string', enum: ['qemu'] },
            size: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 }, memoryBytes: { type: 'integer', minimum: 1 },
                diskBytes: { type: 'integer', minimum: 1 } }, required: ['cpu', 'memoryBytes', 'diskBytes'], additionalProperties: false },
        }, additionalProperties: false } satisfies PluginJsonSchemaV2;
        const launch = { on: 'local', runtimeId: 'qemu', imageId: 'linux', size: { cpu: 4, memoryBytes: 4294967296, diskBytes: 85899345920 } };
        const saved = { ...createManagedConfiguratorDraft({ provisioner, controller, name: 'Saved', preset: { id: 'preset', revision: 3 } }),
            selected: { id: 'preset:preset', title: 'Saved', launch } };
        expect(managedConfiguratorOptionsSelectors(saved, optionsSchema)).toEqual({ runtimeId: 'qemu', imageId: 'linux', size: launch.size });
        const refreshed = refreshManagedConfiguratorOptions(saved, { choices: [{ id: 'current-native', title: 'Saved native image', launch }] });
        expect(managedConfiguratorOptionsSelectors(refreshed, optionsSchema)).toEqual({ runtimeId: 'qemu', imageId: 'linux', size: launch.size });
        // A persisted recipe is projected, but current editable input is admitted strictly.
        expect(managedConfiguratorOptionsSelectors({ ...saved, optionsSelectors: { ...launch, imageId: 'edited' } }, optionsSchema)).toBeNull();
        expect(managedConfiguratorOptionsSelectors({ ...saved, optionsSelectors: { runtimeId: 'qemu', imageId: 'edited', size: { ...launch.size, cpu: 0 } } }, optionsSchema)).toBeNull();
    });
    it('invalidates a reviewed launch immediately after explicit selector edits and preserves sizing until native revalidation', () => {
        const initial = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner, controller, name: 'Build box' }), options), 'small');
        const schema = { type: 'object', properties: { imageId: { type: 'string', minLength: 1 },
            size: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, required: ['cpu'], additionalProperties: false } }, additionalProperties: false } satisfies PluginJsonSchemaV2;
        const edited = setManagedConfiguratorOptionsSelectors(initial, { imageId: 'new-image', size: { cpu: 4 } });
        expect(managedConfiguratorAcquireInput(edited, 'home')).toBeNull();
        expect(managedConfiguratorOptionsSelectors(edited, schema)).toEqual({ imageId: 'new-image', size: { cpu: 4 } });
        expect(edited.selected).toEqual(initial.selected);
        const incompatible = refreshManagedConfiguratorOptions(edited, { choices: [{ id: 'small', title: 'Unavailable on the selected image', available: false, launch: { cpu: 2 } }] });
        expect(managedConfiguratorOptionsSelectors(incompatible, schema)).toEqual({ imageId: 'new-image', size: { cpu: 4 } });
        expect(managedConfiguratorAcquireInput(incompatible, 'home')).toBeNull();
    });
    it('preserves the saved selected Account credential through refreshed facts and executable recipe', () => {
        const credential = ManagedCredentialSelectionV1Schema.parse({ purpose: { consumer: provisioner.contribution, purpose: 'provision' },
            account: { service: { pluginId: 'custom.compute', localId: 'connection' }, accountId: 'selected-account' } });
        const credentials = [credential, { ...credential, purpose: { ...credential.purpose, purpose: 'gateway' },
            account: { ...credential.account, accountId: 'selected-gateway' } }];
        const initial = createManagedConfiguratorDraft({ ...{ provisioner, controller, name: 'Saved', credentials,
            preset: { id: 'preset', revision: 3 } } });
        const saved = { ...initial, selected: { id: 'preset:preset', title: 'Saved', launch: { cpu: 2 } } };
        const refreshed = refreshManagedConfiguratorOptions(saved, options);
        expect(managedConfiguratorFacts(refreshed)?.launch.credentials).toEqual(credentials);
        expect(managedConfiguratorAcquireInput(refreshed, 'home')?.selection).toMatchObject({ launch: { credentials } });
        expect(managedConfiguratorFacts(selectManagedConfiguratorChoice(refreshed, 'large'))?.launch.credentials).toEqual(credentials);
    });
    it('selects a declared native duration as the exact returned complete launch and captures its labelled fact', () => {
        const finite = { ...provisioner, descriptor: { ...descriptor, retention: { supportedIntents: ['delete' as const], finiteOnly: true } } };
        const choices = [
            { id: 'short', title: 'Short lease', launch: { cpu: 2 }, nativeFacts: { duration: { id: 'short', title: '1 hour', afterMs: 3_600_000 } } },
            { id: 'long', title: 'Long lease', launch: { cpu: 4 }, nativeFacts: { duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } } },
        ];
        const loaded = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner: finite, controller, name: 'Lease' }), { choices });
        const selected = selectManagedConfiguratorDimension(loaded, 'duration', 'long');
        expect(managedConfiguratorFacts(selected)?.nativeFacts).toMatchObject({ duration: choices[1]!.nativeFacts.duration });
        expect(managedConfiguratorAcquireInput(selected, 'home')).toMatchObject({ selection: { launch: { choices: { cpu: 4 } },
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false } });
    });
    it('recovers labelled facts for the exact saved recipe without replacing a removed recipe', () => {
        const saved = { ...createManagedConfiguratorDraft({ provisioner, controller, name: 'Saved', preset: { id: 'preset', revision: 3 } }),
            selected: { id: 'preset:preset', title: 'Saved', launch: { cpu: 2 } } };
        const refreshed = refreshManagedConfiguratorOptions(saved, options);
        expect(refreshed.selected).toEqual(options.choices[0]);
        expect(managedConfiguratorFacts(refreshed)?.optionStatus).toBe('current');
        expect(refreshManagedConfiguratorOptions(saved, { choices: [options.choices[1]!] }).selected).toEqual(saved.selected);
    });
    it('captures every labelled native charge without dropping attachments or converting units', () => {
        const monthly = { amount: '3.75', currency: 'EUR', unit: 'month', source: 'native', observedAt: 20, label: 'Compute' };
        const hourly = { ...options.choices[0]!.prices![0]!, label: 'Compute' };
        const networkHourly = { amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: 30, label: 'Primary IPv4' };
        const networkMonthly = { amount: '0.50', currency: 'EUR', unit: 'month', source: 'native-network', observedAt: 30, label: 'Primary IPv4' };
        const storage = { amount: '0.04', currency: 'USD', unit: 'GiB-month', source: 'native-storage', observedAt: 40, label: 'Volume' };
        const prices = [monthly, hourly, networkHourly, networkMonthly, storage];
        const selected = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner, controller, name: 'Guest' }),
            { choices: [{ ...options.choices[0]!, prices }] }), 'small');
        expect(managedConfiguratorFacts(selected)).toMatchObject({ prices });
        expect(managedConfiguratorAcquireInput(selected, 'home')?.reviewedFacts?.prices).toEqual(prices);
    });
    it('selects complete returned native choices by labelled dimension while preserving other reviewed dimensions and receipt facts', () => {
        const nativeFacts = { size: { id: 'small', title: 'Small', cpuCores: 2, memoryBytes: 4294967296 },
            image: { id: 'linux', title: 'Linux' }, location: { id: 'west', title: 'West' }, monthlyCapStatus: 'unknown' as const };
        const choices = [
            { id: 'small-linux-west', title: 'Small Linux West', launch: { cpu: 2 }, nativeFacts },
            { id: 'large-linux-west', title: 'Large Linux West', launch: { cpu: 4 }, nativeFacts: { ...nativeFacts, size: { id: 'large', title: 'Large', cpuCores: 4 } } },
            { id: 'small-other-east', title: 'Small Other East', launch: { cpu: 8 }, nativeFacts: { ...nativeFacts, image: { id: 'other', title: 'Other' }, location: { id: 'east', title: 'East' } } },
        ];
        const selected = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner, controller, name: 'Guest' }), { choices }), choices[0]!.id);
        const unselected = refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner, controller, name: 'Guest' }), { choices });
        const sizeOnly = selectManagedConfiguratorDimension(unselected, 'size', 'small');
        expect(managedConfiguratorAcquireInput(sizeOnly, 'home')).toBeNull();
        const imageChosen = selectManagedConfiguratorDimension(sizeOnly, 'image', 'linux');
        const complete = selectManagedConfiguratorDimension(imageChosen, 'location', 'west');
        expect(managedConfiguratorAcquireInput(complete, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 2 } } });
        expect(managedConfiguratorFacts(selected)?.nativeFacts).toEqual(nativeFacts);
        const large = selectManagedConfiguratorDimension(selected, 'size', 'large');
        expect(managedConfiguratorAcquireInput(large, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 4 } } });
        expect(managedConfiguratorFacts(large)?.nativeFacts?.image).toEqual(nativeFacts.image);
        // Crossing dependent dimensions stages only explicit intent, never a synthetic launch or a changed region.
        const otherImage = selectManagedConfiguratorDimension(large, 'image', 'other');
        expect(managedConfiguratorDimensionChoices(large, 'image').find(row => row.choice.nativeFacts?.image?.id === 'other'))
            .toMatchObject({ available: false, selectable: true });
        expect(managedConfiguratorAcquireInput(otherImage, 'home')).toBeNull();
        expect(managedConfiguratorDimensionSelection(otherImage)).toEqual({ size: 'large', image: 'other', location: 'west' });
        const smallOther = selectManagedConfiguratorDimension(otherImage, 'size', 'small');
        const eastOther = selectManagedConfiguratorDimension(smallOther, 'location', 'east');
        expect(managedConfiguratorAcquireInput(eastOther, 'home')?.selection).toMatchObject({ launch: { choices: { cpu: 8 } } });
    });
    it('preserves an explicitly chosen removed option and its receipt without selecting a replacement', () => {
        const initial = createManagedConfiguratorDraft({ provisioner, controller, name: 'Build box' });
        const loaded = refreshManagedConfiguratorOptions(initial, options);
        expect(loaded.selected).toBeNull();
        const selected = selectManagedConfiguratorChoice(loaded, 'small');
        const removed = refreshManagedConfiguratorOptions(selected, { choices: [options.choices[1]!] });
        expect(removed.selected).toEqual(selected.selected);
        expect(managedConfiguratorFacts(removed)?.optionStatus).toBe('unavailable');
        expect(managedConfiguratorFacts(removed)?.prices?.[0]?.amount).toBe('0.005');
        expect(managedConfiguratorAcquireInput(removed, 'home')).toBeNull();
        const reviewed = selectManagedConfiguratorChoice(removed, 'large');
        expect(managedConfiguratorAcquireInput(reviewed, 'home')?.selection).toMatchObject({ kind: 'one-off', launch: { choices: { cpu: 4 } } });
        expect(managedConfiguratorFacts(reviewed)?.prices).toBeUndefined();
        const failedRefresh = { ...reviewed, optionStatus: 'unavailable' as const };
        expect(managedConfiguratorFacts(failedRefresh)?.optionStatus).toBe('unavailable');
        expect(managedConfiguratorAcquireInput(failedRefresh, 'home')).toBeNull();
    });
    it('validates returned launch choices and submits only executable fields using the resolved category policy', () => {
        const draft = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(createManagedConfiguratorDraft({ provisioner, controller, name: 'Build box' }), options), 'small');
        const facts = managedConfiguratorFacts(draft);
        expect(facts).toMatchObject({ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, prices: [{ amount: '0.005' }] });
        const input = managedConfiguratorAcquireInput(draft, 'home');
        expect(input?.selection).toEqual({ kind: 'one-off', homeId: 'home', launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Build box', choices: { cpu: 2 } }, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        expect(input?.selection).not.toHaveProperty('price');
        const invalid = selectManagedConfiguratorChoice(refreshManagedConfiguratorOptions(draft, { choices: [{ id: 'forged', title: 'Forged', launch: { cpu: 2, credential: 'secret' } }] }), 'forged');
        expect(managedConfiguratorAcquireInput(invalid, 'home')).toBeNull();
    });
});
