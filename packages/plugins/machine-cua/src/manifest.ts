import { Buffer } from 'node:buffer';
import { machinePresentationLabel, machineCheckPresentation, configurationLabel, CUA_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
    MachineProvisionerNativeExecResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
    MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema,
    type MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CuaLocalProvisionerSchemas as schemas, CuaLocalNativeOperationV1Schema, CuaLocalReconciliationSchemas, localReconciliationOperation } from './machine/localProvisionerSchemas.js';
import { CuaLocalLaunchV1Schema, CuaLocalOptionsQueryV1Schema, CuaLocalResourceV1Schema,
    type CuaLocalLaunchV1, type CuaLocalResourceV1, type CuaLocalOptionsQueryV1 } from './machine/schemas.js';
import type { CuaLocalProvisionerId } from './machine/localProvisioner.js';
import { remoteAccounts, remoteProvisioner, remoteRoles } from './machine/remoteDeclarations.js';

const pluginId = 'happier.machine.cua';
const dependencyId = 'cua-cli';
const processAccess = 'cua-native-process';
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;

async function provider(id: CuaLocalProvisionerId, context: PluginInvocationContext) {
    const status = await context.services.managedServices.dependencies.status(dependencyId, { signal: context.signal });
    if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) throw new Error('cua_native_unavailable');
    const [{ createCuaNativeClient }, { createCuaLocalProvisioner }] = await Promise.all([
        import('./machine/nativeClient.js'), import('./machine/localProvisioner.js'),
    ]);
    return createCuaLocalProvisioner(createCuaNativeClient({ exec: context.services.exec, executable: status.executable }),
        id, context.invokedAtMs, context.signal);
}
function bytes(encoded: string) {
    const value = Buffer.from(encoded, 'base64');
    if (value.toString('base64') !== encoded) throw new Error('cua_invalid_private_input');
    return value;
}
function roles(id: CuaLocalProvisionerId) {
    return {
        reconcile: { ...defaults, title: 'Recover the exact Cua local allocation', dangerLevel: 'safe' as const,
            inputSchema: CuaLocalReconciliationSchemas.input, resultSchema: CuaLocalReconciliationSchemas.result,
            async run(input: ReturnType<typeof CuaLocalReconciliationSchemas.input.parse>, context: PluginInvocationContext) {
                const operation = localReconciliationOperation(id, input);
                try { return await (await provider(id, context)).reconcile(operation); }
                catch { return { kind: 'pending' as const, nativeOperationRef: { contributionRef: { pluginId, localId: id },
                    schemaVersion: 1, value: operation } }; }
            } },
        check: { ...defaults, title: 'Check Cua local runtime', dangerLevel: 'safe' as const,
            inputSchema: schemas.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
            async run(_input: Readonly<Record<string, never>>, context: PluginInvocationContext) {
                const requirement = { kind: 'managedDependency' as const, id: { pluginId, localId: dependencyId } };
                try { return machineCheckPresentation({ ...await (await provider(id, context)).check(), prerequisites: [{ requirement, status: 'available' as const }] }); }
                catch { return machineCheckPresentation({ available: false, code: 'cua_native_unavailable', prerequisites: [{ requirement, status: 'unavailable' as const }] }); }
            } },
        options: { ...defaults, title: 'Read Cua local image and runtime choices', dangerLevel: 'safe' as const,
            inputSchema: CuaLocalOptionsQueryV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
            inputHints: { fields: [
                { path: 'runtimeId', title: configurationLabel('runtimeId'), widget: 'text' as const },
                { path: 'imageId', title: configurationLabel('imageId'), widget: 'text' as const },
                { path: 'size.cpu', title: configurationLabel('cpu'), widget: 'integer' as const, required: true },
                { path: 'size.memoryBytes', title: configurationLabel('memoryBytes'), widget: 'integer' as const, required: true },
                { path: 'size.diskBytes', title: configurationLabel('diskBytes'), widget: 'integer' as const, required: true },
            ] },
            async run(input: CuaLocalOptionsQueryV1, context: PluginInvocationContext) {
                return (await provider(id, context)).options(input);
            } },
        acquire: { ...defaults, title: 'Create Cua local machine', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Create this Cua local machine?' },
            inputSchema: schemas.acquireInput, resultSchema: schemas.acquireResult,
            async run(input: Readonly<{ launch: CuaLocalLaunchV1; managedId?: string }>, context: PluginInvocationContext) {
                // No native effect has occurred when dependency qualification
                // fails. Once create is submitted the native owner retains its
                // exact recovery id and never interprets transport loss as gone.
                if (!input.managedId) return { kind: 'rejected' as const, code: 'invalid_request' as const };
                let prepared;
                try { prepared = await provider(id, context); }
                catch { return { kind: 'rejected' as const, code: 'provider_unavailable' as const }; }
                return prepared.acquire(input.launch, input.managedId);
            } },
        bootstrap: { ...defaults, title: 'Resolve Cua private native bootstrap', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Resolve private Cua bootstrap?' },
            inputSchema: schemas.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
            async run(input: Readonly<{ resource: CuaLocalResourceV1 }>, context: PluginInvocationContext) {
                return (await provider(id, context)).bootstrap(input.resource);
            } },
        inspect: { ...defaults, title: 'Inspect Cua local machine', dangerLevel: 'safe' as const,
            inputSchema: schemas.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
            async run(input: Readonly<{ resource: CuaLocalResourceV1 }>, context: PluginInvocationContext) {
                try { return await (await provider(id, context)).inspect(input.resource); }
                catch { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: 'cua_native_unavailable' }; }
            } },
        power: { ...defaults, title: 'Change Cua local machine power', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Change this Cua machine’s power?' },
            inputSchema: schemas.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            async run(input: ReturnType<typeof schemas.powerInput.parse>, context: PluginInvocationContext) {
                try { return await (await provider(id, context)).power(input.resource, input.intent); }
                catch { return { kind: 'unknown' as const, code: 'cua_native_unavailable' }; }
            } },
        destroy: { ...defaults, title: 'Delete exact created Cua local machine', dangerLevel: 'destructive' as const,
            confirmation: { title: 'Delete this Cua local machine?', body: 'The exact created resource and its retained storage will be deleted.' },
            inputSchema: CuaLocalReconciliationSchemas.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            async run(input: ReturnType<typeof CuaLocalReconciliationSchemas.destroyInput.parse>, context: PluginInvocationContext) {
                try {
                    const native = await provider(id, context);
                    if ('resource' in input) return await native.destroy(input.resource);
                    return await native.destroyPending(input.nativeOperation);
                }
                catch { return { kind: 'unknown' as const, code: 'cua_cleanup_incomplete' }; }
            } },
        exec: { ...defaults, title: 'Execute private Cua bootstrap IO', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Run private Cua bootstrap command?' },
            inputSchema: schemas.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
            async run(input: ReturnType<typeof schemas.execInput.parse>, context: PluginInvocationContext) {
                const result = await (await provider(id, context)).exec(input.resource, input.argv,
                    input.inputBase64 === undefined ? undefined : bytes(input.inputBase64), input.timeoutMs);
                return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
                    stderrBase64: Buffer.from(result.stderr).toString('base64'),
                    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
            } },
        putFile: { ...defaults, title: 'Write private Cua bootstrap file', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Write this private Cua bootstrap file?' },
            inputSchema: schemas.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
            async run(input: ReturnType<typeof schemas.putFileInput.parse>, context: PluginInvocationContext) {
                try { return await (await provider(id, context)).putFile(input.resource, input.guestPath, bytes(input.bytesBase64), input.mode); }
                catch { return { kind: 'unknown' as const, code: 'cua_native_file_unavailable' }; }
            } },
    };
}
const sandbox = roles('local-sandbox');
const space = roles('local-space');
const byoc = remoteRoles('byoc');
const fleet = remoteRoles('fleet');
function provisioner(id: CuaLocalProvisionerId): MachineProvisionerAuthorDefinitionV1 {
    const prefix = id === 'local-space' ? 'space' : 'sandbox';
    return { title: id === 'local-space' ? 'Cua local Space' : 'Cua local sandbox', icon: 'desktop',
        resourceKind: id === 'local-space' ? 'cua-local-space' : 'cua-local-sandbox', schemaVersion: 1,
        kindTitle: machinePresentationLabel(id === 'local-space' ? 'spaceKind' : 'kind'),
        description: machinePresentationLabel(id === 'local-space' ? 'spaceDescription' : 'description'),
        launchSchema: CuaLocalLaunchV1Schema.jsonSchema, resourceSchema: CuaLocalResourceV1Schema.jsonSchema,
        platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'managedDependency', id: dependencyId }],
        billing: { location: 'local', stoppedBilling: 'not-billed' },
        retention: { supportedIntents: ['start', 'suspend', 'resume', 'delete'] },
        actions: { check: `${prefix}-check`, options: `${prefix}-options`, acquire: `${prefix}-acquire`, bootstrap: `${prefix}-bootstrap`,
            inspect: `${prefix}-inspect`, power: `${prefix}-power`, destroy: `${prefix}-destroy` },
        reconciliation: { action: `${prefix}-reconcile`, nativeOperationSchema: CuaLocalNativeOperationV1Schema.jsonSchema },
        bootstrapTransport: { kind: 'native', exec: `${prefix}-exec`, putFile: `${prefix}-put-file` } };
}
export const CUA_PLUGIN = definePlugin({
    id: pluginId, version: '0.0.0', displayName: 'Cua Machines',
    description: 'Exact Cua local, BYOC and Fleet resources with private native bootstrap IO.',
    engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Operate only the reviewed native Cua resource.',
        scope: { executables: [{ kind: 'managedDependency', id: dependencyId }] } },
        { id: 'cloud-account', capability: 'connectedAccounts', reason: 'Use only the captured native cloud setup.',
            scope: { serviceRefs: ['cloud-native'], operations: ['use'], materializationKinds: ['environment'] } },
        { id: 'cua-account', capability: 'connectedAccounts', reason: 'Use only the captured Cua login or Fleet gateway.',
            scope: { serviceRefs: ['cua-account'], operations: ['use'], materializationKinds: ['environment', 'httpHeaders'] } },
        { id: 'cua-fleet-api', capability: 'network', reason: 'Operate the exact Fleet claim and its private guest transport without renewal.',
            scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'cua-account' }], methods: ['GET', 'POST', 'DELETE'] } },
    ], optional: [] },
    connectedAccountDescriptors: remoteAccounts,
    managedDependencies: { [dependencyId]: { id: dependencyId, title: 'Cua', executable: 'cua',
        description: 'User-installed native Cua CLI; native components retain their own license and runtime prerequisites.',
        sources: [{ kind: 'system', executableNames: ['cua'], versionArguments: ['--version'] }] } },
    ui: { translations: CUA_UI_TRANSLATION_BUNDLES },
    machineProvisioners: { 'local-sandbox': provisioner('local-sandbox'), 'local-space': provisioner('local-space'),
        byoc: remoteProvisioner('byoc'), fleet: remoteProvisioner('fleet') },
    actions: {
        'byoc-check': byoc.check, 'byoc-options': byoc.options, 'byoc-acquire': byoc.acquire,
        'byoc-reconcile': byoc.reconcile, 'byoc-bootstrap': byoc.bootstrap, 'byoc-inspect': byoc.inspect,
        'byoc-power': byoc.power, 'byoc-destroy': byoc.destroy, 'byoc-exec': byoc.exec, 'byoc-put-file': byoc.putFile,
        'fleet-check': fleet.check, 'fleet-options': fleet.options, 'fleet-acquire': fleet.acquire,
        'fleet-reconcile': fleet.reconcile, 'fleet-bootstrap': fleet.bootstrap, 'fleet-inspect': fleet.inspect,
        'fleet-destroy': fleet.destroy, 'fleet-exec': fleet.exec, 'fleet-put-file': fleet.putFile,
        'sandbox-reconcile': sandbox.reconcile, 'space-reconcile': space.reconcile,
        'sandbox-check': sandbox.check, 'sandbox-options': sandbox.options, 'sandbox-acquire': sandbox.acquire,
        'sandbox-bootstrap': sandbox.bootstrap, 'sandbox-inspect': sandbox.inspect, 'sandbox-power': sandbox.power,
        'sandbox-destroy': sandbox.destroy, 'sandbox-exec': sandbox.exec, 'sandbox-put-file': sandbox.putFile,
        'space-check': space.check, 'space-options': space.options, 'space-acquire': space.acquire,
        'space-bootstrap': space.bootstrap, 'space-inspect': space.inspect, 'space-power': space.power,
        'space-destroy': space.destroy, 'space-exec': space.exec, 'space-put-file': space.putFile,
    },
});
export const PLUGIN_MANIFEST = CUA_PLUGIN.manifest;
