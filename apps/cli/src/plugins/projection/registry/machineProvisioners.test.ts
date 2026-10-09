import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { createLoadedMachineProvisionerFixture } from './machineProvisioners.testkit';

describe('machine provisioner projection', () => {
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
        expect(entry).toMatchObject({ ...origin, occurrenceId: registry.occurrenceIdsByPluginId?.[ids[0]!] });
        for (const invalidEntry of [
            { ...entry, privateCredential: 'forbidden' },
            { ...entry, id: `${ids[1]}/guest` },
            { ...entry, materializationRef: { ...origin.materializationRef, pluginId: ids[1] } },
            { ...entry, serverIdentityId: undefined },
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
