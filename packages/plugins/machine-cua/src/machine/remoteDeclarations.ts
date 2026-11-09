import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { observeMachineProvisionerNativeRead, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema, MachineProvisionerNativeExecResultV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema,
    MachineProvisionerPutFileResultV1Schema, type MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { ByocLaunchV1Schema, ByocResourceV1Schema, ByocNativeOperationV1Schema, ByocOptionsQueryV1Schema } from './remoteSchemas.js';
import { ByocProvisionerSchemas as schemas, ByocReconciliationSchemas as reconciliation, byocReconciliationOperation } from './remoteProvisionerSchemas.js';
import type { CuaRemoteRole } from './remoteProvisioner.js';
import { machinePresentationLabel, machineCheckPresentation, configurationLabel, CUA_ACCOUNT_NAMES } from '../ui/translations.js';

const cloudPurpose = 'cloud-account', cuaPurpose = 'cua-account';
const id = 'byoc';
/** The typed host/account refusal says "connect an account"; a missing or outdated `cua` keeps its own state. */
function byocCheckFailureCode(error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'credential_unavailable') return 'credential_unavailable';
    if (error instanceof Error && (error.message === 'cua_native_outdated' || error.message === 'cua_native_unavailable')) return error.message;
    return 'cua_connection_unavailable';
}
export function remoteRoles() {
    const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['cua-native-process', cloudPurpose, cuaPurpose] } as const;
    const run = async (role: CuaRemoteRole, input: unknown, context: PluginInvocationContext) =>
        (await import('./remoteProvisioner.js')).invokeCuaRemoteRole(role, input, context);
    return {
        check: { ...defaults, title: `Check Cua ${id} access`, dangerLevel: 'safe' as const, inputSchema: schemas.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return machineCheckPresentation(MachineProvisionerCheckResultV1Schema.parse(await run('check', input, context))); }
                catch (error) { return machineCheckPresentation({ available: false, code: byocCheckFailureCode(error) }); } } },
        options: { ...defaults, title: `Read Cua ${id} native choices`, dangerLevel: 'safe' as const,
            inputSchema: ByocOptionsQueryV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
            inputHints: { fields: [
                { path: 'cloud', title: configurationLabel('cloud'), widget: 'text' as const, required: true },
            ] },
            async run(input: unknown, context: PluginInvocationContext) { return MachineProvisionerOptionsResultV1Schema.parse(await run('options', input, context)); } },
        acquire: { ...defaults, title: `Acquire Cua ${id} compute`, dangerLevel: 'destructive' as const,
            confirmation: { title: `Create this Cua ${id} resource?`, body: 'Creates the reviewed paid native resource.' },
            inputSchema: schemas.acquireInput, resultSchema: schemas.acquireResult,
            async run(input: unknown, context: PluginInvocationContext) { return schemas.acquireResult.parse(await run('acquire', input, context)); } },
        reconcile: { ...defaults, title: `Recover exact Cua ${id} acquisition`, dangerLevel: 'safe' as const,
            inputSchema: reconciliation.input, resultSchema: reconciliation.result,
            async run(input: unknown, context: PluginInvocationContext) {
                try { return reconciliation.result.parse(await run('reconcile', input, context)); }
                catch { return reconciliation.result.parse({ kind: 'pending', nativeOperationRef: {
                    contributionRef: { pluginId: 'happier.machine.cua', localId: id }, schemaVersion: 1,
                    value: byocReconciliationOperation(input) } }); }
            } },
        bootstrap: { ...defaults, title: `Resolve private Cua ${id} bootstrap`, dangerLevel: 'writesLocal' as const, confirmation: { title: 'Prepare this Cua resource for Happier?' },
            inputSchema: schemas.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { return MachineProvisionerBootstrapCarrierV1Schema.parse(await run('bootstrap', input, context)); } },
        inspect: { ...defaults, title: `Inspect exact Cua ${id} resource`, dangerLevel: 'safe' as const, inputSchema: schemas.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return MachineProvisionerObservationV1Schema.parse(await run('inspect', input, context)); }
                catch { return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: 'cua_native_resource_unknown' }); } } },
        power: { ...defaults, title: 'Change exact Cua BYOC power', dangerLevel: 'destructive' as const, confirmation: { title: 'Change this Cua resource’s power?' },
            inputSchema: schemas.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            async run(input: unknown, context: PluginInvocationContext) { try { return MachineProvisionerPowerResultV1Schema.parse(await run('power', input, context)); }
                catch { return { kind: 'unknown' as const, code: 'cua_native_power_unknown' }; } } },
        destroy: { ...defaults, title: 'Delete exact created Cua BYOC resource', dangerLevel: 'destructive' as const,
            confirmation: { title: 'Delete this Cua BYOC resource?', body: 'Deletes only the exact created native resource.' },
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
export function remoteProvisioner(): MachineProvisionerAuthorDefinitionV1 {
    return { title: 'Cua BYOC', icon: 'server', resourceKind: 'cua-byoc-resource', schemaVersion: 1, enrollmentRole: 'sandbox',
        kindTitle: machinePresentationLabel('byocKind'),
        description: machinePresentationLabel('byocDescription'),
        launchSchema: ByocLaunchV1Schema.jsonSchema,
        resourceSchema: ByocResourceV1Schema.jsonSchema,
        platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'managedDependency', id: 'cua-cli' }],
        billing: { location: 'cloud', stoppedBilling: 'unknown' },
        retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: `${id}-check`, options: `${id}-options`, acquire: `${id}-acquire`, bootstrap: `${id}-bootstrap`, inspect: `${id}-inspect`,
            power: `${id}-power`, destroy: `${id}-destroy` },
        reconciliation: { action: `${id}-reconcile`, nativeOperationSchema: ByocNativeOperationV1Schema.jsonSchema },
        bootstrapTransport: { kind: 'native', exec: `${id}-exec`, putFile: `${id}-put-file` } };
}
function lazyAccount(kind: 'cloud' | 'cua'): ConnectedAccountRuntime {
    const runtime = async () => (await import('./remoteConnection.js')).connectedAccountRuntime(kind);
    return { authentication: { modes: {
        native: { kind: 'manual', async complete(input, context, options) {
            const mode = (await runtime()).authentication.modes.native;
            if (mode.kind !== 'manual') throw new Error('cua_auth_mode_mismatch');
            return mode.complete(input, context, options);
        } } } },
        async status(context, options) { return (await runtime()).status(context, options); },
        async refresh(context, options) { return (await runtime()).refresh(context, options); },
        async revoke(context, options) { return (await runtime()).revoke(context, options); },
        async materialize(request, context, options) { return (await runtime()).materialize(request, context, options); } };
}
const nativeMode = { id: 'native', kind: 'manual', title: 'Existing native setup', outcomeReconciliation: 'none',
    fields: [], configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{ id: 'nativeHome',
        title: 'Native Cua home directory', schema: { type: 'string', minLength: 1 }, required: true, secret: false }] } } as const;
export const remoteAccounts = {
    'cloud-native': { declaration: { title: CUA_ACCOUNT_NAMES.cloud, ui: { category: 'cloud-machines' as const }, authentication: { defaultModeId: 'native', modes: [{ ...nativeMode,
        setup: { url: 'https://cua.ai/docs/cua-sdk/guides/your-cloud', createKeyTitle: 'Read Cua cloud setup instructions',
            checklist: ['On the Machine running Cua, configure your AWS, Google Cloud or Modal credentials and connect that provider with cua cloud connect.', 'Use cua cloud status to check the connection, then enter the absolute CUA_HOME directory used for that setup.'],
            shapeHint: 'This selects existing cloud-provider setup in a native Cua home directory; no API key is pasted here.' },
    }] } }, runtime: lazyAccount('cloud') },
    'cua-account': { declaration: { title: CUA_ACCOUNT_NAMES.cua, ui: { category: 'cloud-machines' as const }, authentication: { defaultModeId: 'native', modes: [{ ...nativeMode,
        setup: { url: 'https://cua.ai/docs/cua-cli/guides/authentication', createKeyTitle: 'Read Cua sign-in instructions',
            checklist: ['On the Machine running Cua, sign in with cua auth login using CUA_CREDENTIAL_STORE=file and the CUA_HOME directory you want to connect.', 'Enter that absolute CUA_HOME directory here, matching the directory selected for the cloud account.'],
            shapeHint: 'This selects an existing native Cua sign-in; no API key is pasted here.' },
    }] } }, runtime: lazyAccount('cua') },
};
