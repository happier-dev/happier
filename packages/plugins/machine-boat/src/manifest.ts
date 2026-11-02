import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  defineMachineProvisionerReconciliationSchemas,
  defineMachineProvisionerSchemas,
  MachineProvisionerBootstrapCarrierV1Schema,
  MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema,
  prepareMachineProvisionerStoredSchemas,
  type MachineProvisionerAuthorDefinitionV1,
  type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch } from './account.js';
import { createBoatNativeClient, type BoatSize } from './machine/nativeClient.js';
import {
  BoatLaunchV1Schema,
  BoatNativeOperationV1Schema,
  BoatResourceV1Schema,
  type BoatAcquireOperationV1,
} from './machine/schemas.js';
import { boatCheckPresentation, boatPresentationLabel, BOAT_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export const PLUGIN_ID = 'happier.machine.boat';
export const PROVISIONER_ID = 'boat';
const nativeSchemas = { launch: BoatLaunchV1Schema, resource: BoatResourceV1Schema, nativeOperation: BoatNativeOperationV1Schema };
const reconciliation = defineMachineProvisionerReconciliationSchemas(nativeSchemas);
export const ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas(nativeSchemas), acquireResult: reconciliation.result };
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(nativeSchemas);
const contributionRef = { pluginId: PLUGIN_ID, localId: PROVISIONER_ID } as const;
const resourceRef = <T>(value: T) => ({ contributionRef, schemaVersion: 1, value });
const pending = (value: BoatAcquireOperationV1) => ({ kind: 'pending' as const, nativeOperationRef: resourceRef(value) });
const billing = { location: 'cloud', stoppedBilling: 'not-billed' } as const;
const retention = { supportedIntents: ['stop', 'resume', 'delete'] } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE] } as const;
const runtime = (context: PluginInvocationContext) => createBoatNativeClient({ fetch: nativeFetch(context), signal: context.signal });
const PRICE_SOURCE = 'https://docs.boat.dev/pricing';

function sizeTitle(size: BoatSize): string {
  return `${size.id} · ${size.multiplier}x · ${size.cpuCores} vCPU · ${size.memoryGb} GB RAM · ${size.diskGb} GB · $${size.hourlyUsd}/hour`;
}

function sizeOption(size: BoatSize, observedAt: number) {
  return {
    id: size.id, title: sizeTitle(size), assignments: [{ path: 'size', value: size.id }],
    prices: [{ label: boatPresentationLabel('compute'), amount: size.hourlyUsd, currency: 'USD', unit: 'hour', source: PRICE_SOURCE, observedAt }],
    nativeFacts: {
      size: { id: size.id, title: `${size.id} (${size.multiplier}x)`, cpuCores: size.cpuCores,
        memoryBytes: size.memoryGb * 1024 ** 3, diskBytes: size.diskGb * 1000 ** 3 }, }, };
}

function sourceOption(source: { kind: 'blank' } | { kind: 'named-snapshot'; name: string } | { kind: 'fork'; sandboxId: string }, title: string) {
  const id = source.kind === 'blank' ? 'blank' : source.kind === 'named-snapshot' ? `snapshot/${source.name}` : `fork/${source.sandboxId}`;
  // These are filesystem starting sources; the existing image/source control
  // carries their exact native selector, including a fork's source sandbox id.
  // Boat's Linux sandbox contract also covers saved disks and forks: https://docs.boat.dev/concepts.
  return { id, title, assignments: [{ path: 'source', value: source }], nativeFacts: { image: { id, title } } };
}

export const MACHINE_PROVISIONER = {
  title: 'Boat', icon: 'cloud', resourceKind: 'boat-sandbox', schemaVersion: 1,
  kindTitle: boatPresentationLabel('kind'), description: boatPresentationLabel('description'),
  launchSchema: BoatLaunchV1Schema.jsonSchema, resourceSchema: BoatResourceV1Schema.jsonSchema, resourceIdPath: 'sandboxId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'systemTool', id: 'ssh-keyscan' }],
  billing, retention, bootstrapCredential: { kind: 'ssh' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: BoatNativeOperationV1Schema.jsonSchema },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Boat Machines',
  description: 'Create and manage Boat sandboxes as ordinary Happier Machines.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate the exact reviewed Boat sandbox.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://boat.dev' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured Boat account.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
    { id: 'ssh-evidence', capability: 'process', reason: 'Observe and verify the managed sandbox host key.',
      scope: { executables: [{ kind: 'systemTool', id: 'ssh-keyscan' }] } },
  ], optional: [] },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Boat account', ui: { category: 'cloud-machines' }, authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API key', outcomeReconciliation: 'none',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API key', schema: { type: 'string', minLength: 1 }, secret: true }],
    }] } },
    runtime: connectedAccountRuntime,
  } },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  actions: {
    reconcile: { ...defaults, title: 'Recover exact Boat sandbox', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        const native = runtime(context);
        const operation = 'nativeOperation' in input ? input.nativeOperation : {
          kind: 'acquire' as const,
          idempotencyKey: input.correlation.managedId,
          requestFingerprint: JSON.stringify((() => {
            const launch = input.correlation.launch;
            const common = { type: launch.size, snapshots: true, noEnv: true, ttlSeconds: null };
            return launch.source.kind === 'blank' ? { path: '/sandboxes', body: common }
              : launch.source.kind === 'named-snapshot' ? { path: '/sandboxes', body: { ...common, from: launch.source.name } }
              : { path: `/sandboxes/${encodeURIComponent(launch.source.sandboxId)}/fork`, body: common };
          })()),
          sourceKind: input.correlation.launch.source.kind,
          requestedAtMs: context.invokedAtMs,
        };
        if (operation.kind === 'delete') {
          return { kind: 'unknown' as const, recovery: { reference: operation.operationId, reason: 'native_destroy_custody_requires_shared_owner' } };
        }
        try {
          const result = await native.reconcileAcquire(operation);
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: resourceRef(result.resource) };
          if (result.kind === 'pending') return pending(result.operation);
          if (result.kind === 'unknown') return { kind: 'unknown' as const, recovery: { reference: operation.idempotencyKey, reason: result.code } };
          return { kind: 'rejected' as const, code: result.code === 'native_idempotency_mismatch' ? 'request_conflict' as const : 'provider_unavailable' as const };
        } catch {
          return pending(operation);
        }
      },
    },
    check: { ...defaults, title: 'Check Boat API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { return boatCheckPresentation(await runtime(context).check()); }
        catch { return boatCheckPresentation({ available: false, code: 'provider_unavailable' }); }
      },
    },
    options: { ...defaults, title: 'Discover Boat sandbox options', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context): Promise<MachineProvisionerOptionsResultV1> {
        const facts = await runtime(context).options();
        return { base: { launch: {}, retention, nativeFacts: { monthlyCapStatus: 'none' } }, dimensions: {
          size: facts.sizes.map(size => sizeOption(size, context.invokedAtMs)),
          image: [sourceOption({ kind: 'blank' }, 'Blank sandbox'),
            ...facts.snapshots.map(snapshot => sourceOption({ kind: 'named-snapshot', name: snapshot.name }, `Snapshot ${snapshot.name}`)),
            ...facts.sandboxes.map(sandbox => sourceOption({ kind: 'fork', sandboxId: sandbox.id }, `Fork ${sandbox.name ?? sandbox.id} (${sandbox.id})`))],
          location: [{ id: 'eu', title: 'EU only', assignments: [], nativeFacts: { location: { id: 'eu', title: 'EU only' } } }],
          network: [], duration: [], } };
      },
    },
    acquire: { ...defaults, title: 'Create Boat sandbox', dangerLevel: 'destructive',
      confirmation: { title: 'Create this Boat sandbox?', body: 'Boat bills running time per second. Stopping pauses compute billing; plans start at $20/month with the same amount of included usage.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        if (!input.managedId) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        try {
          const result = await runtime(context).acquire({ launch: input.launch, idempotencyKey: input.managedId });
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: resourceRef(result.resource) };
          if (result.kind === 'pending') return pending(result.operation);
          if (result.kind === 'unknown') return { kind: 'unknown' as const, recovery: { reference: input.managedId, reason: result.code } };
          return { kind: 'rejected' as const, code: result.code === 'native_idempotency_mismatch' ? 'request_conflict' as const : 'provider_unavailable' as const };
        } catch {
          const common = { type: input.launch.size, snapshots: true, noEnv: true, ttlSeconds: null };
          const selected = input.launch.source.kind === 'blank' ? { path: '/sandboxes', body: common }
            : input.launch.source.kind === 'named-snapshot' ? { path: '/sandboxes', body: { ...common, from: input.launch.source.name } }
            : { path: `/sandboxes/${encodeURIComponent(input.launch.source.sandboxId)}/fork`, body: common };
          return pending({ kind: 'acquire', idempotencyKey: input.managedId, requestFingerprint: JSON.stringify(selected),
            sourceKind: input.launch.source.kind, requestedAtMs: context.invokedAtMs });
        }
      },
    },
    bootstrap: { ...defaults, hostAccess: [...defaults.hostAccess, 'ssh-evidence'], title: 'Prepare Boat sandbox for Happier', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Boat sandbox for Happier?', body: 'Happier will configure SSH, verify the host key, and install the ordinary daemon service.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) {
        if (!input.bootstrapPublicKey) throw new Error('credential_unavailable');
        const connection = await runtime(context).bootstrap(input.resource, input.bootstrapPublicKey);
        const carrier = await resolveMachineProvisionerSshBootstrap({ exec: context.services.exec, signal: context.signal,
          connection: { address: connection.address, user: connection.username, port: connection.port }, credentialRef: input.credentialRef });
        if (carrier.kind !== 'ssh') throw new Error('native_ssh_host_key_mismatch');
        const expected = connection.hostKey.trim().split(/\s+/u).slice(0, 2).join(' ');
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
          if (result.kind === 'absent') return { observedAt: context.invokedAtMs, availability: 'absent' as const, power: 'unknown' as const };
          if (result.kind === 'failed') return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: 'native_resource_failed' };
          return { observedAt: context.invokedAtMs, availability: 'present' as const, power: result.power, storage: 'retained' as const, billing };
        } catch { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: 'provider_unavailable' }; }
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
          const code = error instanceof Error && error.message.startsWith('native_') ? error.message : 'provider_unavailable';
          return { kind: 'unknown' as const, code };
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
            return { kind: 'unknown' as const, code: 'native_destroy_pending' };
          }
          const result = await native.destroy({ resource: input.resource });
          return { kind: 'accepted' as const, nativeOperationRef: resourceRef(result.operation) };
        } catch (error) {
          const code = error instanceof Error && error.message.startsWith('native_') ? error.message : 'provider_unavailable';
          return { kind: 'unknown' as const, code };
        }
      },
    },
  },
  ui: { translations: BOAT_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = PLUGIN.manifest;
