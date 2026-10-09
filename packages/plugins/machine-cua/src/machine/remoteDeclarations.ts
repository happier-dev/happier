import type { PluginConnectedAccountDefinition, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1, type ConnectedAccountAuthenticationModeRuntime, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema, MachineProvisionerNativeExecResultV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema,
    MachineProvisionerPutFileResultV1Schema, type MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { ByocLaunchV1Schema, ByocResourceV1Schema, ByocNativeOperationV1Schema, ByocOptionsQueryV1Schema,
    FleetLaunchV1Schema, FleetResourceV1Schema, FleetOptionsQueryV1Schema } from './remoteSchemas.js';
import { ByocProvisionerSchemas, ByocReconciliationSchemas, FleetProvisionerSchemas, FleetReconciliationSchemas,
    byocReconciliationOperation, fleetReconciliationOperation } from './remoteProvisionerSchemas.js';
import type { CuaRemoteRole } from './remoteProvisioner.js';
import { machinePresentationLabel, machineCheckPresentation, configurationLabel } from '../ui/translations.js';

const cloudPurpose = 'cloud-account', cuaPurpose = 'cua-account';
export function remoteRoles(id: 'byoc' | 'fleet') {
    const schemas = id === 'byoc' ? ByocProvisionerSchemas : FleetProvisionerSchemas;
    const reconciliation = id === 'byoc' ? ByocReconciliationSchemas : FleetReconciliationSchemas;
    const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'],
        hostAccess: id === 'byoc' ? ['cua-native-process', cloudPurpose, cuaPurpose] : ['cua-fleet-api', cuaPurpose] } as const;
    const run = async (role: CuaRemoteRole, input: unknown, context: PluginInvocationContext) =>
        (await import('./remoteProvisioner.js')).invokeCuaRemoteRole(id, role, input, context);
    return {
        check: { ...defaults, title: `Check Cua ${id} access`, dangerLevel: 'safe' as const, inputSchema: schemas.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return machineCheckPresentation(MachineProvisionerCheckResultV1Schema.parse(await run('check', input, context))); }
                catch { return machineCheckPresentation({ available: false, code: 'cua_connection_unavailable' }); } } },
        options: { ...defaults, title: `Read Cua ${id} native choices`, dangerLevel: 'safe' as const,
            inputSchema: id === 'byoc' ? ByocOptionsQueryV1Schema : FleetOptionsQueryV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
            inputHints: { fields: id === 'byoc' ? [
                { path: 'cloud', title: configurationLabel('cloud'), widget: 'text' as const, required: true },
            ] : [
                { path: 'namespace', title: configurationLabel('namespace'), widget: 'text' as const, required: true },
                { path: 'nativeLease.durationSeconds', title: configurationLabel('durationSeconds'), widget: 'integer' as const, required: true },
            ] },
            async run(input: unknown, context: PluginInvocationContext) { return MachineProvisionerOptionsResultV1Schema.parse(await run('options', input, context)); } },
        acquire: { ...defaults, title: `Acquire Cua ${id} compute`, dangerLevel: 'destructive' as const,
            confirmation: { title: `Create this Cua ${id} resource?`, body: 'Creates the reviewed paid native resource. Fleet claims retain their native finite lease.' },
            inputSchema: schemas.acquireInput, resultSchema: schemas.acquireResult,
            async run(input: unknown, context: PluginInvocationContext) { return schemas.acquireResult.parse(await run('acquire', input, context)); } },
        reconcile: { ...defaults, title: `Recover exact Cua ${id} acquisition`, dangerLevel: 'safe' as const,
            inputSchema: reconciliation.input, resultSchema: reconciliation.result,
            async run(input: unknown, context: PluginInvocationContext) {
                try { return reconciliation.result.parse(await run('reconcile', input, context)); }
                catch { return reconciliation.result.parse({ kind: 'pending', nativeOperationRef: {
                    contributionRef: { pluginId: 'happier.machine.cua', localId: id }, schemaVersion: 1,
                    value: id === 'byoc' ? byocReconciliationOperation(input) : fleetReconciliationOperation(input) } }); }
            } },
        bootstrap: { ...defaults, title: `Resolve private Cua ${id} bootstrap`, dangerLevel: 'writesLocal' as const, confirmation: { title: 'Prepare this Cua resource for Happier?' },
            inputSchema: schemas.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { return MachineProvisionerBootstrapCarrierV1Schema.parse(await run('bootstrap', input, context)); } },
        inspect: { ...defaults, title: `Inspect exact Cua ${id} resource`, dangerLevel: 'safe' as const, inputSchema: schemas.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return MachineProvisionerObservationV1Schema.parse(await run('inspect', input, context)); }
                catch { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: 'cua_native_resource_unknown' }; } } },
        power: { ...defaults, title: 'Change exact Cua BYOC power', dangerLevel: 'destructive' as const, confirmation: { title: 'Change this Cua resource’s power?' },
            inputSchema: schemas.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return MachineProvisionerPowerResultV1Schema.parse(await run('power', input, context)); }
                catch { return { kind: 'unknown' as const, code: 'cua_native_power_unknown' }; } } },
        destroy: { ...defaults, title: id === 'fleet' ? 'Release exact Cua Fleet claim' : 'Delete exact created Cua BYOC resource', dangerLevel: 'destructive' as const,
            confirmation: { title: id === 'fleet' ? 'Release this Fleet claim?' : 'Delete this Cua BYOC resource?', body: id === 'fleet' ? 'Deletes only this claim and its private Secret. The shared pool is kept.' : 'Deletes only the exact created native resource.' },
            inputSchema: reconciliation.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return MachineProvisionerPowerResultV1Schema.parse(await run('destroy', input, context)); }
                catch { return { kind: 'unknown' as const, code: 'cua_cleanup_incomplete' }; } } },
        exec: { ...defaults, title: `Execute private Cua ${id} bootstrap IO`, dangerLevel: 'writesLocal' as const, confirmation: { title: 'Run private Cua bootstrap command?' },
            inputSchema: schemas.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { return MachineProvisionerNativeExecResultV1Schema.parse(await run('exec', input, context)); } },
        putFile: { ...defaults, title: `Write private Cua ${id} bootstrap file`, dangerLevel: 'writesLocal' as const, confirmation: { title: 'Write this private Cua bootstrap file?' },
            inputSchema: schemas.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return MachineProvisionerPutFileResultV1Schema.parse(await run('putFile', input, context)); }
                catch { return { kind: 'unknown' as const, code: 'cua_native_file_unavailable' }; } } },
    };
}
export function remoteProvisioner(id: 'byoc' | 'fleet'): MachineProvisionerAuthorDefinitionV1 {
    const fleet = id === 'fleet';
    return { title: fleet ? 'Cua Fleet' : 'Cua BYOC', icon: 'server', resourceKind: fleet ? 'cua-fleet-claim' : 'cua-byoc-resource', schemaVersion: 1,
        kindTitle: machinePresentationLabel(fleet ? 'fleetKind' : 'byocKind'),
        description: machinePresentationLabel(fleet ? 'fleetDescription' : 'byocDescription'),
        launchSchema: (fleet ? FleetLaunchV1Schema : ByocLaunchV1Schema).jsonSchema,
        resourceSchema: (fleet ? FleetResourceV1Schema : ByocResourceV1Schema).jsonSchema,
        platforms: ['darwin', 'linux', 'win32'], prerequisites: fleet ? [] : [{ kind: 'managedDependency', id: 'cua-cli' }],
        billing: { location: 'cloud', stoppedBilling: 'unknown' },
        retention: { supportedIntents: fleet ? ['delete'] : ['start', 'stop', 'delete'], ...(fleet ? { finiteOnly: true } : {}) },
        ...(fleet ? { nativeDurationInput: { path: 'nativeLease.durationSeconds', unit: 'seconds' } as const } : {}),
        actions: { check: `${id}-check`, options: `${id}-options`, acquire: `${id}-acquire`, bootstrap: `${id}-bootstrap`, inspect: `${id}-inspect`,
            ...(!fleet ? { power: `${id}-power` } : {}), destroy: `${id}-destroy` },
        reconciliation: { action: `${id}-reconcile`, nativeOperationSchema: (fleet ? FleetResourceV1Schema : ByocNativeOperationV1Schema).jsonSchema },
        bootstrapTransport: { kind: 'native', exec: `${id}-exec`, putFile: `${id}-put-file` },
        ...(fleet ? { bootstrapCredential: { kind: 'native-token' } as const } : {}) };
}
function lazyAccount(kind: 'cloud' | 'cua'): ConnectedAccountRuntime {
    const runtime = async () => (await import('./remoteConnection.js')).connectedAccountRuntime(kind);
    return { authentication: { modes: {
        native: { kind: 'manual', async complete(input, context, options) {
            const mode = (await runtime()).authentication.modes.native;
            if (mode.kind !== 'manual') throw new Error('cua_auth_mode_mismatch');
            return mode.complete(input, context, options);
        } }, ...(kind === 'cua' ? { token: { kind: 'manual' as const, async complete(input, context, options) {
            const mode = (await runtime()).authentication.modes.token;
            if (mode.kind !== 'manual') throw new Error('cua_auth_mode_mismatch');
            return mode.complete(input, context, options);
        } } satisfies Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'manual' }> } : {}) } },
        async status(context, options) { return (await runtime()).status(context, options); },
        async refresh(context, options) { return (await runtime()).refresh(context, options); },
        async revoke(context, options) { return (await runtime()).revoke(context, options); },
        async materialize(request, context, options) { return (await runtime()).materialize(request, context, options); } };
}
const nativeMode = { id: 'native', kind: 'manual', title: 'Existing native setup', outcomeReconciliation: 'none',
    fields: [], configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{ id: 'nativeHome',
        title: 'Native Cua home directory', schema: { type: 'string', minLength: 1 }, required: true, secret: false }] } } as const;
export const remoteAccounts = {
    'cloud-native': { declaration: { title: 'Cua native cloud account', authentication: { defaultModeId: 'native', modes: [nativeMode] } }, runtime: lazyAccount('cloud') },
    'cua-account': { declaration: { title: 'Cua login or Fleet gateway', authentication: { defaultModeId: 'native', modes: [nativeMode, {
        id: 'token', kind: 'manual' as const, title: 'Fleet gateway token', outcomeReconciliation: 'none' as const,
        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'Fleet API token', schema: { type: 'string', minLength: 1 }, secret: true }],
        configuration: { scope: 'account' as const, changeBehavior: 'reconnect' as const, fields: [{ id: 'endpoint', title: 'Fleet gateway URL',
            semantic: 'connectedAccountBase' as const, schema: { type: 'string', minLength: 1 }, required: true, secret: false }] },
    } satisfies Extract<PluginConnectedAccountDefinition['declaration']['authentication']['modes'][number], { kind: 'manual' }>] } }, runtime: lazyAccount('cua') },
};
