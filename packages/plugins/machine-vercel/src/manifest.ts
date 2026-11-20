import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  MachineProvisionerNativeCredentialApplyResultV1Schema,
  observeMachineProvisionerNativeRead, projectMachineProvisionerActionFailure, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { ACCOUNT_ID, connectedAccountPortableRuntime, connectedAccountRuntime } from './account.js';
import { VERCEL_IDENTITY_SCOPES } from './oauth.js';
import { ACCOUNT_PURPOSE, nativeFetch, PROJECT_REQUIRED, readAccountScope } from './machine/credentials.js';
import { createVercelNativeClient } from './machine/nativeClient.js';
import { createVercelPreparationClient, VERCEL_PREPARATION_HOME, VercelPreparationInputSchema, VercelPreparedArtifactSchema, VercelPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, CONTRIBUTION, reference, ROLE_SCHEMAS, RECONCILIATION, VercelLaunchSchema, VercelOptionsSchema, VercelOperationSchema, VercelResourceSchema, VERCEL_REGIONS, type VercelOperation } from './machine/schemas.js';
import { label } from './ui/translations.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const locales = ['en', 'de', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja'] as const;
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const nativeDefaults = { ...defaults, scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' } } as const;
const confirmation = { title: label('confirmTitle'), body: label('confirmBody') };
// A team contains its projects, so the team comes first.
const scopeFields = [
  { id: 'teamId', title: label('teamId'), description: label('teamIdDescription'), presentation: { placeholder: 'team_…', order: 1 },
    schema: { type: 'string', minLength: 1 }, required: false, secret: false },
  { id: 'projectId', title: label('projectId'), description: label('projectIdDescription'), presentation: { placeholder: 'prj_…', order: 2 },
    schema: { type: 'string', minLength: 1 }, required: false, secret: false },
] as const;
const runtime = async (context: PluginAccountActionContext | PluginInvocationContext) => createVercelNativeClient(
  await readAccountScope(context), nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = async (context: PluginAccountActionContext | PluginInvocationContext) => createVercelPreparationClient(
  await readAccountScope(context), nativeFetch(context), context.signal, context.invokedAtMs);
const errorCode = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'vercel_unavailable';

export const MACHINE_PROVISIONER = {
  title: 'Vercel', icon: 'cloud', resourceKind: 'vercel-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox',
  kindTitle: label('kind'), description: label('description'),
  launchSchema: VercelLaunchSchema.jsonSchema, resourceSchema: VercelResourceSchema.jsonSchema,
  resourceIdPath: 'name', platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  browserReachable: true,
  billing: BILLING, retention: { supportedIntents: ['start', 'stop', 'resume', 'delete'] },
  nativeDurationInput: { path: 'timeoutMs', unit: 'milliseconds' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  nativeCredentialDelivery: { apply: 'native-credential-apply', transports: ['https_headers'], preservesEndpoint: true, perBindingMatching: true },
  reconciliation: { nativeOperationSchema: VercelOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
  preparation: { inputSchema: VercelPreparationInputSchema.jsonSchema, artifactSchema: VercelPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: VercelPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Vercel Machines',
  description: label('description'),
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  // The provider's own mark beside its name in Machines: Vercel's mark from Simple Icons 13.21.0 (CC0-1.0), monochrome so the host draws it in ink.
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: { 'brand-icon': { kind: 'asset' as const, path: 'assets/brand.png', contentType: 'image/png' },
    ...Object.fromEntries(locales.map(locale => ['i18n-' + locale.toLowerCase(),
      { kind: 'asset' as const, path: 'assets/i18n/' + locale + '.json', contentType: 'application/json' }])) },
  ui: { translations: locales.map(locale => ({ locale, resourceId: 'i18n-' + locale.toLowerCase() })) },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: label('confirmBody'),
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.vercel.com' }], methods: ['GET', 'POST', 'DELETE', 'PATCH'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: label('account'),
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: label('account'), ui: { category: 'cloud-machines' }, capabilities: ['usage'], authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'oauth', modes: [{
      // No callbackUrl: the attempt uses the Home's Connected Account relay. The Home advertises the public client.
      id: 'oauth', kind: 'oauthAuthorizationCode', title: label('signIn'), scopes: [...VERCEL_IDENTITY_SCOPES], pkce: 'required',
      outcomeReconciliation: 'none', postAuthenticationFieldIds: ['teamId', 'projectId'],
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
        { ...scopeFields[0], description: label('signInTeamIdDescription') }, scopeFields[1],
      ] },
    }, {
      id: 'token', title: label('token'), kind: 'manual', outcomeReconciliation: 'none', credentialOrigin: 'authentication',
      setup: { url: 'https://vercel.com/account/tokens', createKeyTitle: 'Create a Vercel access token',
        checklist: ['Create an access token in [Vercel account settings] and give it a name.', 'Choose the team you will deploy to. Select All Projects to create projects, or select an existing project to limit the token to that project. Choose an expiration and create the token.', 'Copy the token and paste it here, then connect the account.'] },
      credentialFieldKeys: { token: 'token' },
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: label('token'), description: label('tokenDescription'), schema: { type: 'string', minLength: 1 }, secret: true }],
      // Left empty, the pasted token lists its teams to choose from.
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: scopeFields },
    }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: label('checkStatus'), dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput,
      resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { const result = await (await runtime(context)).check();
          return MachineProvisionerCheckResultV1Schema.parse({ ...result, status: label(result.available ? 'checkStatus' : 'checkUnavailable') }); }
        catch (error) {
          // A connection without a project is a typed setup finding, not a missing account.
          if (isPluginError(error) && error.code === PROJECT_REQUIRED) return MachineProvisionerCheckResultV1Schema.parse(error.details);
          return projectMachineProvisionerActionFailure(error, () => MachineProvisionerCheckResultV1Schema.parse({ available: false, code: errorCode(error), status: label('checkUnavailable') }));
        }
      } },
    options: { ...defaults, title: label('kind'), dangerLevel: 'safe', inputSchema: VercelOptionsSchema,
      resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'image', title: label('image'), widget: 'text', required: true, defaultValue: 'vercel/sandbox/universal:latest' },
        { path: 'region', title: label('region'), widget: 'select', required: true, defaultValue: 'iad1',
          options: VERCEL_REGIONS
            .map(value => ({ value, label: value })) },
        { path: 'vcpus', title: label('vcpus'), widget: 'integer', required: true },
        { path: 'timeoutMs', title: label('timeout'), widget: 'integer', description: label('timeoutDescription') },
        { path: 'snapshotExpirationMs', title: label('snapshotExpiration'), widget: 'integer', required: true, defaultValue: 0, description: label('retentionDescription') },
      ] },
      async run(input, context): Promise<MachineProvisionerOptionsResultV1> {
        const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
        try {
          const client = await runtime(context);
          const limits = await client.limits();
          context.signal.throwIfAborted();
          if (limits.kind !== 'available') return { dimensions, code: 'provider_unavailable',
            ...(limits.nativeCause ? { nativeCause: limits.nativeCause } : {}) };
          const parsed = VercelLaunchSchema.safeParse({ ...input, timeoutMs: input.timeoutMs ?? limits.timeoutMs });
          if (!parsed.success) return { dimensions };
          const launch = parsed.data;
          const image = { id: launch.image, title: launch.image };
          const size = { id: String(launch.vcpus), title: label('customSize'), cpuCores: launch.vcpus, memoryBytes: launch.vcpus * 2048 * 1024 * 1024 };
          const location = { id: launch.region, title: launch.region };
          const duration = { id: String(launch.timeoutMs), title: String(launch.timeoutMs / 1000) + ' s', afterMs: launch.timeoutMs };
          // This is the reviewed native form draft, not a Cartesian catalog. The
          // public selection projector owns selection completeness and launch.
          return { base: { launch, guestPlatform: 'linux', available: launch.vcpus <= limits.vcpus && launch.timeoutMs <= limits.timeoutMs },
            dimensions: { ...dimensions,
              image: [{ id: image.id, title: image.title, guestPlatform: 'linux', assignments: [], nativeFacts: { image,
                preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: VERCEL_PREPARATION_HOME },
              } }],
              size: [{ id: size.id, title: size.title, assignments: [], nativeFacts: { size } }],
              location: [{ id: location.id, title: location.title, assignments: [], nativeFacts: { location } }],
              duration: [{ id: duration.id, title: duration.title, assignments: [], nativeFacts: { duration } }],
            } };
        } catch (error) {
          context.signal.throwIfAborted();
          return projectMachineProvisionerActionFailure(error, () => ({ dimensions, code: 'provider_unavailable' as const }));
        }
      } },
    acquire: { ...defaults, title: label('confirmTitle'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) {
        if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' };
        let scope;
        try { scope = await readAccountScope(context); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => RECONCILIATION.result.parse({ kind: 'rejected', code: 'credential_unavailable' })); }
        try {
          return await createVercelNativeClient(scope, nativeFetch(context), context.signal, context.invokedAtMs).acquire(input.launch, input.managedId);
        } catch (error) {
          return projectMachineProvisionerActionFailure(error, () => RECONCILIATION.result.parse({ kind: 'pending', nativeOperationRef: reference({
            kind: 'acquire', name: 'happier-' + input.managedId, managedId: input.managedId, ...scope,
          }) }));
        }
      } },
    'prepare-build': { ...defaults, title: 'Build Vercel prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Vercel snapshot?', body: 'Provider charges apply for runtime and snapshot storage. See https://vercel.com/docs/sandbox/pricing for current pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return (await preparationRuntime(context)).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Vercel prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return (await preparationRuntime(context)).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Vercel prepared snapshot', dangerLevel: 'destructive',
      confirmation: { title: label('deleteTitle'), body: label('deleteBody') },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return (await preparationRuntime(context)).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    reconcile: { ...defaults, title: label('kind'), dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) {
        let operation: VercelOperation | undefined = 'nativeOperation' in input ? input.nativeOperation : undefined;
        try {
          const scope = await readAccountScope(context);
          operation = 'nativeOperation' in input ? input.nativeOperation : { kind: 'acquire' as const,
            name: 'happier-' + input.correlation.managedId, managedId: input.correlation.managedId, ...scope };
          return await createVercelNativeClient(scope, nativeFetch(context), context.signal, context.invokedAtMs).recover(operation);
        } catch (error) {
          return projectMachineProvisionerActionFailure(error, () => RECONCILIATION.result.parse(operation ? { kind: 'pending', nativeOperationRef: reference(operation) }
            : { kind: 'unknown', recovery: { reference: 'retained-vercel-acquisition', reason: 'credential_unavailable' } }));
        }
      } },
    bootstrap: { ...defaults, title: label('kind'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return await (await runtime(context)).bootstrap(input.resource); } },
    inspect: { ...defaults, title: label('kind'), dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput,
      resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).inspect(input.resource); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) })); }
      } },
    'native-credential-apply': { ...nativeDefaults, title: label('kind'),
      confirmation: { title: label('nativeCredentialConfirmTitle'), body: label('nativeCredentialConfirmBody') }, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.nativeCredentialApplyInput,
      resultSchema: MachineProvisionerNativeCredentialApplyResultV1Schema,
      async run(input, context) {
        try {
          return await (await runtime(context)).applyNativeCredentials(input,
            request => context.services.machineProvisioners.materializeNativeCredentialHeaders(request));
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: 'vercel_policy_unconfirmed' })); }
      } },
    power: { ...defaults, title: label('confirmTitle'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await (await runtime(context)).power(input.resource, input.intent); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: errorCode(error) })); } } },
    destroy: { ...defaults, title: label('deleteTitle'), confirmation: { title: label('deleteTitle'), body: label('deleteBody') },
      dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) {
        try { return await (await runtime(context)).destroy(input); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: errorCode(error) })); }
      } },
    'observe-cleanup': { ...defaults, title: label('kind'), dangerLevel: 'safe',
      inputSchema: RECONCILIATION.cleanupInput, resultSchema: RECONCILIATION.cleanupResult,
      async run(input, context) { try { return await (await runtime(context)).cleanup(input.nativeOperation); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: errorCode(error) })); } } },
    exec: { ...defaults, title: label('kind'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return await (await runtime(context)).exec(input); } },
    'put-file': { ...defaults, title: label('kind'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return await (await runtime(context)).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
