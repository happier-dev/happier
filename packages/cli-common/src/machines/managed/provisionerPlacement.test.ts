import { describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { defineProtocolObject } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema, MachineProvisionersListResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { projectAccountManagedProvisioners } from './provisioners.js';

describe('provisioner discovery acquire placement', () => {
    it.each(['account', 'daemon'] as const)('projects the declared acquire role target %s, not another role or browser eligibility', target => {
        const native = defineProtocolObject({}, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
        const descriptor = { id: 'guest', title: 'Guest', icon: 'cloud', resourceKind: 'compute', schemaVersion: 1,
            launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
            browserReachable: false, billing: { location: 'cloud', stoppedBilling: 'not-billed' },
            retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', acquire: 'allocate', bootstrap: 'bootstrap', inspect: 'observe', destroy: 'destroy' } };
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'test.placement', version: '1.0.0',
            displayName: 'Placement', engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.js' }, hostAccess: { required: [], optional: [] },
            contributes: { machineProvisioners: [descriptor], actions: [
                ['check', roles.checkInput.jsonSchema, MachineProvisionerCheckResultProtocolV1Schema.jsonSchema],
                ['allocate', roles.acquireInput.jsonSchema, roles.acquireResult.jsonSchema],
                ['bootstrap', roles.bootstrapInput.jsonSchema, MachineProvisionerBootstrapCarrierV1Schema.jsonSchema],
                ['observe', roles.resourceInput.jsonSchema, MachineProvisionerObservationV1Schema.jsonSchema],
                ['destroy', roles.resourceInput.jsonSchema, MachineProvisionerPowerResultV1Schema.jsonSchema],
            ].map(([id, inputSchema, resultSchema]) => ({ id, title: 'Role', scopes: ['machine'], surfaces: ['plugin'],
                execution: (id === 'allocate' ? target : target === 'account' ? 'daemon' : 'account') === 'account'
                    ? { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } }
                    : { target: 'daemon' },
                dangerLevel: 'safe', inputSchema, resultSchema })) } });
        const selection = createPluginAccountBundledSelectionV1({ packageName: '@test/placement', manifest });
        const execution = resolvePluginAccountExecutionSelectionV1({
            pluginId: manifest.id, intentRead: null, bundled: selection,
        });
        if (execution.kind !== 'available') throw new Error(execution.code);
        const provisioners = projectAccountManagedProvisioners([execution]);
        expect(provisioners).toHaveLength(1);
        expect(provisioners[0]).toMatchObject({ acquireExecutionTarget: target, descriptor: { browserReachable: false } });
        expect(MachineProvisionersListResultV1Schema.parse({ provisioners }).provisioners[0])
            .toMatchObject({ acquireExecutionTarget: target });
    });
});
