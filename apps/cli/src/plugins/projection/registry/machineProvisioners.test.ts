import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { createLoadedMachineProvisionerFixture } from './machineProvisioners.testkit';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { readDeclaredConnectedAccountResourcePurposeV1, readDeclaredConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';

describe('machine provisioner projection', () => {
    it('projects the acquire Action credential purposes under the provisioner identity without inventing a Resource', () => {
        const pluginId = 'com.acme.cloud';
        const loaded = createLoadedMachineProvisionerFixture(pluginId);
        const service = { pluginId, localId: 'cloud' };
        const manifest = normalizePluginManifestV2({ ...loaded.manifest,
            hostAccess: { required: [{ id: 'cloud-account', capability: 'connectedAccounts', reason: 'Use the selected cloud account',
                scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
            contributes: { ...loaded.manifest.contributes, connectedAccountDescriptors: [{ id: 'cloud', title: 'Cloud account',
                authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] } }],
                actions: loaded.manifest.contributes.actions.map(action =>
                action.id === 'acquire' ? { ...action, hostAccess: ['cloud-account'] } : action) },
        });
        const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [{ ...loaded, manifest }], diagnosticsByPluginId: {} }, provenance: 'external',
        }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
        const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
        const entry = projection.familiesById.machineProvisioners?.entriesById[`${pluginId}/guest`];
        expect(entry).toMatchObject({ connectedAccountPurposes: [{ purpose: 'cloud-account', serviceRefs: [service] }] });
        expect(projection.resourcesById).toEqual({});
        const purpose = { consumer: { pluginId, localId: 'guest' }, purpose: 'cloud-account' };
        const machineProvisionersById = projection.familiesById.machineProvisioners?.entriesById ?? {};
        expect(readDeclaredConnectedAccountPurposeV1({ purpose, projection, machineProvisionersById })).toMatchObject({ consumerKind: 'machineProvisioner', serviceRefs: [service] });
        expect(readDeclaredConnectedAccountPurposeV1({ purpose, projection: { ...projection, installedPackagesById: {} }, machineProvisionersById })).toBeNull();
        expect(readDeclaredConnectedAccountPurposeV1({ purpose: { ...purpose, purpose: 'other' }, projection, machineProvisionersById })).toBeNull();
        expect(readDeclaredConnectedAccountPurposeV1({ purpose, projection: { ...projection, resourcesById: { guest: {
            id: 'guest', pluginId, resourceKind: 'config', path: 'guest.json',
            connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }],
        } } }, machineProvisionersById })).toBeNull();
        // Resource defaults are a separate operation: a provisioner must never acquire that authority.
        expect(readDeclaredConnectedAccountResourcePurposeV1({ projection,
            purpose: { consumer: { pluginId, localId: 'guest' }, purpose: 'cloud-account' } })).toBeNull();
    });
    it('projects qualified safe descriptors with exact source and occurrence and withdraws retired leaves', () => {
        const ids = ['com.acme.one', 'com.acme.two'];
        const inputs = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: ids.map(createLoadedMachineProvisionerFixture), diagnosticsByPluginId: {} },
            provenance: 'first_party',
        });
        const registry = createResolvedContributionRegistry({ ...inputs,
            occurrenceIdsByPluginId: Object.fromEntries(ids.map((id) => [id, createPluginRuntimeOccurrenceId(id)])),
        });
        const keys = ids.map((id) => `${id}/guest`);
        expect(registry.machineProvisioners?.map((entry) => entry.identity)).toEqual(ids.map((pluginId) => ({ pluginId, localId: 'guest' })));
        expect([...(registry.machineProvisionersByContributionKey?.keys() ?? [])]).toEqual(keys);
        expect(registry.machineProvisioners?.[0]).toMatchObject({ provenance: 'first_party', source: { kind: 'package' } });
        const origin = { serverIdentityId: 'srv_provisioners', materializationRef: {
            machineId: 'controller', materializationId: 'provisioner-materialization', pluginId: ids[0]!,
        } };
        const projection = buildPluginProjectionV2({ registry, generation: 1,
            pluginExecutionOriginsByPluginId: { [ids[0]!]: origin } });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        const family = projection.familiesById.machineProvisioners;
        expect(Object.keys(family?.entriesById ?? {})).toEqual(keys);
        const entry = family?.entriesById[keys[0]!];
        expect(entry).toMatchObject({ executionOrigin: origin, occurrenceId: registry.occurrenceIdsByPluginId?.[ids[0]!] });
        for (const invalidEntry of [
            { ...entry, privateCredential: 'forbidden' },
            { ...entry, id: `${ids[1]}/guest` },
            { ...entry, executionOrigin: { ...origin, materializationRef: { ...origin.materializationRef, pluginId: ids[1] } } },
            { ...entry, executionOrigin: { ...origin, serverIdentityId: undefined } },
        ]) {
            expect(PluginProjectionV2Schema.safeParse({ ...projection, familiesById: { ...projection.familiesById,
                machineProvisioners: { ...family, entriesById: { [keys[0]!]: invalidEntry } },
            } }).success).toBe(false);
        }
        expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }),
            generation: 2 }).familiesById.machineProvisioners?.entriesById).toEqual({});
        expect(() => createResolvedContributionRegistry({ ...inputs,
            machineProvisioners: [...(inputs.machineProvisioners ?? []), ...(inputs.machineProvisioners ?? [])],
        })).toThrow(/Duplicate contribution/);
    });
});
