import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { CODER_CLI_INSTALL_ACTION } from './machine/cliPrerequisite.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  projectMachineProvisionerActionFailure, type MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CODER_CONNECTED_ACCOUNT_RUNTIME, CODER_PORTABLE_ACCOUNT_RUNTIME } from './machine/connection.js';
import { ACCOUNT_PURPOSE, ACCOUNT_SERVICE, CONTRIBUTION, DEPENDENCY_ID, BILLING, RETENTION,
  ROLE_SCHEMAS, RECONCILIATION, CoderLaunchSchema, CoderOptionsSchema, CoderResourceSchema, CoderOperationSchema } from './machine/schemas.js';
export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const networkAccess = 'coder-native-http';
const processAccess = 'coder-native-process';
const defaults = { scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' },
  hostAccess: [ACCOUNT_PURPOSE, networkAccess, processAccess] } as const;
const confirmation = { title: 'Manage this Coder workspace?', body: 'Coder templates control compute, storage and billing. Delete requests native destruction of this workspace.' };
const runtime = async (context: PluginInvocationContext) => (await import('./machine/runtime.js')).coderRuntime(context);
const failure = <const T>(error: unknown, fallback: T) => projectMachineProvisionerActionFailure(error, () => fallback);

export const MACHINE_PROVISIONER = {
  title: 'Coder', icon: 'terminal', resourceKind: 'coder-workspace', schemaVersion: 1, enrollmentRole: 'server',
  kindTitle: 'Workspace', description: 'A workspace on your Coder deployment, enrolled as an ordinary Happier Machine.',
  launchSchema: CoderLaunchSchema.jsonSchema, resourceSchema: CoderResourceSchema.jsonSchema, resourceIdPath: 'workspaceId',
  sessionPlacement: { kind: 'controller-local', when: { op: 'eq', path: 'workspaceHost', value: 'controller-local' },
    // Template placement does not qualify guest kernel or nested sandbox capabilities.
    supportsAgentNativeSandbox: false },
  platforms: ['darwin', 'linux', 'win32'], browserReachable: false,
  prerequisites: [{ kind: 'managedDependency', id: DEPENDENCY_ID }], billing: BILLING, retention: RETENTION,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file', stream: 'stream' },
  reconciliation: { nativeOperationSchema: CoderOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'cleanup' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Coder Machines', description: MACHINE_PROVISIONER.description,
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: networkAccess, capability: 'network', reason: 'Manage workspaces on the selected Coder deployment.',
      scope: { targets: [{ kind: 'connectedAccountOrigin', service: ACCOUNT_SERVICE.localId }], methods: ['GET', 'POST'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Coder user token.',
      scope: { serviceRefs: [ACCOUNT_SERVICE.localId], operations: ['select', 'use'], materializationKinds: ['environment'] } },
    { id: processAccess, capability: 'process', reason: 'Use native Coder SSH for private guest enrollment IO.',
      scope: { executables: [{ kind: 'managedDependency', id: DEPENDENCY_ID }],
        envKeys: ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'CODER_URL', 'CODER_SESSION_TOKEN', 'CODER_SSH_ENV'] } },
  ], optional: [] },
  managedDependencies: { [DEPENDENCY_ID]: { id: DEPENDENCY_ID, title: 'Coder CLI', executable: 'coder',
    platforms: ['macos', 'linux', 'windows'], architectures: ['x64', 'arm64'],
    sources: [{ kind: 'system', executableNames: ['coder'], versionArguments: ['version'] }] } },
  connectedAccountDescriptors: { [ACCOUNT_SERVICE.localId]: {
    declaration: { title: 'Coder account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
      defaultModeId: 'token', modes: [{ id: 'token', title: 'User token', kind: 'manual', apiKey: true,
        outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        setup: { url: 'https://coder.com/docs/user-guides/workspace-access/cli', createKeyTitle: 'Read Coder CLI authentication instructions',
          checklist: ['Open your Coder deployment and create a token for the user who will own these workspaces.', 'Enter the deployment URL and paste the user token.'] },
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'endpoint', title: 'Coder deployment URL', semantic: 'connectedAccountBase', required: true, secret: false, schema: { type: 'string', minLength: 1 } },
        ] },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'User token', secret: true, schema: { type: 'string', minLength: 1 } }],
      }, {
        id: 'first-admin', title: 'Create the first administrator', kind: 'manual', browserReachability: 'unreachable',
        outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        setup: { url: 'https://coder.com/docs/install', checklist: ['Use this after installing Coder on your Machine. Happier creates the first administrator, signs in, and keeps only the returned session token in Connected services. Your password stays with Coder.'] },
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'endpoint', title: 'Coder deployment URL', semantic: 'connectedAccountBase', required: true, secret: false,
            schema: { type: 'string', minLength: 1 } },
        ] },
        fields: [
          { id: 'username', title: 'Administrator username', secret: false, schema: { type: 'string', minLength: 1 } },
          { id: 'email', title: 'Administrator email', secret: false, schema: { type: 'string', minLength: 1 } },
          { id: 'password', title: 'Administrator password', secret: true, schema: { type: 'string', minLength: 1 } },
        ],
      }],
    } }, runtime: CODER_CONNECTED_ACCOUNT_RUNTIME, accountRuntime: CODER_PORTABLE_ACCOUNT_RUNTIME,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    [CODER_CLI_INSTALL_ACTION]: { title: 'Install Coder CLI', surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], dangerLevel: 'safe',
      execution: { target: 'client', client: { artifactId: 'cli-install', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
      inputSchema: defineProtocolObject({}, { policy: 'closed' }),
      resultSchema: defineProtocolUnion([defineProtocolLiteral(null), defineProtocolObject({ url: defineProtocolString() }, { policy: 'closed' })]) },
    check: { ...defaults, title: 'Check Coder access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return await (await runtime(context)).check(); }
        catch (error) { return failure(error, { available: false, code: 'provider_unavailable' }); } } },
    options: { ...defaults, title: 'Coder workspace options', dangerLevel: 'safe', inputSchema: CoderOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'organizationId', title: 'Organization ID', widget: 'text', required: true },
        { path: 'templateId', title: 'Template ID', widget: 'text' },
        { path: 'templateVersionId', title: 'Template version ID', widget: 'text', description: 'Leave empty to use the template’s active version.' },
        { path: 'agentName', title: 'Agent name', widget: 'text', required: true, description: 'Select the exact Coder agent; an agent is never chosen automatically.' },
        { path: 'parameterValues', title: 'Rich parameter values', widget: 'json', description: 'An array of objects with name and value. Supply values required by your template.' },
        { path: 'presetId', title: 'Template version preset ID', widget: 'text', description: 'Select a preset configured with native prebuilds in Coder to use its pool. Coder builds a fresh workspace when no eligible prebuild is available. Only unsatisfied setup runs afterward; No Setup skips CLI installation.' },
        { path: 'workspaceHost', title: 'Where this template runs workspaces', widget: 'select',
          description: 'Choose This Machine only after confirming the selected template creates workspaces on this Machine. A local Coder server does not establish the workspace host. Remote templates run outside this Machine; add them as Machines instead.',
          options: [{ value: 'unknown', label: 'Not yet checked' }, { value: 'controller-local', label: 'This Machine' }, { value: 'remote', label: 'Another Machine or cloud' }] },
      ] },
      async run(input, context) { return (await import('./machine/options.js')).coderOptions(await runtime(context), input); } },
    acquire: { ...defaults, title: 'Create Coder workspace', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' }; return (await runtime(context)).acquire(input.launch, input.managedId); } },
    reconcile: { ...defaults, title: 'Recover Coder workspace', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { const client = await runtime(context); return client.recover('nativeOperation' in input ? input.nativeOperation : await client.operationFor(input.correlation.launch, input.correlation.managedId)); } },
    bootstrap: { ...defaults, title: 'Prepare Coder guest', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await runtime(context)).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Coder workspace', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { return await (await runtime(context)).inspect(input.resource); }
        catch (error) { return failure(error, { observedAt: context.invokedAtMs, availability: 'unavailable', power: 'unknown', reason: 'provider_unavailable' }); } } },
    power: { ...defaults, title: 'Start or stop Coder workspace', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await (await runtime(context)).power(input.resource, input.intent); } catch (error) { return failure(error, { kind: 'unknown', code: 'provider_unavailable' }); } } },
    destroy: { ...defaults, title: 'Delete Coder workspace', dangerLevel: 'destructive', confirmation, inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { try { return await (await runtime(context)).destroy(input); } catch (error) { return failure(error, { kind: 'unknown', code: 'provider_unavailable' }); } } },
    cleanup: { ...defaults, title: 'Observe Coder deletion', dangerLevel: 'safe', inputSchema: RECONCILIATION.cleanupInput, resultSchema: RECONCILIATION.cleanupResult,
      async run(input, context) { try { return await (await runtime(context)).cleanup(input.nativeOperation); } catch (error) { return failure(error, { kind: 'unknown', code: 'provider_unavailable' }); } } },
    exec: { ...defaults, title: 'Execute Coder guest command', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return (await runtime(context)).exec(input); } },
    stream: { ...defaults, title: 'Open a Coder guest channel', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.streamInput, resultSchema: MachineProvisionerNativeStreamResultV1Schema,
      async run(input, context) {
        const channel = await (await runtime(context)).stream(input);
        try { return { termination: await channel.waitForExit() }; } finally { await channel.dispose(); }
      } },
    'put-file': { ...defaults, title: 'Write Coder guest file', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return (await runtime(context)).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
