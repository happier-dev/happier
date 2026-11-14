import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineMachineProvisionerSchemas, buildMachineProvisionerCloudInit, buildMachineProvisionerPinnedSshBootstrap,
    MachineProvisionerCheckResultV1Schema, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema,
    MachineProvisionerResizeResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';

// A cloud HTTP boundary fixture. Host admission, private custody, cloud-init,
// native SSH, installation and ordinary pairing all use production owners.
const native = { launch: defineProtocolObject({ region: defineProtocolString() }, { policy: 'closed' }),
    resource: defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' }) };
const schemas = defineMachineProvisionerSchemas(native);
const ref = (value: { id: string }) => ({ contributionRef: { pluginId: 'acme.cloud-ssh', localId: 'cloud' }, schemaVersion: 1, value });
const defaults = { scopes: ['global'], surfaces: ['ui', 'plugin'],
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    hostAccess: ['cloud-http'] } as const;
export const PLUGIN = definePlugin({ id: 'acme.cloud-ssh', version: '1.0.0',
    hostAccess: { required: [{ id: 'cloud-http', capability: 'network', reason: 'Create the reviewed cloud guest',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://cloud-ssh.test' }], methods: ['POST'] } }] },
    machineProvisioners: { cloud: { title: 'Cloud SSH', icon: 'server', resourceKind: 'cloud-ssh', schemaVersion: 1,
        launchSchema: native.launch.jsonSchema, resourceSchema: native.resource.jsonSchema,
        platforms: ['linux', 'darwin', 'win32'], browserReachable: false, prerequisites: [],
        billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
        resize: { cpuCores: { kind: 'supported', requiresRestart: false, changes: 'any' },
            memoryBytes: { kind: 'unsupported', code: 'fixture_memory_unsupported' },
            diskBytes: { kind: 'unsupported', code: 'fixture_disk_unsupported' } },
        bootstrapCredential: { kind: 'ssh' }, actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', resize: 'resize', destroy: 'destroy' },
    } },
    actions: {
        check: { ...defaults, title: 'Check', dangerLevel: 'safe', inputSchema: schemas.checkInput,
            resultSchema: MachineProvisionerCheckResultV1Schema, async run() { return { available: true }; } },
        acquire: { ...defaults, title: 'Create', dangerLevel: 'destructive', confirmation: { title: 'Create or delete the reviewed guest?' }, inputSchema: schemas.acquireInput,
            resultSchema: schemas.acquireResult, async run(input, context) {
                const lease = await context.services.machineProvisioners.materializeGuestHostCredential();
                try {
                    const userData = buildMachineProvisionerCloudInit(input.bootstrapPublicKey!, {
                        publicKey: input.guestHostPublicKey!, privateKey: new TextDecoder().decode(lease.bytes) });
                    await context.services.http.request({ url: 'https://cloud-ssh.test/create', method: 'POST',
                        body: new TextEncoder().encode(JSON.stringify({ userData })) });
                    return { kind: 'bound' as const, resource: ref({ id: 'guest-1' }) };
                } finally { await lease.dispose(); }
            } },
        bootstrap: { ...defaults, title: 'Bootstrap', dangerLevel: 'writesLocal', confirmation: { title: 'Bootstrap the reviewed guest?' }, inputSchema: schemas.bootstrapInput,
            resultSchema: MachineProvisionerBootstrapCarrierV1Schema, async run(input) {
                if (!input.guestHostPublicKey) return resolveMachineProvisionerSshBootstrap({
                    connection: { address: '203.0.113.42', user: 'happier-bootstrap' }, credentialRef: input.credentialRef,
                });
                return buildMachineProvisionerPinnedSshBootstrap({ connection: { address: '203.0.113.42', user: 'happier-bootstrap' },
                    credentialRef: input.credentialRef!, guestHostPublicKey: input.guestHostPublicKey! });
            } },
        inspect: { ...defaults, title: 'Inspect', dangerLevel: 'safe', inputSchema: schemas.resourceInput,
            resultSchema: MachineProvisionerObservationV1Schema, async run() { return { observedAt: Date.now(), availability: 'present' as const, power: 'running' as const }; } },
        resize: { ...defaults, title: 'Resize', dangerLevel: 'writesRemote', confirmation: { title: 'Resize the reviewed guest?' },
            inputSchema: schemas.resizeInput, resultSchema: MachineProvisionerResizeResultV1Schema,
            async run() { return { kind: 'confirmed' as const }; } },
        destroy: { ...defaults, title: 'Delete', dangerLevel: 'destructive', confirmation: { title: 'Create or delete the reviewed guest?' }, inputSchema: schemas.resourceInput,
            resultSchema: MachineProvisionerPowerResultV1Schema, async run() { return { kind: 'confirmed' as const }; } },
    },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = PLUGIN.activateAccount;
