import { definePlugin } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID, CRABBOX_CONNECTION_PURPOSE, CRABBOX_CONNECTION_SERVICE } from './machine/constants.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema, CrabboxOptionsInputV1Schema } from './machine/schemas.js';
import { CRABBOX_OPTIONS_INPUT_HINTS } from './machine/configuration.js';
import { CRABBOX_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: CrabboxLaunchV1Schema, resource: CrabboxResourceV1Schema, nativeOperation: CrabboxResourceV1Schema });
export const CRABBOX_ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas({ launch: CrabboxLaunchV1Schema, resource: CrabboxResourceV1Schema }), acquireResult: reconciliation.result };
const networkAccess = 'crabbox-native-http';
const processAccess = 'crabbox-native-process';
const defaults = { scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' },
  hostAccess: [CRABBOX_CONNECTION_PURPOSE, networkAccess, processAccess] } as const;
const effectConfirmation = { confirmation: { title: 'Approve this Crabbox operation?',
  body: 'Operate the reviewed native lease using its selected connection and host-owned SSH credential.', confirmLabel: 'Continue' } } as const;
const destroyConfirmation = { confirmation: { title: 'Delete this Crabbox lease?',
  body: 'Request native cleanup of this exact lease. Its compute and non-retained filesystem will be lost when deletion completes.', confirmLabel: 'Delete lease' } } as const;
const custodyUnavailable = 'crabbox_connection_custody_unavailable';

async function inspectedProvider(context: PluginInvocationContext) {
  const [{ prepareCrabboxConnection }, { createCrabboxProvider }] = await Promise.all([
    import('./machine/connection.js'), import('./machine/provider.js'),
  ]);
  return createCrabboxProvider({ ...await prepareCrabboxConnection(context.services.connectedAccounts, context.services.http, context.signal),
    observedAt: context.invokedAtMs, signal: context.signal });
}

async function directProvider(context: PluginInvocationContext) {
  return (await import('./machine/direct.js')).createCrabboxDirectProvider(context);
}

export const CRABBOX_MACHINE_PROVISIONER = {
  title: 'Crabbox', icon: 'hard-drives', resourceKind: 'crabbox-lease', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: CrabboxLaunchV1Schema.jsonSchema, resourceSchema: CrabboxResourceV1Schema.jsonSchema,
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  billing: { location: 'cloud', stoppedBilling: 'unknown' }, retention: { supportedIntents: ['delete'] },
  credentialPurposeRequirements: [{ purpose: CRABBOX_CONNECTION_PURPOSE, optionalWhen: { op: 'and', all: [
    { op: 'eq', path: 'transport', value: 'direct' }, { op: 'eq', path: 'backendId', value: 'local-container' },
  ] } }],
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: CrabboxResourceV1Schema.jsonSchema },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const CRABBOX_PLUGIN = definePlugin({
  id: CRABBOX_PLUGIN_ID, version: '0.0.0', displayName: 'Crabbox Machines',
  description: 'Native Crabbox leases with exact resource custody and host-owned SSH enrollment.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: processAccess, capability: 'process', reason: 'Operate the exact native retained lease from private non-repository staging.',
      scope: { executables: [{ kind: 'managedDependency', id: 'crabbox-cli' }, { kind: 'systemTool', id: 'ssh-keyscan' }],
        envKeys: ['PATH', 'Path', 'SystemRoot', 'XDG_STATE_HOME', 'CRABBOX_CONFIG', 'GIT_CEILING_DIRECTORIES'] } },
    { id: CRABBOX_CONNECTION_PURPOSE, capability: 'connectedAccounts', reason: 'Use the reviewed Crabbox coordinator connection.',
      scope: { serviceRefs: [CRABBOX_CONNECTION_SERVICE.localId], operations: ['select', 'use'], materializationKinds: ['environment'] } },
    { id: networkAccess, capability: 'network', reason: 'Inspect the exact native lease on the selected coordinator.',
      scope: { targets: [{ kind: 'connectedAccountOrigin', service: CRABBOX_CONNECTION_SERVICE.localId }], methods: ['GET', 'PUT', 'POST'] } },
  ], optional: [] },
  managedDependencies: { 'crabbox-cli': { id: 'crabbox-cli', title: 'Crabbox', executable: 'crabbox',
    platforms: ['macos', 'linux', 'windows'], architectures: ['x64', 'arm64'],
    sources: [{ kind: 'system', executableNames: ['crabbox'], versionArguments: ['--version'] }] } },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  connectedAccountDescriptors: { coordinator: {
    declaration: {
      title: 'Crabbox coordinator',
      authentication: {
        defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual',
          directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, outcomeReconciliation: 'none',
          configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
            { id: 'endpoint', title: 'Coordinator URL', semantic: 'connectedAccountBase', required: true, secret: false, schema: { type: 'string', minLength: 1 } },
            { id: 'namespace', title: 'Namespace', required: true, secret: false, schema: { type: 'string', minLength: 1 } },
          ] },
          fields: [{ id: 'token', title: 'Coordinator token', schema: { type: 'string', minLength: 1 }, secret: true }],
        }],
      },
    },
    runtime: {
      async refresh(context, options) { return (await import('./machine/connection.js')).CRABBOX_CONNECTED_ACCOUNT_RUNTIME.refresh(context, options); },
      async revoke(context, options) { return (await import('./machine/connection.js')).CRABBOX_CONNECTED_ACCOUNT_RUNTIME.revoke(context, options); },
      async status(context, options) { return (await import('./machine/connection.js')).CRABBOX_CONNECTED_ACCOUNT_RUNTIME.status(context, options); },
      async materialize(request, context, options) { return (await import('./machine/connection.js')).CRABBOX_CONNECTED_ACCOUNT_RUNTIME.materialize(request, context, options); },
      authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
        const runtime = (await import('./machine/connection.js')).CRABBOX_CONNECTED_ACCOUNT_RUNTIME.authentication.modes.token;
        if (!runtime || runtime.kind !== 'manual') throw new Error('Crabbox authentication mode unavailable');
        return runtime.complete(input, context, options);
      } } } },
    },
  } },
  machineProvisioners: { [CRABBOX_PROVISIONER_ID]: CRABBOX_MACHINE_PROVISIONER },
  actions: {
    reconcile: { ...defaults, title: 'Recover exact Crabbox lease', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        if (!('nativeOperation' in input)) return { kind: 'unknown' as const, recovery: {
          reference: (await import('./machine/provider.js')).crabboxLeaseId(input.correlation.managedId), reason: 'native_correlation_unqualified' } };
        try { return await (input.nativeOperation.transport === 'direct' ? await directProvider(context) : await inspectedProvider(context)).reconcile(input.nativeOperation); }
        catch { return { kind: 'pending' as const, nativeOperationRef: { contributionRef: { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_PROVISIONER_ID },
          schemaVersion: 1, value: input.nativeOperation } }; }
      } },
    check: { ...defaults, hostAccess: [processAccess], title: 'Check Crabbox availability', dangerLevel: 'safe',
      inputSchema: CRABBOX_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { await inspectedProvider(context); return machineCheckPresentation({ available: true }); }
        catch {
          try { await directProvider(context); return machineCheckPresentation({ available: true }); }
          catch { return machineCheckPresentation({ available: false, code: 'credential_unavailable' }); }
        }
      } },
    options: { ...defaults, title: 'List Crabbox native routes', dangerLevel: 'safe',
      inputSchema: CrabboxOptionsInputV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: CRABBOX_OPTIONS_INPUT_HINTS,
      async run(input, context) {
        const query = CrabboxOptionsInputV1Schema.parse(input);
        const titles = { aws: 'AWS', gcp: 'Google Cloud', hetzner: 'Hetzner', 'local-container': 'Local container', 'blacksmith-testbox': 'Blacksmith Testbox' };
        const selected = CrabboxLaunchV1Schema.safeParse(query);
        let coordinatorNamespace: string | undefined;
        let localAvailable = false;
        try { coordinatorNamespace = (await (await import('./machine/connection.js')).prepareCrabboxConnection(
          context.services.connectedAccounts, context.services.http, context.signal)).connection.namespace; } catch { /* Missing selected credentials are native unavailability. */ }
        try { await directProvider(context); localAvailable = true; } catch { /* No unqualified native executable fallback. */ }
        if (query.backendId) {
          const available = selected.success && (selected.data.transport === 'coordinator'
            ? selected.data.namespace === coordinatorNamespace : selected.data.backendId === 'local-container' && localAvailable);
          return { choices: [{ id: query.backendId, title: titles[query.backendId], available,
            ...(available && selected.success ? { launch: selected.data } : {}) }] };
        }
        return { choices: [
          ...(['aws', 'gcp', 'hetzner'] as const).map(id => ({ id, title: titles[id], available: coordinatorNamespace !== undefined })),
          { id: 'local-container', title: titles['local-container'], available: localAvailable },
          { id: 'blacksmith-testbox', title: titles['blacksmith-testbox'], available: false },
        ] };
      } },
    acquire: { ...defaults, ...effectConfirmation, title: 'Acquire Crabbox lease', dangerLevel: 'writesRemote',
      inputSchema: CRABBOX_ROLE_SCHEMAS.acquireInput, resultSchema: CRABBOX_ROLE_SCHEMAS.acquireResult,
      // The host's retained connection basis fences this materialization before PUT.
      // The public native resource cannot carry that private endpoint, and a
      // changed connection must not mint another resource after a dropped reply.
      async run(input, context) {
        if (input.launch.transport === 'direct' && input.launch.backendId !== 'local-container') return { kind: 'rejected' as const, code: 'provider_unavailable' as const };
        if (!input.managedId || !input.bootstrapPublicKey) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        try { return await (input.launch.transport === 'direct' ? await directProvider(context) : await inspectedProvider(context)).acquire(input); }
        catch { return { kind: 'rejected' as const, code: 'credential_unavailable' as const }; }
      } },
    bootstrap: { ...defaults, ...effectConfirmation, title: 'Resolve private Crabbox SSH carrier', dangerLevel: 'writesRemote',
      inputSchema: CRABBOX_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) {
        return await (input.resource.transport === 'direct' ? await directProvider(context) : await inspectedProvider(context)).bootstrap(input);
      } },
    inspect: { ...defaults, title: 'Inspect exact Crabbox lease', dangerLevel: 'safe',
      inputSchema: CRABBOX_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        // A bound physical identity can be checked without assuming a changed
        // coordinator points at the resource retained by a lost acquisition.
        if (!input.resource.nativeInstanceId) return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: custodyUnavailable };
        try { return await (input.resource.transport === 'direct' ? await directProvider(context) : await inspectedProvider(context)).inspect(input.resource); }
        catch { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: 'credential_unavailable' }; }
      } },
    destroy: { ...defaults, ...destroyConfirmation, title: 'Release exact Crabbox lease', dangerLevel: 'destructive',
      inputSchema: reconciliation.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        const resource = 'resource' in input ? input.resource : input.nativeOperation;
        try { return await (resource.transport === 'direct' ? await directProvider(context) : await inspectedProvider(context)).destroy(resource); }
        catch { return { kind: 'refused' as const, code: 'credential_unavailable' }; }
      } },
  },
  ui: { translations: CRABBOX_UI_TRANSLATION_BUNDLES },
});
export const PLUGIN_MANIFEST = CRABBOX_PLUGIN.manifest;
