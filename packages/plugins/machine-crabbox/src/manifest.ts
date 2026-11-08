import { definePlugin } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolLiteral } from '@happier-dev/plugin-sdk/protocol';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID, CRABBOX_COORDINATOR_PROVISIONER_ID, CRABBOX_CONNECTION_PURPOSE, CRABBOX_CONNECTION_SERVICE, CRABBOX_DEPENDENCY_ID } from './machine/constants.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema, CrabboxOptionsInputV1Schema,
  CRABBOX_RECONCILIATION as reconciliation, CRABBOX_ROLE_SCHEMAS, type CrabboxResourceV1, type CrabboxLaunchV1 } from './machine/schemas.js';
import { CRABBOX_OPTIONS_INPUT_HINTS } from './machine/configuration.js';
import { CRABBOX_COORDINATOR_ACTIONS } from './machine/account.js';


export { CRABBOX_ROLE_SCHEMAS } from './machine/schemas.js';
const networkAccess = 'crabbox-native-http';
const processAccess = 'crabbox-native-process';
const defaults = { scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' },
  hostAccess: [CRABBOX_CONNECTION_PURPOSE, networkAccess, processAccess] } as const;
const effectConfirmation = { confirmation: { title: 'Approve this Crabbox operation?',
  body: 'Operate the reviewed native lease using its selected connection and host-owned SSH credential.', confirmLabel: 'Continue' } } as const;
const destroyConfirmation = { confirmation: { title: 'Delete this Crabbox lease?',
  body: 'Request native cleanup of this exact lease. Its compute and non-retained filesystem will be lost when deletion completes.', confirmLabel: 'Delete lease' } } as const;
async function inspectedProvider(context: PluginInvocationContext) {
  return (await import('./machine/roles.js')).inspectedCrabboxProvider(context);
}

async function directProvider(context: PluginInvocationContext) {
  return (await import('./machine/direct.js')).createCrabboxDirectProvider(context);
}

async function nativeProvider(selection: CrabboxLaunchV1 | CrabboxResourceV1, context: PluginInvocationContext) {
  return selection.transport === 'direct' ? directProvider(context) : inspectedProvider(context);
}

export const CRABBOX_MACHINE_PROVISIONER = {
  title: 'Crabbox', icon: 'hard-drives', resourceKind: 'crabbox-lease', schemaVersion: 1,
  enrollmentRole: 'sandbox',
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: CrabboxLaunchV1Schema.jsonSchema, resourceSchema: CrabboxResourceV1Schema.jsonSchema, resourceIdPath: 'leaseId',
  platforms: ['darwin', 'linux', 'win32'], browserReachable: false, prerequisites: [],
  billing: { location: 'local', stoppedBilling: 'unknown' }, retention: { supportedIntents: ['delete'] },
  credentialPurposeRequirements: [{ purpose: CRABBOX_CONNECTION_PURPOSE, optionalWhen: { op: 'and', all: [
    { op: 'eq', path: 'transport', value: 'direct' }, { op: 'eq', path: 'backendId', value: 'local-container' },
  ] } }],
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: CrabboxResourceV1Schema.jsonSchema },
} satisfies MachineProvisionerAuthorDefinitionV1;

/** Existing native refs stay native; new Account leases retain their own role binding. */
export const CRABBOX_COORDINATOR_PROVISIONER = {
  ...CRABBOX_MACHINE_PROVISIONER,
  title: 'Crabbox coordinator', bootstrapCredential: { kind: 'ssh' },
  enrollmentRole: 'server', billing: { location: 'cloud', stoppedBilling: 'unknown' },
  credentialPurposeRequirements: [],
  actions: { check: 'coordinator-check', options: 'coordinator-options', acquire: 'coordinator-acquire',
    bootstrap: 'coordinator-bootstrap', inspect: 'coordinator-inspect', destroy: 'coordinator-destroy' },
  reconciliation: { action: 'coordinator-reconcile', nativeOperationSchema: CrabboxResourceV1Schema.jsonSchema },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const CRABBOX_PLUGIN = definePlugin({
  id: CRABBOX_PLUGIN_ID, version: '0.0.0', displayName: 'Crabbox Machines',
  description: 'Native Crabbox leases with exact resource custody and host-owned SSH enrollment.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
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
  }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: processAccess, capability: 'process', reason: 'Operate the exact native retained lease from private non-repository staging.',
      scope: { executables: [{ kind: 'managedDependency', id: CRABBOX_DEPENDENCY_ID }, { kind: 'systemTool', id: 'ssh-keyscan' }],
        envKeys: ['PATH', 'Path', 'SystemRoot', 'XDG_STATE_HOME', 'CRABBOX_CONFIG', 'GIT_CEILING_DIRECTORIES'] } },
    { id: CRABBOX_CONNECTION_PURPOSE, capability: 'connectedAccounts', reason: 'Use the reviewed Crabbox coordinator connection.',
      scope: { serviceRefs: [CRABBOX_CONNECTION_SERVICE.localId], operations: ['select', 'use'], materializationKinds: ['environment'] } },
    { id: networkAccess, capability: 'network', reason: 'Inspect the exact native lease on the selected coordinator.',
      scope: { targets: [{ kind: 'connectedAccountOrigin', service: CRABBOX_CONNECTION_SERVICE.localId }], methods: ['GET', 'PUT', 'POST'] } },
  ], optional: [] },
  managedDependencies: { [CRABBOX_DEPENDENCY_ID]: { id: CRABBOX_DEPENDENCY_ID, title: 'Crabbox', executable: 'crabbox',
    platforms: ['macos', 'linux', 'windows'], architectures: ['x64', 'arm64'],
    sources: [{ kind: 'system', executableNames: ['crabbox'], versionArguments: ['--version'] }, {
      // v0.72.0 release API digests and .goreleaser.yaml: retain the complete
      // archive, including crabbox-runtime beside its real executable.
      kind: 'pinnedArchive', installId: 'dep.crabbox', version: '0.72.0', assetsByPlatform: {
        'darwin-x64': { archiveUrl: 'https://github.com/openclaw/crabbox/releases/download/v0.72.0/crabbox_0.72.0_darwin_amd64.tar.gz',
          sha256: '10ed0d477faafa3b426ccf2891231f885f140622f8e71d845ad197536e4ae674', executableSubpath: 'crabbox' },
        'darwin-arm64': { archiveUrl: 'https://github.com/openclaw/crabbox/releases/download/v0.72.0/crabbox_0.72.0_darwin_arm64.tar.gz',
          sha256: '2bb34a557f89274ccdc186719452dda19038302a6eeeb54029a1e422336d78c2', executableSubpath: 'crabbox' },
        'linux-x64': { archiveUrl: 'https://github.com/openclaw/crabbox/releases/download/v0.72.0/crabbox_0.72.0_linux_amd64.tar.gz',
          sha256: 'aa984d3f0954bafc67eea534c2b2e2a47c3abe90edbe1395a709b451cef1d942', executableSubpath: 'crabbox' },
        'linux-arm64': { archiveUrl: 'https://github.com/openclaw/crabbox/releases/download/v0.72.0/crabbox_0.72.0_linux_arm64.tar.gz',
          sha256: '9e7f04d9869e357c36021bdf1f93783e3ae998979cce95f05ac15340e08c500b', executableSubpath: 'crabbox' },
        'win32-x64': { archiveUrl: 'https://github.com/openclaw/crabbox/releases/download/v0.72.0/crabbox_0.72.0_windows_amd64.zip',
          sha256: 'ed0b407ed7edb45bdf4f7eaf23096c971e46b8da264cc21ace2394d540898b19', executableSubpath: 'crabbox.exe' },
        'win32-arm64': { archiveUrl: 'https://github.com/openclaw/crabbox/releases/download/v0.72.0/crabbox_0.72.0_windows_arm64.zip',
          sha256: '3abcbebe121e111a5b1af782ceb518de4dea547e130308b731a03dcb742fa9a8', executableSubpath: 'crabbox.exe' },
      },
    }] } },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  connectedAccountDescriptors: { coordinator: {
    declaration: {
      title: 'Crabbox coordinator',
      ui: { category: 'cloud-machines' },
      authentication: {
        defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual',
          setup: { url: 'https://crabbox.sh/commands/login.html', createKeyTitle: 'Read coordinator sign-in instructions',
            checklist: ['Ask your Crabbox coordinator operator for its URL, organization namespace and a coordinator bearer token.', 'Enter that coordinator URL and namespace, then paste the token here.'],
            shapeHint: 'Use a coordinator user or shared operator token, not a cloud-provider API key.' },
          credentialFieldKeys: { token: 'token' },
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
  machineProvisioners: { [CRABBOX_PROVISIONER_ID]: CRABBOX_MACHINE_PROVISIONER,
    [CRABBOX_COORDINATOR_PROVISIONER_ID]: CRABBOX_COORDINATOR_PROVISIONER },
  actions: {
    ...CRABBOX_COORDINATOR_ACTIONS,
    install: { scopes: ['machine'], surfaces: ['ui', 'plugin'], execution: { target: 'daemon' }, title: 'Install Crabbox', dangerLevel: 'writesLocal',
      confirmation: { title: 'Install Crabbox on this computer?', body: 'Download the complete verified Crabbox distribution for this computer.', confirmLabel: 'Install' },
      inputSchema: CRABBOX_ROLE_SCHEMAS.checkInput, resultSchema: defineProtocolLiteral(null),
      async run(_input, context) {
        await context.services.managedServices.dependencies.ensure(CRABBOX_DEPENDENCY_ID, { signal: context.signal });
        return null;
      } },
    reconcile: { ...defaults, title: 'Recover exact Crabbox lease', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        return (await import('./machine/roles.js')).reconcileCrabbox(input, context, nativeProvider);
      } },
    check: { ...defaults, hostAccess: [processAccess, CRABBOX_CONNECTION_PURPOSE], title: 'Check Crabbox availability', dangerLevel: 'safe',
      inputSchema: CRABBOX_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        const coordinator = await (await import('./machine/roles.js')).checkCrabboxCoordinator(context);
        if (coordinator.available) return coordinator;
        try { await directProvider(context); return machineCheckPresentation({ available: true }); }
        catch (error) {
          const { CrabboxDependencyUnavailable } = await import('./machine/provider.js');
          if (!(error instanceof CrabboxDependencyUnavailable)) throw error;
          return machineCheckPresentation({ available: false, code: error.code, prerequisites: [{
            requirement: { kind: 'managedDependency', id: { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_DEPENDENCY_ID } },
            status: 'unavailable',
            repairAction: { action: { pluginId: CRABBOX_PLUGIN_ID, localId: 'install' }, input: {} },
          }] });
        }
      } },
    options: { ...defaults, title: 'List Crabbox native routes', dangerLevel: 'safe',
      inputSchema: CrabboxOptionsInputV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: CRABBOX_OPTIONS_INPUT_HINTS,
      async run(input, context) {
        return (await import('./machine/roles.js')).crabboxOptions(input, context, () => directProvider(context));
      } },
    acquire: { ...defaults, ...effectConfirmation, title: 'Acquire Crabbox lease', dangerLevel: 'writesRemote',
      inputSchema: CRABBOX_ROLE_SCHEMAS.acquireInput, resultSchema: CRABBOX_ROLE_SCHEMAS.acquireResult,
      // The host's retained connection basis fences this materialization before PUT.
      // The public native resource cannot carry that private endpoint, and a
      // changed connection must not mint another resource after a dropped reply.
      async run(input, context) {
        return (await import('./machine/roles.js')).acquireCrabbox(input, context, nativeProvider);
      } },
    bootstrap: { ...defaults, ...effectConfirmation, title: 'Resolve private Crabbox SSH carrier', dangerLevel: 'writesRemote',
      inputSchema: CRABBOX_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) {
        return (await import('./machine/roles.js')).bootstrapCrabbox(input, context, nativeProvider);
      } },
    inspect: { ...defaults, title: 'Inspect exact Crabbox lease', dangerLevel: 'safe',
      inputSchema: CRABBOX_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        return (await import('./machine/roles.js')).inspectCrabbox(input, context, nativeProvider);
      } },
    destroy: { ...defaults, ...destroyConfirmation, title: 'Release exact Crabbox lease', dangerLevel: 'destructive',
      inputSchema: reconciliation.destroyInput, resultSchema: reconciliation.destroyResult,
      async run(input, context) {
        return (await import('./machine/roles.js')).destroyCrabbox(input, context, nativeProvider);
      } },
  },
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
});
export const PLUGIN_MANIFEST = CRABBOX_PLUGIN.manifest;
