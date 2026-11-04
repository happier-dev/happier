import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  observeMachineProvisionerNativeRead, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch, readAccountScope } from './account.js';
import { createVercelNativeClient } from './machine/nativeClient.js';
import { BILLING, CONTRIBUTION, reference, ROLE_SCHEMAS, RECONCILIATION, VercelLaunchSchema, VercelOptionsSchema, VercelOperationSchema, VercelResourceSchema, VERCEL_REGIONS, type VercelOperation } from './machine/schemas.js';
import { label } from './ui/translations.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const locales = ['en', 'de', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja'] as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE] } as const;
const confirmation = { title: label('confirmTitle'), body: label('confirmBody') };
const runtime = async (context: PluginInvocationContext) => createVercelNativeClient(
  await readAccountScope(context), nativeFetch(context), context.signal, context.invokedAtMs);
const errorCode = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'vercel_unavailable';

export const MACHINE_PROVISIONER = {
  title: 'Vercel', icon: 'cloud', resourceKind: 'vercel-sandbox', schemaVersion: 1,
  kindTitle: label('kind'), description: label('description'),
  launchSchema: VercelLaunchSchema.jsonSchema, resourceSchema: VercelResourceSchema.jsonSchema,
  resourceIdPath: 'name', platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  billing: BILLING, retention: { supportedIntents: ['start', 'stop', 'resume', 'delete'] },
  nativeDurationInput: { path: 'timeoutMs', unit: 'milliseconds' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: VercelOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Vercel Machines',
  description: label('description'), engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  resources: Object.fromEntries(locales.map(locale => ['i18n-' + locale.toLowerCase(),
    { kind: 'asset' as const, path: 'assets/i18n/' + locale + '.json', contentType: 'application/json' }])),
  ui: { translations: locales.map(locale => ({ locale, resourceId: 'i18n-' + locale.toLowerCase() })) },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: label('confirmBody'),
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.vercel.com' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: label('account'),
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: label('account'), ui: { category: 'cloud-machines' }, authentication: { defaultModeId: 'token', modes: [{
      id: 'token', title: label('token'), kind: 'manual', outcomeReconciliation: 'none', credentialOrigin: 'authentication',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: label('token'), description: label('tokenDescription'), schema: { type: 'string', minLength: 1 }, secret: true }],
      // A team contains its projects, so the team comes first.
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
        { id: 'teamId', title: label('teamId'), description: label('teamIdDescription'), presentation: { placeholder: 'team_…', order: 1 },
          schema: { type: 'string', minLength: 1 }, required: true, secret: false },
        { id: 'projectId', title: label('projectId'), description: label('projectIdDescription'), presentation: { placeholder: 'prj_…', order: 2 },
          schema: { type: 'string', minLength: 1 }, required: true, secret: false },
      ] },
      setup: { url: 'https://vercel.com/account/tokens', createKeyTitle: 'Open Vercel access tokens',
        checklist: ['Open Tokens in your Vercel account settings and enter a name for the token.', 'Choose a scope with access to the team and projects where you will create sandboxes, then choose an expiration and create the token.', 'Copy the token and paste it here; enter the matching Team ID below.'] },
    }] } }, runtime: connectedAccountRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: label('checkStatus'), dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput,
      resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { const result = await (await runtime(context)).check();
          return MachineProvisionerCheckResultV1Schema.parse({ ...result, status: label(result.available ? 'checkStatus' : 'checkUnavailable') }); }
        catch (error) { return MachineProvisionerCheckResultV1Schema.parse({ available: false, code: errorCode(error), status: label('checkUnavailable') }); }
      } },
    options: { ...defaults, title: label('kind'), dangerLevel: 'safe', inputSchema: VercelOptionsSchema,
      resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'image', title: label('image'), widget: 'text', required: true, defaultValue: 'vercel/sandbox/universal:latest' },
        { path: 'region', title: label('region'), widget: 'select', required: true, defaultValue: 'iad1',
          options: VERCEL_REGIONS
            .map(value => ({ value, label: value })) },
        { path: 'vcpus', title: label('vcpus'), widget: 'integer', required: true, defaultValue: 2 },
        { path: 'timeoutMs', title: label('timeout'), widget: 'integer', required: true, defaultValue: 300000, description: label('timeoutDescription') },
        { path: 'snapshotExpirationMs', title: label('snapshotExpiration'), widget: 'integer', required: true, defaultValue: 0, description: label('retentionDescription') },
      ] },
      async run(input, context): Promise<MachineProvisionerOptionsResultV1> {
        const client = await runtime(context);
        const [check, limits] = await Promise.all([client.check(), client.limits()]);
        context.signal.throwIfAborted();
        const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
        if (!check.available) return { dimensions, code: 'provider_unavailable',
          ...(check.nativeCause ? { nativeCause: check.nativeCause } : {}) };
        if (limits.kind !== 'available') return { dimensions, code: 'provider_unavailable',
          ...(limits.nativeCause ? { nativeCause: limits.nativeCause } : {}) };
        const parsed = VercelLaunchSchema.safeParse(input);
        if (!parsed.success) return { dimensions };
        const launch = parsed.data;
        const image = { id: launch.image, title: launch.image };
        const size = { id: String(launch.vcpus), title: String(launch.vcpus) + ' vCPU', cpuCores: launch.vcpus, memoryBytes: launch.vcpus * 2048 * 1024 * 1024 };
        const location = { id: launch.region, title: launch.region };
        const duration = { id: String(launch.timeoutMs), title: String(launch.timeoutMs / 1000) + ' s', afterMs: launch.timeoutMs };
        // This is the reviewed native form draft, not a Cartesian catalog. The
        // public selection projector owns selection completeness and launch.
        return { base: { launch, available: launch.vcpus <= limits.vcpus && launch.timeoutMs <= limits.timeoutMs },
          dimensions: { ...dimensions,
            image: [{ id: image.id, title: image.title, assignments: [], nativeFacts: { image } }],
            size: [{ id: size.id, title: size.title, assignments: [], nativeFacts: { size } }],
            location: [{ id: location.id, title: location.title, assignments: [], nativeFacts: { location } }],
            duration: [{ id: duration.id, title: duration.title, assignments: [], nativeFacts: { duration } }],
          } };
      } },
    acquire: { ...defaults, title: label('confirmTitle'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) {
        if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' };
        let scope;
        try { scope = await readAccountScope(context); }
        catch { return RECONCILIATION.result.parse({ kind: 'rejected', code: 'credential_unavailable' }); }
        try {
          return await createVercelNativeClient(scope, nativeFetch(context), context.signal, context.invokedAtMs).acquire(input.launch, input.managedId);
        } catch {
          // Once the native handler was entered an exception cannot establish
          // absence. Retain the exact naming/correlation facts for recovery.
          return RECONCILIATION.result.parse({ kind: 'pending', nativeOperationRef: reference({
            kind: 'acquire', name: 'happier-' + input.managedId, managedId: input.managedId, ...scope,
          }) });
        }
      } },
    reconcile: { ...defaults, title: label('kind'), dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) {
        let operation: VercelOperation | undefined = 'nativeOperation' in input ? input.nativeOperation : undefined;
        try {
          const scope = await readAccountScope(context);
          operation = 'nativeOperation' in input ? input.nativeOperation : { kind: 'acquire' as const,
            name: 'happier-' + input.correlation.managedId, managedId: input.correlation.managedId, ...scope };
          return await createVercelNativeClient(scope, nativeFetch(context), context.signal, context.invokedAtMs).recover(operation);
        } catch {
          return RECONCILIATION.result.parse(operation ? { kind: 'pending', nativeOperationRef: reference(operation) }
            : { kind: 'unknown', recovery: { reference: 'retained-vercel-acquisition', reason: 'credential_unavailable' } });
        }
      } },
    bootstrap: { ...defaults, title: label('kind'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return await (await runtime(context)).bootstrap(input.resource); } },
    inspect: { ...defaults, title: label('kind'), dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput,
      resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).inspect(input.resource); }
        catch (error) { return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) }); }
      } },
    power: { ...defaults, title: label('confirmTitle'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await (await runtime(context)).power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown', code: errorCode(error) }; } } },
    destroy: { ...defaults, title: label('deleteTitle'), confirmation: { title: label('deleteTitle'), body: label('deleteBody') },
      dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) {
        try { return await (await runtime(context)).destroy(input); }
        catch (error) { return { kind: 'unknown', code: errorCode(error) }; }
      } },
    'observe-cleanup': { ...defaults, title: label('kind'), dangerLevel: 'safe',
      inputSchema: RECONCILIATION.cleanupInput, resultSchema: RECONCILIATION.cleanupResult,
      async run(input, context) { try { return await (await runtime(context)).cleanup(input.nativeOperation); }
        catch (error) { return { kind: 'unknown', code: errorCode(error) }; } } },
    exec: { ...defaults, title: label('kind'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return await (await runtime(context)).exec(input); } },
    'put-file': { ...defaults, title: label('kind'), confirmation, dangerLevel: 'writesRemote',
      inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return await (await runtime(context)).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
