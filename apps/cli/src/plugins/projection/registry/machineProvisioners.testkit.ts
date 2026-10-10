import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import {
    defineMachineProvisionerSchemas,
    MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerCheckInputV1Schema,
    MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerNativeExecResultV1Schema,
    MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema,
    MachineProvisionerPutFileResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

export const machineProvisionerFixtureRoleIds = ['check', 'acquire', 'bootstrap', 'inspect', 'destroy', 'exec', 'put-file'] as const;

export function createLoadedMachineProvisionerFixture(pluginId: string): LoadedPlugin {
    const pluginRootPath = `/plugins/${pluginId}`;
    const native = MachineProvisionerCheckInputV1Schema;
    const schemas = defineMachineProvisionerSchemas({ launch: native, resource: native });
    const roleSchemas = {
        check: { inputSchema: schemas.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
        acquire: { inputSchema: schemas.acquireInput.jsonSchema, resultSchema: schemas.acquireResult.jsonSchema },
        bootstrap: { inputSchema: schemas.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
        inspect: { inputSchema: schemas.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
        destroy: { inputSchema: schemas.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        exec: { inputSchema: schemas.execInput.jsonSchema, resultSchema: MachineProvisionerNativeExecResultV1Schema.jsonSchema },
        'put-file': { inputSchema: schemas.putFileInput.jsonSchema, resultSchema: MachineProvisionerPutFileResultV1Schema.jsonSchema },
    };
    return {
        pluginId, pluginRootPath, manifestPath: `${pluginRootPath}/plugin.json`,
        daemonEntryPath: `${pluginRootPath}/daemon.mjs`, devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
        manifest: normalizePluginManifestV2({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Machine provisioner',
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                machineProvisioners: [{
                    id: 'guest', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
                    launchSchema: native.jsonSchema,
                    resourceSchema: native.jsonSchema,
                    platforms: ['darwin'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' },
                    retention: { supportedIntents: ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
                    bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
                }],
                actions: machineProvisionerFixtureRoleIds.map((id) => ({
                    id, title: id, execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe',
                    ...roleSchemas[id],
                })),
            },
        }),
    };
}
