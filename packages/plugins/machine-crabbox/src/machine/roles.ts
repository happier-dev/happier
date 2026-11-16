import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { machineCheckPresentation, machinePresentationLabel } from '../ui/translations.js';
import { prepareCrabboxConnection } from './connection.js';
import { crabboxLeaseId, createCrabboxProvider, CrabboxDependencyUnavailable } from './provider.js';
import { projectMachineProvisionerActionFailure, observeMachineProvisionerNativeRead, type MachineProvisionerCheckResultV1, type MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { CRABBOX_DEPENDENCY_ID, CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';
import { CrabboxOptionsInputV1Schema, CrabboxResourceV1Schema, resolveCrabboxLaunchQueryCandidate, crabboxCloudPreparationGuest } from './schemas.js';
import type { CRABBOX_ROLE_SCHEMAS, CRABBOX_RECONCILIATION, CrabboxLaunchV1, CrabboxResourceV1 } from './schemas.js';

export type CoordinatorContext = Readonly<{
  services: Pick<PluginAccountActionContext['services'], 'connectedAccounts' | 'http'>;
  signal: AbortSignal;
  invokedAtMs: number;
}>;

type RoleInput<K extends keyof typeof CRABBOX_ROLE_SCHEMAS> = ProtocolSchemaOutput<(typeof CRABBOX_ROLE_SCHEMAS)[K]>;
export type CrabboxProviderResolver<TContext extends CoordinatorContext> =
  (selection: CrabboxLaunchV1 | CrabboxResourceV1, context: TContext) => Promise<ReturnType<typeof createCrabboxProvider>>;
const contributionRef = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_PROVISIONER_ID };

function providerFailureCode(error: unknown, selection: CrabboxLaunchV1 | CrabboxResourceV1) {
  if (error instanceof CrabboxDependencyUnavailable) return error.code;
  if (selection.transport === 'direct') throw error;
  return 'credential_unavailable' as const;
}

export async function reconcileCrabbox<TContext extends CoordinatorContext>(
  input: ProtocolSchemaOutput<typeof CRABBOX_RECONCILIATION.input>, context: TContext,
  providerFor: CrabboxProviderResolver<TContext>, reference: PluginContributionRef = contributionRef) {
  let resource: CrabboxResourceV1;
  if ('nativeOperation' in input) resource = input.nativeOperation;
  else {
    const leaseId = crabboxLeaseId(input.correlation.managedId);
    const recovered = CrabboxResourceV1Schema.safeParse({ backendId: input.correlation.launch.backendId,
      namespace: input.correlation.launch.namespace, transport: input.correlation.launch.transport, leaseId,
      ...('localContainerRuntime' in input.correlation.launch && input.correlation.launch.localContainerRuntime
        ? { localContainerRuntime: input.correlation.launch.localContainerRuntime } : {}) });
    if (!recovered.success) return { kind: 'unknown' as const, recovery: { reference: leaseId, reason: 'native_correlation_unqualified' } };
    resource = recovered.data;
  }
  try { return await (await providerFor(resource, context)).reconcile(resource); }
  catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'pending' as const, nativeOperationRef: { contributionRef: reference, schemaVersion: 1, value: resource } })); }
}

export async function acquireCrabbox<TContext extends CoordinatorContext>(input: RoleInput<'acquireInput'>, context: TContext,
  providerFor: CrabboxProviderResolver<TContext>) {
  if (input.launch.transport === 'direct' && input.launch.backendId !== 'local-container') return { kind: 'rejected' as const,
    code: 'provider_unavailable' as const, nativeCause: { localCause: 'native_route_unavailable' as const } };
  if (!input.managedId || !input.bootstrapPublicKey) return { kind: 'rejected' as const, code: 'invalid_request' as const };
  try { return await (await providerFor(input.launch, context)).acquire(input); }
  catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'rejected' as const, code: providerFailureCode(error, input.launch) })); }
}

export async function bootstrapCrabbox<TContext extends CoordinatorContext>(input: RoleInput<'bootstrapInput'>, context: TContext,
  providerFor: CrabboxProviderResolver<TContext>) {
  return (await providerFor(input.resource, context)).bootstrap(input);
}

export async function inspectCrabbox<TContext extends CoordinatorContext>(input: RoleInput<'resourceInput'>, context: TContext,
  providerFor: CrabboxProviderResolver<TContext>) {
  if (!input.resource.nativeInstanceId) return observeMachineProvisionerNativeRead(context.invokedAtMs,
    { kind: 'unknown', reason: 'crabbox_connection_custody_unavailable' });
  try { return await (await providerFor(input.resource, context)).inspect(input.resource); }
  catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: providerFailureCode(error, input.resource) })); }
}

export async function destroyCrabbox<TContext extends CoordinatorContext>(
  input: ProtocolSchemaOutput<typeof CRABBOX_RECONCILIATION.destroyInput>, context: TContext, providerFor: CrabboxProviderResolver<TContext>) {
  const resource = 'resource' in input ? input.resource : input.nativeOperation;
  try { return await (await providerFor(resource, context)).destroy(resource); }
  catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'refused' as const, code: providerFailureCode(error, resource) })); }
}

export async function inspectedCrabboxProvider(context: CoordinatorContext, reference: PluginContributionRef = contributionRef) {
  return createCrabboxProvider({ ...await prepareCrabboxConnection(context.services.connectedAccounts, context.services.http, context.signal),
    observedAt: context.invokedAtMs, signal: context.signal, contributionRef: reference });
}

export async function checkCrabboxCoordinator(context: CoordinatorContext) {
  try { await inspectedCrabboxProvider(context); return machineCheckPresentation({ available: true }); }
  catch (error) { return projectMachineProvisionerActionFailure(error, () => machineCheckPresentation({ available: false, code: 'credential_unavailable' })); }
}

/** Local readiness belongs to the native dependency, independently of cloud sign-in. */
export async function checkCrabboxDirect(direct: () => Promise<unknown>): Promise<MachineProvisionerCheckResultV1> {
  try { await direct(); return machineCheckPresentation({ available: true }); }
  catch (error) {
    if (!(error instanceof CrabboxDependencyUnavailable)) throw error;
    return machineCheckPresentation({ available: false, code: error.code, prerequisites: [{
      requirement: { kind: 'managedDependency', id: { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_DEPENDENCY_ID } },
      status: 'unavailable',
      repairAction: { action: { pluginId: CRABBOX_PLUGIN_ID, localId: 'install' }, input: {} },
    }] });
  }
}

/** Only a selected direct route demands its native host adapter. Coordinator
 * checks/options never discover or probe the local executable. */
export async function crabboxOptions(input: ProtocolSchemaOutput<typeof CrabboxOptionsInputV1Schema>, context: CoordinatorContext,
  direct?: () => Promise<unknown>): Promise<MachineProvisionerOptionsResultV1> {
  const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
  const selected = resolveCrabboxLaunchQueryCandidate(input);
  if (!selected.success) return { dimensions };
  const launch = selected.data;
  let available = false;
  let prerequisites: MachineProvisionerCheckResultV1['prerequisites'];
  try {
    if (launch.transport === 'coordinator') {
      const selectedConnection = await prepareCrabboxConnection(context.services.connectedAccounts, context.services.http, context.signal);
      available = launch.namespace === selectedConnection.connection.namespace;
    } else if (launch.backendId === 'local-container' && direct) {
      const readiness = await checkCrabboxDirect(direct);
      available = readiness.available;
      prerequisites = readiness.prerequisites;
    }
  } catch (error) {
    projectMachineProvisionerActionFailure(error, () => {
      if (launch.transport === 'direct' && !(error instanceof CrabboxDependencyUnavailable)) throw error;
      // Preserve the reviewed launch while exposing the selected route's refusal.
    });
  }
  const preparationGuest = crabboxCloudPreparationGuest(launch);
  return { dimensions, base: { launch,
    ...(prerequisites ? { prerequisites } : {}),
    ...(preparationGuest ? { nativeFacts: { preparationGuest } } : {}),
    guestPlatform: launch.target === 'macos' ? 'darwin' as const : 'linux' as const,
    enrollmentRole: launch.backendId === 'local-container' ? 'sandbox' as const : 'server' as const, available,
    ...(!available && launch.transport === 'direct' ? { unavailableReason: {
      code: 'provider_unavailable', status: machinePresentationLabel('provider_unavailable'),
    } } : {}),
  } };
}
