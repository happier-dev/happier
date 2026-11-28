import type { DefinedPlugin, DefinedPluginActionContracts } from '@happier-dev/plugin-sdk';
import type { DefinedContributionPointProtocolMap } from '@happier-dev/plugin-sdk/contributions';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { projectMachineProvisionerActionFailure,
  defineMachineProvisionerReconciliationSchemas,
  defineMachineProvisionerSchemas,
  computeSshHostKeyFingerprint,
  MachineProvisionerBootstrapCarrierV1Schema,
  MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema,
  MachineProvisionerRenewResultV1Schema,
  prepareMachineProvisionerStoredSchemas,
  observeMachineProvisionerNativeRead,
  type MachineProvisionerAuthorDefinitionV1,
  type MachineProvisionerOptionsResultV1,
  type MachineProvisionerNativeCauseV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, BOAT_NATIVE_HTTP_METHODS, connectedAccountRuntime, connectedAccountPortableRuntime, nativeFetch } from './account.js';
import { boatOAuthScopes } from './oauth.js';
import { BOAT_STOPPED_STORAGE_NOTICE, createBoatNativeClient, type BoatSize } from './machine/nativeClient.js';
import {
  BoatLaunchV1Schema,
  BoatNativeOperationV1Schema,
  BoatResourceV1Schema,
  BoatNativeError,
  boatSetupMessage,
  isBoatAdmissionRefusalCode,
  projectBoatMachineRefusalCode,
  type BoatAcquireOperationV1,
  type BoatLaunchV1,
} from './machine/schemas.js';
import { BOAT_PREPARATION_HOME, BoatPreparationInputSchema, BoatPreparedArtifactSchema, BoatPreparationOperationSchema, PREPARATION_SCHEMAS, createBoatPreparationClient, supportsBoatPreparationSource } from './machine/preparation.js';
import { boatCheckPresentation, boatPresentationLabel } from './ui/translations.js';

export const PLUGIN_ID = 'happier.machine.boat';
export const PROVISIONER_ID = 'boat';
const nativeSchemas = { launch: BoatLaunchV1Schema, resource: BoatResourceV1Schema, nativeOperation: BoatNativeOperationV1Schema };
const reconciliation = defineMachineProvisionerReconciliationSchemas(nativeSchemas);
export const ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas(nativeSchemas), acquireResult: reconciliation.result };
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(nativeSchemas);
const contributionRef = { pluginId: PLUGIN_ID, localId: PROVISIONER_ID } as const;
const resourceRef = <T>(value: T) => ({ contributionRef, schemaVersion: 1, value });
const pending = (value: BoatAcquireOperationV1, nativeCause?: MachineProvisionerNativeCauseV1) => ({ kind: 'pending' as const,
  nativeOperationRef: resourceRef(value), ...(nativeCause ? { nativeCause } : {}) });
const failureCause = (error: unknown) => error instanceof BoatNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {};
function rethrowNativeFailure(error: unknown): never {
  if (error instanceof BoatNativeError) throw new PluginError({ code: error.code, message: error.message,
    ...(error.nativeCause ? { details: { nativeCause: error.nativeCause } } : {}) });
  throw error;
}
const billing = { location: 'cloud', stoppedBilling: 'not-billed' } as const;
const retention = { supportedIntents: ['stop', 'resume', 'delete'], deletionNotices: [BOAT_STOPPED_STORAGE_NOTICE] } as const;
const defaults = { placementBindings: [], surfaces: ['ui', 'cli', 'plugin', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const runtime = (context: Parameters<typeof nativeFetch>[0]) => createBoatNativeClient({ fetch: nativeFetch(context), signal: context.signal });
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createBoatPreparationClient(nativeFetch(context), context.signal,
  () => context.services.machineProvisioners.waitForNativeObservation());
const PRICE_SOURCE = 'https://docs.boat.dev/pricing';
// Static rates verified against https://docs.boat.dev/pricing.md on 2026-10-30.
// /limits supplies current entitlement, not a fresh observation of these rates.
const PRICE_OBSERVED_AT = Date.parse('2026-10-30T00:00:00Z');

function sizeTitle(size: BoatSize): string {
  return `${size.id} · ${size.multiplier}x · ${size.cpuCores} vCPU · ${size.memoryGb} GB RAM · ${size.diskGb} GB · $${size.hourlyUsd}/hour`;
}

function sizeOption(size: BoatSize) {
  return {
    id: size.id, title: sizeTitle(size), assignments: [{ path: 'size', value: size.id }],
    prices: [{ label: boatPresentationLabel('compute'), amount: size.hourlyUsd, currency: 'USD', unit: 'hour', source: PRICE_SOURCE, observedAt: PRICE_OBSERVED_AT }],
    nativeFacts: {
      size: { id: size.id, title: `${size.id} (${size.multiplier}x)`, cpuCores: size.cpuCores,
        memoryBytes: size.memoryGb * 1024 ** 3, diskBytes: size.diskGb * 1000 ** 3 },
    },
  };
}

function sourceOption(source: BoatLaunchV1['source'], title: string) {
  const id = source.kind === 'blank' ? 'blank' : source.kind === 'named-snapshot' ? `snapshot/${source.name}` : `fork/${source.sandboxId}`;
  // These are filesystem starting sources; the existing image/source control
  // carries their exact native selector, including a fork's source sandbox id.
  // Boat's Linux sandbox contract also covers saved disks and forks: https://docs.boat.dev/concepts.
  return { id, title, guestPlatform: 'linux' as const, assignments: [{ path: 'source', value: source }], nativeFacts: { image: { id, title },
    ...(supportsBoatPreparationSource(source) ? { preparationGuest: { target: { os: 'linux' as const, arch: 'x64' as const }, remoteHomeDir: BOAT_PREPARATION_HOME } } : {}) } };
}

export const MACHINE_PROVISIONER = {
  title: 'Boat', icon: 'cloud', resourceKind: 'boat-sandbox', schemaVersion: 1,
  browserReachable: false,
  enrollmentRole: 'server',
  kindTitle: boatPresentationLabel('kind'), description: boatPresentationLabel('description'),
  launchSchema: BoatLaunchV1Schema.jsonSchema, resourceSchema: BoatResourceV1Schema.jsonSchema, resourceIdPath: 'sandboxId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'systemTool', id: 'ssh-keyscan' }],
  billing, retention, bootstrapCredential: { kind: 'ssh' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', renew: 'renew' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: BoatNativeOperationV1Schema.jsonSchema },
  preparation: { inputSchema: BoatPreparationInputSchema.jsonSchema, artifactSchema: BoatPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: BoatPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

/** Named schema references retain exact Action payloads in portable declarations. */
type BoatActionSchemas = {
  readonly 'prepare-build': readonly [typeof PREPARATION_SCHEMAS.buildInput, typeof PREPARATION_SCHEMAS.buildResult];
  readonly 'prepare-inspect': readonly [typeof PREPARATION_SCHEMAS.inspectInput, typeof PREPARATION_SCHEMAS.inspectResult];
  readonly 'prepare-destroy': readonly [typeof PREPARATION_SCHEMAS.destroyInput, typeof PREPARATION_SCHEMAS.destroyResult];
  readonly reconcile: readonly [typeof reconciliation.input, typeof reconciliation.result];
  readonly check: readonly [typeof ROLE_SCHEMAS.checkInput, typeof MachineProvisionerCheckResultV1Schema];
  readonly options: readonly [typeof ROLE_SCHEMAS.checkInput, typeof MachineProvisionerOptionsResultV1Schema];
  readonly acquire: readonly [typeof ROLE_SCHEMAS.acquireInput, typeof ROLE_SCHEMAS.acquireResult];
  readonly bootstrap: readonly [typeof ROLE_SCHEMAS.bootstrapInput, typeof MachineProvisionerBootstrapCarrierV1Schema];
  readonly inspect: readonly [typeof ROLE_SCHEMAS.resourceInput, typeof MachineProvisionerObservationV1Schema];
  readonly renew: readonly [typeof ROLE_SCHEMAS.renewInput, typeof MachineProvisionerRenewResultV1Schema];
  readonly power: readonly [typeof ROLE_SCHEMAS.powerInput, typeof MachineProvisionerPowerResultV1Schema];
  readonly destroy: readonly [typeof reconciliation.destroyInput, typeof reconciliation.destroyResult];
};

type BoatActionDeclarations = {
  readonly [TLocalId in keyof BoatActionSchemas]: {
    readonly title: string;
    readonly inputSchema: BoatActionSchemas[TLocalId][0];
    readonly resultSchema: BoatActionSchemas[TLocalId][1];
  };
};

type BoatPlugin = DefinedPlugin<
  typeof PLUGIN_ID,
  DefinedPluginActionContracts<typeof PLUGIN_ID, BoatActionDeclarations>,
  DefinedContributionPointProtocolMap<Readonly<Record<string, never>>>
>;

export function createBoatPlugin(resolveSshBootstrap?: typeof resolveMachineProvisionerSshBootstrap): BoatPlugin {
  const plugin = definePlugin({
  id: PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Boat Machines',
  description: 'Create and manage Boat sandboxes as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate the exact reviewed Boat sandbox.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://boat.dev' }], methods: BOAT_NATIVE_HTTP_METHODS } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured Boat account.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
    { id: 'ssh-evidence', capability: 'process', reason: 'Observe and verify the managed sandbox host key.',
      scope: { executables: [{ kind: 'systemTool', id: 'ssh-keyscan' }] } },
  ], optional: [] },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Boat account', ui: { category: 'cloud-machines' }, authentication: {
      account: defaults.execution.account, defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API key', apiKey: true, outcomeReconciliation: 'none',
      setup: { url: 'https://boat.dev/dashboard', createKeyTitle: 'Open Boat dashboard',
        // https://docs.boat.dev/api-keys/scopes does not enumerate ci's
        // account.read membership; old ci keys do not acquire newer permissions.
        checklist: ['Select the account or organization that should own the sandboxes in the [Boat dashboard].',
          'Create an API key with sandbox.create, sandbox.read, sandbox.update, sandbox.stop, sandbox.resume, sandbox.fork, sandbox.delete (or sandbox.delete-own for sandboxes created by this key), ssh, exec, file.write, snapshot.read, snapshot.write, and account.read.',
          'Ensure the key can access the selected source sandboxes and snapshots. Older ci keys may lack resume or ssh; verify account.read explicitly. Copy and paste the key here.'],
        shapeHint: 'New Boat API keys start with boat_. Existing box_ keys are also supported.' },
      credentialFieldKeys: { token: 'token' },
      credentialOrigin: 'authentication',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API key', schema: { type: 'string', minLength: 1 }, secret: true }],
    }, {
      id: 'oauth', kind: 'oauthAuthorizationCode', title: 'Sign in with Boat', pkce: 'required',
      outcomeReconciliation: 'none', credentialKind: 'oauth', scopes: [...boatOAuthScopes],
    }] } },
    runtime: connectedAccountRuntime,
    accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  actions: {
    'prepare-build': { ...defaults, title: 'Build Boat prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Boat snapshot?', body: 'Boat charges for the build guest and retained snapshot. See https://docs.boat.dev/pricing for current pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Boat prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Boat prepared snapshot', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Boat snapshot?', body: 'Deleting the snapshot permanently removes the prepared image and its temporary build guest.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    reconcile: { ...defaults, title: 'Recover exact Boat sandbox', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        const operation = 'correlation' in input
          ? { kind: 'acquire' as const, idempotencyKey: input.correlation.managedId } : input.nativeOperation;
        if (operation.kind === 'delete') {
          return { kind: 'unknown' as const, recovery: { reference: operation.operationId, reason: 'native_destroy_custody_requires_shared_owner' } };
        }
        try {
          const result = await runtime(context).reconcileAcquire(operation);
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: { ...resourceRef(result.resource), origin: 'created' as const } };
          if (result.kind === 'pending') return pending(result.operation, result.nativeCause);
          const cause = result.nativeCause ? { nativeCause: result.nativeCause } : {};
          if (result.kind === 'unknown') return { kind: 'unknown' as const, recovery: { reference: operation.idempotencyKey, reason: result.code }, ...cause };
          return { kind: 'rejected' as const, code: result.code === 'native_idempotency_mismatch' ? 'request_conflict' as const : 'provider_unavailable' as const, ...cause };
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
          if (error instanceof BoatNativeError && boatSetupMessage(error.code)) return { kind: 'unknown' as const,
            recovery: { reference: operation.idempotencyKey, reason: error.code }, ...failureCause(error) };
          return pending(operation, failureCause(error).nativeCause);
        }); }
      },
    },
    check: { ...defaults, title: 'Check Boat API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { return boatCheckPresentation(await runtime(context).check()); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => {
          const nativeCode = error instanceof BoatNativeError ? error.code : 'provider_unavailable';
          const code = error instanceof BoatNativeError ? projectBoatMachineRefusalCode(error) : nativeCode;
          const message = boatSetupMessage(nativeCode);
          return { ...boatCheckPresentation({ available: false, code,
            ...(message ? { status: { key: `machineBoat.errors.${nativeCode}`, fallback: message } } : {}) }), ...failureCause(error) };
        }); }
      },
    },
    options: { ...defaults, title: 'Discover Boat sandbox options', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context): Promise<MachineProvisionerOptionsResultV1> {
        const facts = await runtime(context).options().catch(rethrowNativeFailure);
        return { base: { launch: {}, guestPlatform: 'linux', retention, nativeFacts: { monthlyCapStatus: 'none' },
        }, dimensions: {
          size: facts.sizes.map(sizeOption),
          image: [sourceOption({ kind: 'blank' }, 'Blank sandbox'),
            ...facts.snapshots.map(snapshot => sourceOption({ kind: 'named-snapshot', name: snapshot.name }, `Snapshot ${snapshot.name}`)),
            ...facts.sandboxes.map(sandbox => sourceOption({ kind: 'fork', sandboxId: sandbox.id }, `Fork ${sandbox.name ?? sandbox.id} (${sandbox.id})`))],
          location: [{ id: 'eu', title: 'EU only', assignments: [], nativeFacts: { location: { id: 'eu', title: 'EU only' } } }],
          network: [], duration: [],
        } };
      },
    },
    acquire: { ...defaults, title: 'Create Boat sandbox', dangerLevel: 'destructive',
      confirmation: { title: 'Create this Boat sandbox?', body: 'Boat bills running time per second. Stopping pauses compute billing; plans start at $20/month with the same amount of included usage.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        if (!input.managedId) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        try {
          const result = await runtime(context).acquire({ launch: input.launch, idempotencyKey: input.managedId });
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: { ...resourceRef(result.resource), origin: 'created' as const } };
          if (result.kind === 'pending') return pending(result.operation, result.nativeCause);
          const cause = result.nativeCause ? { nativeCause: result.nativeCause } : {};
          if (result.kind === 'unknown') return { kind: 'unknown' as const, recovery: { reference: input.managedId, reason: result.code }, ...cause };
          return { kind: 'rejected' as const, code: result.code, ...cause };
        } catch (error) {
          // Submitted effects settle inside the native client; escaped native failures precede allocation.
          if (error instanceof BoatNativeError) return { kind: 'rejected' as const,
            code: projectBoatMachineRefusalCode(error), ...failureCause(error) };
          return { kind: 'unknown' as const, recovery: { reference: input.managedId, reason: 'provider_unavailable' }, ...failureCause(error) };
        }
      },
    },
    bootstrap: { ...defaults, title: 'Prepare Boat sandbox for Happier', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Boat sandbox for Happier?', body: 'Happier will configure SSH, verify the host key, and install the ordinary daemon service.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context: PluginAccountActionContext | PluginInvocationContext) {
        if (!input.bootstrapPublicKey) throw new Error('credential_unavailable');
        const connection = await runtime(context).bootstrap(input.resource, input.bootstrapPublicKey).catch(rethrowNativeFailure);
        const expected = connection.hostKey.trim().split(/\s+/u).slice(0, 2).join(' ');
        if (!resolveSshBootstrap || !('exec' in context.services)) {
          if (!input.credentialRef) throw new PluginError({ code: 'credential_unavailable' });
          const key = expected.split(' ')[1];
          if (!key) throw new PluginError({ code: 'native_ssh_evidence_invalid' });
          const host = connection.port === 22 ? connection.address : `[${connection.address}]:${connection.port}`;
          // Vendor evidence is TOFU input, never an app-generated trusted pin.
          return { kind: 'ssh' as const, address: connection.address, user: connection.username, port: connection.port,
            credentialRef: input.credentialRef,
            hostKeyEvidence: { hostKey: `${host} ${expected}`, fingerprint: computeSshHostKeyFingerprint(key) } };
        }
        const carrier = await resolveSshBootstrap({ exec: context.services.exec, signal: context.signal,
          connection: { address: connection.address, user: connection.username, port: connection.port }, credentialRef: input.credentialRef });
        if (carrier.kind !== 'ssh') throw new Error('native_ssh_host_key_mismatch');
        const observed = carrier.hostKeyEvidence.hostKey.trim().split(/\s+/u).slice(-2).join(' ');
        if (expected !== observed) throw new Error('native_ssh_host_key_mismatch');
        return carrier;
      },
    },
    inspect: { ...defaults, title: 'Inspect Boat sandbox', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try {
          const result = await runtime(context).inspect(input.resource);
          if (result.kind === 'absent') return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'absent', power: 'unknown', deletionNotices: [] });
          if (result.kind === 'failed') return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: 'native_resource_failed' });
          if (result.kind === 'unknown') return observeMachineProvisionerNativeRead(context.invokedAtMs, { ...result,
            reason: 'reason' in result ? result.reason : 'native_resource_unavailable' });
          return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'present', power: result.power,
            ...('reason' in result ? { reason: result.reason } : {}),
            storage: result.storage, ...(result.nativeExpiry === undefined ? {} : { nativeExpiry: result.nativeExpiry }),
            deletionNotices: result.deletionNotices, billing });
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown',
          reason: error instanceof BoatNativeError && boatSetupMessage(error.code) ? error.code : 'provider_unavailable', ...failureCause(error) })); }
      },
    },
    renew: { ...defaults, title: 'Renew Boat sandbox lifetime', dangerLevel: 'destructive',
      confirmation: { title: 'Update this Boat sandbox’s lifetime?', body: 'Happier will align its native auto-stop timer with the selected retention policy.' },
      inputSchema: ROLE_SCHEMAS.renewInput, resultSchema: MachineProvisionerRenewResultV1Schema,
      async run(input, context) {
        return await runtime(context).renew(input.resource, input.deadlineAt).catch(rethrowNativeFailure);
      },
    },
    power: { ...defaults, title: 'Change Boat sandbox power', dangerLevel: 'destructive',
      confirmation: { title: 'Change this Boat sandbox’s power?', body: 'Stop snapshots first and pauses compute billing after archival. Resume wakes the same sandbox and its enabled Happier service.' },
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (!['start', 'resume', 'stop'].includes(input.intent)) return { kind: 'refused' as const, code: 'native_unsupported_intent' };
        try {
          const result = await runtime(context).power(input.resource, input.intent as 'start' | 'resume' | 'stop');
          return result.kind === 'confirmed' ? result : { kind: 'unknown' as const, code: 'native_power_pending' };
        } catch (error) {
          if (error instanceof BoatNativeError && isBoatAdmissionRefusalCode(error.code)) {
            return { kind: 'refused' as const, code: error.code, ...failureCause(error) };
          }
          const code = error instanceof Error && error.message.startsWith('native_') ? error.message : 'provider_unavailable';
          return { kind: 'unknown' as const, code, ...failureCause(error) };
        }
      },
    },
    destroy: { ...defaults, title: 'Delete Boat sandbox', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Boat sandbox?', body: 'This permanently deletes the sandbox. Named snapshots remain independent.' },
      inputSchema: reconciliation.destroyInput, resultSchema: reconciliation.destroyResult,
      async run(input, context) {
        try {
          const native = runtime(context);
          if ('nativeOperation' in input) {
            if (input.nativeOperation.kind !== 'delete') return { kind: 'refused' as const, code: 'invalid_request' };
            const result = await native.reconcileDestroy(input.nativeOperation);
            if (result.kind === 'confirmed') return result;
            if (result.kind === 'failed') return { kind: 'refused' as const, code: result.code };
            return { kind: 'pending' as const };
          }
          const result = await native.destroy({ resource: input.resource });
          return { kind: 'accepted' as const, nativeOperationRef: resourceRef(result.operation) };
        } catch (error) {
          if (error instanceof BoatNativeError && boatSetupMessage(error.code)) {
            return { kind: 'refused' as const, code: error.code, ...failureCause(error) };
          }
          const code = error instanceof Error && error.message.startsWith('native_') ? error.message : 'provider_unavailable';
          return { kind: 'unknown' as const, code, ...failureCause(error) };
        }
      },
    },
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
  resources: {
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
});
  const declaredPlugin: BoatPlugin = plugin;
  return declaredPlugin satisfies typeof plugin;
}

export const PLUGIN: ReturnType<typeof createBoatPlugin> = createBoatPlugin();
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = PLUGIN.activateAccount;
