import { Buffer } from 'node:buffer';
import { machinePresentationLabel, machineCheckPresentation, configurationLabel } from './ui/translations.js';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { observeMachineProvisionerNativeRead, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
    MachineProvisionerNativeExecResultV1Schema, MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
    MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema, projectMachineProvisionerActionFailure,
    type MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CuaLocalProvisionerSchemas as schemas, CuaLocalNativeOperationV1Schema, CuaLocalReconciliationSchemas, localReconciliationOperation } from './machine/localProvisionerSchemas.js';
import { CuaLocalLaunchV1Schema, CuaLocalOptionsQueryV1Schema, CuaLocalResourceV1Schema,
    type CuaLocalLaunchV1, type CuaLocalResourceV1, type CuaLocalOptionsQueryV1 } from './machine/schemas.js';
import type { CuaLocalProvisionerId } from './machine/localProvisioner.js';
import { remoteAccounts, remoteProvisioner, remoteRoles } from './machine/remoteDeclarations.js';
import { CUA_DEPENDENCY_ID as dependencyId, CUA_CLI_MINIMUM_VERSION, CuaCliUnavailable, resolveCuaExecutable } from './machine/nativeDependency.js';
import { CUA_CLI_ARCHIVE_SOURCE } from './machine/nativeInstall.js';
import { defineProtocolLiteral } from '@happier-dev/plugin-sdk/protocol';
import { CuaPreparationInput, CuaPreparationReference, CuaPreparationSchemas, createCuaPreparation } from './machine/preparation.js';

const pluginId = 'happier.machine.cua';
const processAccess = 'cua-native-process';
const installAction = 'install';
const cliRequirement = { kind: 'managedDependency', id: { pluginId, localId: dependencyId } } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;

function unavailableCliPrerequisite(error: CuaCliUnavailable) {
    return { requirement: cliRequirement, status: 'unavailable' as const, ...(error.installable ? {
        repairAction: { action: { pluginId, localId: installAction }, input: {} },
    } : {}) };
}

async function nativeClient(context: PluginInvocationContext) {
    const executable = await resolveCuaExecutable(context);
    const { createCuaNativeClient } = await import('./machine/nativeClient.js');
    return createCuaNativeClient({ exec: context.services.exec, executable });
}
async function provider(id: CuaLocalProvisionerId, context: PluginInvocationContext) {
    const { createCuaLocalProvisioner } = await import('./machine/localProvisioner.js');
    return createCuaLocalProvisioner(await nativeClient(context), id, context.invokedAtMs, context.signal);
}
function bytes(encoded: string) {
    return Buffer.from(encoded, 'base64');
}
function roles(id: CuaLocalProvisionerId) {
    return {
        prepareBuild: { ...defaults, title: 'Prepare a clean Cua checkpoint', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Build this prepared Cua image?' },
            inputSchema: CuaPreparationSchemas.buildInput, resultSchema: CuaPreparationSchemas.buildResult,
            async run(input: ReturnType<typeof CuaPreparationSchemas.buildInput.parse>, context: PluginInvocationContext) {
                return createCuaPreparation(await nativeClient(context), id, context.invokedAtMs, context.signal).build(input.operationId, input.input);
            } },
        prepareInspect: { ...defaults, title: 'Inspect an owned Cua checkpoint', dangerLevel: 'safe' as const,
            inputSchema: CuaPreparationSchemas.inspectInput, resultSchema: CuaPreparationSchemas.inspectResult,
            async run(input: ReturnType<typeof CuaPreparationSchemas.inspectInput.parse>, context: PluginInvocationContext) {
                const value = 'nativeOperation' in input ? input.nativeOperation.value : { operationId: input.operationId, launch: input.launch };
                return createCuaPreparation(await nativeClient(context), id, context.invokedAtMs, context.signal).inspect(value);
            } },
        prepareDestroy: { ...defaults, title: 'Delete an owned Cua checkpoint', dangerLevel: 'destructive' as const,
            confirmation: { title: 'Delete this prepared Cua image?' },
            inputSchema: CuaPreparationSchemas.destroyInput, resultSchema: CuaPreparationSchemas.destroyResult,
            async run(input: ReturnType<typeof CuaPreparationSchemas.destroyInput.parse>, context: PluginInvocationContext) {
                // The admitted union requires at least one qualified reference.
                const value = input.artifact ? input.artifact.value : input.nativeOperation!.value;
                return createCuaPreparation(await nativeClient(context), id, context.invokedAtMs, context.signal).destroy(value);
            } },
        stream: { ...defaults, title: 'Open a private Cua child channel', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Open this Cua child channel?' },
            inputSchema: schemas.streamInput, resultSchema: MachineProvisionerNativeStreamResultV1Schema,
            async run(input: ReturnType<typeof schemas.streamInput.parse>, context: PluginInvocationContext) {
                const channel = await (await provider(id, context)).stream(input.resource, input.argv, context.services.exec);
                try { return { termination: await channel.waitForExit() }; }
                finally { await channel.dispose(); }
            } },
        reconcile: { ...defaults, title: 'Recover the exact Cua local allocation', dangerLevel: 'safe' as const,
            inputSchema: CuaLocalReconciliationSchemas.input, resultSchema: CuaLocalReconciliationSchemas.result,
            async run(input: ReturnType<typeof CuaLocalReconciliationSchemas.input.parse>, context: PluginInvocationContext) {
                const operation = localReconciliationOperation(id, input);
                try { return await (await provider(id, context)).reconcile(operation); }
                catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'pending' as const, nativeOperationRef: { contributionRef: { pluginId, localId: id },
                    schemaVersion: 1, value: operation } })); }
            } },
        check: { ...defaults, title: 'Check Cua local runtime', dangerLevel: 'safe' as const,
            inputSchema: schemas.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
            async run(_input: Readonly<Record<string, never>>, context: PluginInvocationContext) {
                try { return machineCheckPresentation({ ...await (await provider(id, context)).check(), prerequisites: [{ requirement: cliRequirement, status: 'available' as const }] }); }
                catch (error) {
                    // Only a definitive answer about the CLI is a check result. A failed, aborted or timed-out read
                    // propagates as a failed check, so the surface offers Retry instead of claiming "Not installed".
                    if (!(error instanceof CuaCliUnavailable)) throw error;
                    return machineCheckPresentation({ available: false, prerequisites: [unavailableCliPrerequisite(error)], code: error.code });
                }
            } },
        options: { ...defaults, title: 'Read Cua local image and runtime choices', dangerLevel: 'safe' as const,
            inputSchema: CuaLocalOptionsQueryV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
            inputHints: { fields: [
                // Runtime and image are picked from the choices this read returns, never typed as filters.
                // Cua CLI 0.17.0 documents no defaults for --cpu/--memory: https://cua.ai/docs/cua-cli/reference/cli/sandboxes
                { path: 'size.cpu', role: 'cpu' as const, title: configurationLabel('cpu'), widget: 'integer' as const, required: true },
                { path: 'size.memoryBytes', role: 'memory' as const, title: configurationLabel('memoryBytes'), widget: 'integer' as const, unit: 'bytes' as const, required: true },
                // The disk follows the chosen image; only a Space may be given its own.
                ...(id === 'local-space' ? [{ path: 'size.diskBytes', role: 'disk' as const, title: configurationLabel('diskBytes'), widget: 'integer' as const, unit: 'bytes' as const }] : []),
            ] },
            async run(input: CuaLocalOptionsQueryV1, context: PluginInvocationContext) {
                try { return await (await provider(id, context)).options(input); }
                catch (error) {
                    if (!(error instanceof CuaCliUnavailable)) throw error;
                    return {
                        base: { launch: {}, available: false, prerequisites: [unavailableCliPrerequisite(error)],
                            unavailableReason: { code: error.code, status: machinePresentationLabel(error.code) } },
                        dimensions: { size: [], image: [], location: [], network: [], duration: [] },
                    };
                }
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
                catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'rejected' as const, code: 'provider_unavailable' as const })); }
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
                catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: 'cua_native_unavailable' })); }
            } },
        power: { ...defaults, title: 'Change Cua local machine power', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Change this Cua machine’s power?' },
            inputSchema: schemas.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            async run(input: ReturnType<typeof schemas.powerInput.parse>, context: PluginInvocationContext) {
                try { return await (await provider(id, context)).power(input.resource, input.intent); }
                catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'cua_native_unavailable' })); }
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
                catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'cua_cleanup_incomplete' })); }
            } },
        exec: { ...defaults, title: 'Execute private Cua bootstrap IO', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Run private Cua bootstrap command?' },
            inputSchema: schemas.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
            async run(input: ReturnType<typeof schemas.execInput.parse>, context: PluginInvocationContext) {
                const result = await (await provider(id, context)).exec(input.resource, input.argv,
                    input.inputBase64 === undefined ? undefined : bytes(input.inputBase64), input.timeoutMs,
                    input.processConfig, context.services.managedServices);
                if ('kind' in result) return result;
                return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
                    stderrBase64: Buffer.from(result.stderr).toString('base64'),
                    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
            } },
        putFile: { ...defaults, title: 'Write private Cua bootstrap file', dangerLevel: 'writesLocal' as const,
            confirmation: { title: 'Write this private Cua bootstrap file?' },
            inputSchema: schemas.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
            async run(input: ReturnType<typeof schemas.putFileInput.parse>, context: PluginInvocationContext) {
                try { return await (await provider(id, context)).putFile(input.resource, input.guestPath, bytes(input.bytesBase64), input.mode); }
                catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'cua_native_file_unavailable' })); }
            } },
    };
}
const sandbox = roles('local-sandbox');
const space = roles('local-space');
const byoc = remoteRoles();
function provisioner(id: CuaLocalProvisionerId): MachineProvisionerAuthorDefinitionV1 {
    const prefix = id === 'local-space' ? 'space' : 'sandbox';
    return { title: 'Cua', icon: 'desktop', enrollmentRole: 'sandbox',
        resourceKind: id === 'local-space' ? 'cua-local-space' : 'cua-local-sandbox', schemaVersion: 1,
        kindTitle: machinePresentationLabel(id === 'local-space' ? 'spaceKind' : 'kind'),
        description: machinePresentationLabel(id === 'local-space' ? 'spaceDescription' : 'description'),
        launchSchema: CuaLocalLaunchV1Schema.jsonSchema, resourceSchema: CuaLocalResourceV1Schema.jsonSchema, resourceIdPath: 'sandboxId',
        platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'managedDependency', id: dependencyId }],
        // The shared launch schema includes unprivileged container runtimes;
        // it cannot promise nested Agent-native isolation for every choice.
        sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: false },
        billing: { location: 'local', stoppedBilling: 'not-billed' },
        retention: { supportedIntents: ['start', 'suspend', 'resume', 'delete'] },
        actions: { check: `${prefix}-check`, options: `${prefix}-options`, acquire: `${prefix}-acquire`, bootstrap: `${prefix}-bootstrap`,
            inspect: `${prefix}-inspect`, power: `${prefix}-power`, destroy: `${prefix}-destroy` },
        reconciliation: { action: `${prefix}-reconcile`, nativeOperationSchema: CuaLocalNativeOperationV1Schema.jsonSchema },
        preparation: { inputSchema: CuaPreparationInput.jsonSchema, artifactSchema: CuaPreparationReference.jsonSchema,
            nativeOperationSchema: CuaPreparationReference.jsonSchema, artifactLaunchPath: 'launch',
            actions: { build: `${prefix}-prepare-build`, inspect: `${prefix}-prepare-inspect`, destroy: `${prefix}-prepare-destroy` } },
        bootstrapTransport: { kind: 'native', exec: `${prefix}-exec`, putFile: `${prefix}-put-file`, stream: `${prefix}-stream` } };
}
export const CUA_PLUGIN = definePlugin({
    id: pluginId, version: '0.0.0', displayName: 'Cua Machines',
    // The provider's own mark beside its name in Machines: Cua's mark from github.com/trycua/cua img/logo_black.svg (MIT, Copyright (c) 2025 Cua AI, Inc.), monochrome.
    brand: { iconResourceId: 'brand-icon', monochrome: true },
    resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
      "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
      "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
      "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
      "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
      "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
      "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
      "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
      "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
      "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
      "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
      "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
      "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
    },
    description: 'Exact Cua local and BYOC resources with private native bootstrap IO.', entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
    hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Operate only the reviewed native Cua resource.',
        scope: { executables: [{ kind: 'managedDependency', id: dependencyId }], envKeys: ['HOME'] } },
        { id: 'cloud-account', capability: 'connectedAccounts', reason: 'Use only the captured native cloud setup.',
            scope: { serviceRefs: ['cloud-native'], operations: ['use'], materializationKinds: ['environment'] } },
        { id: 'cua-account', capability: 'connectedAccounts', reason: 'Use only the captured Cua login.',
            scope: { serviceRefs: ['cua-account'], operations: ['use'], materializationKinds: ['environment'] } },
    ], optional: [] },
    connectedAccountDescriptors: remoteAccounts,
    managedDependencies: { [dependencyId]: { id: dependencyId, title: 'Cua', executable: 'cua',
        description: 'Native Cua CLI; native components retain their own license and runtime prerequisites.',
        sources: [{ kind: 'system', executableNames: ['cua'], versionArguments: ['--version'], minimumVersion: CUA_CLI_MINIMUM_VERSION }, CUA_CLI_ARCHIVE_SOURCE] } },
    ui: { translations: [
      { locale: "en", resourceId: "i18n-en" },
      { locale: "de", resourceId: "i18n-de" },
      { locale: "ru", resourceId: "i18n-ru" },
      { locale: "pl", resourceId: "i18n-pl" },
      { locale: "es", resourceId: "i18n-es" },
      { locale: "fr", resourceId: "i18n-fr" },
      { locale: "it", resourceId: "i18n-it" },
      { locale: "pt", resourceId: "i18n-pt" },
      { locale: "ca", resourceId: "i18n-ca" },
      { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
      { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
      { locale: "ja", resourceId: "i18n-ja" },
    ] },
    machineProvisioners: { 'local-sandbox': provisioner('local-sandbox'), 'local-space': provisioner('local-space'),
        byoc: remoteProvisioner() },
    actions: {
        [installAction]: { scopes: ['machine'], surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], execution: { target: 'daemon' },
            title: 'Install Cua', dangerLevel: 'writesLocal',
            confirmation: { title: 'Install Cua on this computer?',
                body: 'Download the verified official Cua CLI release for this computer. Native runtime dependencies and their licenses remain separate; this does not elevate privileges or configure virtualization.', confirmLabel: 'Install' },
            inputSchema: schemas.checkInput, resultSchema: defineProtocolLiteral(null),
            async run(_input, context) {
                await context.services.managedServices.dependencies.ensure(dependencyId, { signal: context.signal });
                return null;
            } },
        'byoc-check': byoc.check, 'byoc-options': byoc.options, 'byoc-acquire': byoc.acquire,
        'byoc-reconcile': byoc.reconcile, 'byoc-bootstrap': byoc.bootstrap, 'byoc-inspect': byoc.inspect,
        'byoc-power': byoc.power, 'byoc-destroy': byoc.destroy, 'byoc-exec': byoc.exec, 'byoc-put-file': byoc.putFile,
        'sandbox-reconcile': sandbox.reconcile, 'space-reconcile': space.reconcile,
        'sandbox-stream': sandbox.stream, 'space-stream': space.stream,
        'sandbox-prepare-build': sandbox.prepareBuild, 'sandbox-prepare-inspect': sandbox.prepareInspect, 'sandbox-prepare-destroy': sandbox.prepareDestroy,
        'space-prepare-build': space.prepareBuild, 'space-prepare-inspect': space.prepareInspect, 'space-prepare-destroy': space.prepareDestroy,
        'sandbox-check': sandbox.check, 'sandbox-options': sandbox.options, 'sandbox-acquire': sandbox.acquire,
        'sandbox-bootstrap': sandbox.bootstrap, 'sandbox-inspect': sandbox.inspect, 'sandbox-power': sandbox.power,
        'sandbox-destroy': sandbox.destroy, 'sandbox-exec': sandbox.exec, 'sandbox-put-file': sandbox.putFile,
        'space-check': space.check, 'space-options': space.options, 'space-acquire': space.acquire,
        'space-bootstrap': space.bootstrap, 'space-inspect': space.inspect, 'space-power': space.power,
        'space-destroy': space.destroy, 'space-exec': space.exec, 'space-put-file': space.putFile,
    },
});
export const PLUGIN_MANIFEST = CUA_PLUGIN.manifest;
