import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuration } from '@/configuration';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import { buildActionExecutorContextForRpc, type RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerActionSpecRpcHandlers, type RegisterActionSpecRpcHandlersParams } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { getMachineAdminAccessV1, MACHINE_REACHABILITY_ACTION_IDS_V1,
  MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1, MACHINE_REACHABILITY_ACTION_OUTPUT_SCHEMAS_V1,
  type MachineAdminAccessV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { getFirstPartyComponentCatalogEntry, resolveFirstPartyInstallLayout,
  resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import type { DaemonMachineAdminAccessRoutes } from '@/rpc/handlers/daemonMachineAdminAccess';
import { inspectMachineReachability, executeMachineReachabilityTransition } from './machineReachabilityHost';
import { projectMachineReachabilityObservation, readMachineReachabilityMetadata } from './readMachineReachability';
import { prepareReachabilityReviewedChildrenForHost } from './reachabilityProviderHost';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectNativeInvocationCustody } from '@/workspaces/projectSetup/projectSetupExecution';
import { observeOwnDaemonReachability } from './observeOwnDaemonReachability';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';

type Target = Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }>;
export type DaemonMachineReachabilityRoutes = Readonly<{
  target(): Target | null;
  agentIsolation: HostAgentIsolationLaunchContext;
  adminAccess: Pick<DaemonMachineAdminAccessRoutes, 'observer'>;
  ownerRemainder?: OwnerRemainderPort;
  getMachineClient(): Pick<ApiMachineClient, 'updateDaemonState' | 'resolveMachineSetupRuntime'
    | 'callConnectedClientRpc' | 'isMachineControlRegistrationReady'> | null;
}>;

/** The current daemon's existing authorities are captured on each admitted call. */
export function createDaemonMachineReachabilityRoutes(input: DaemonMachineReachabilityRoutes): DaemonMachineReachabilityRoutes {
  return input;
}

export function registerDaemonMachineReachabilityRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineReachabilityRoutes & Readonly<{
  captureMetadataPort(): MachineMetadataFieldPortV1;
  resolveActionExecutor: NonNullable<RegisterActionSpecRpcHandlersParams['resolveActionExecutor']>;
  observeExecution: NonNullable<RegisterActionSpecRpcHandlersParams['observeExecution']>;
}>): void {
  const target = options.target();
  registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: MACHINE_REACHABILITY_ACTION_IDS_V1,
    resolveActionExecutor: options.resolveActionExecutor, observeExecution: options.observeExecution,
    ...(target ? { targetMachineId: target.machineId } : {}), defaultMachineTarget: true });
}

type MetadataRoutes = DaemonMachineReachabilityRoutes & Readonly<{
  captureMetadataPort(): MachineMetadataFieldPortV1;
}>;
type ReachabilityInvocation = Readonly<{
  actionId: Parameters<NonNullable<ActionExecutorDeps['machineReachabilityAction']>>[0]['actionId'];
  input: unknown;
}>;

/** The same received Machine binding serves review preparation and native execution. */
function captureMachineReachabilityTarget(options: MetadataRoutes, invocation: ReachabilityInvocation, ingress: RpcHandlerContext) {
  const { actionId, input: request } = invocation;
  const target = options.target();
  if (!target || !ingress) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
  const matches = () => {
    const current = options.target();
    return !!target && !!current && !ingress?.signal.aborted
      && current.serverId === target.serverId && current.machineId === target.machineId
      && current.installationId === target.installationId && current.custodianAccountId === target.custodianAccountId
      && (actionId !== 'machines.reachability.configure' || ingress?.machineAdmission?.role === 'manage')
      && doesMachineRpcTargetMatchAdmission(request, ingress?.machineAdmission, current);
  };
  return { target, matches };
}

/** Review reads captured local state/catalog only; ingress already owns Machine admission. */
export async function prepareDaemonMachineReachabilityReviewedChildren(options: MetadataRoutes,
  invocation: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
  ingress: RpcHandlerContext): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
  if (invocation.actionId !== 'machines.reachability.inspect' && invocation.actionId !== 'machines.reachability.configure') return null;
  try {
    const { matches } = captureMachineReachabilityTarget(options,
      { actionId: invocation.actionId, input: invocation.input }, ingress);
    if (!matches()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      const state = await readMachineReachabilityMetadata(options.captureMetadataPort());
      return await prepareReachabilityReviewedChildrenForHost({ ...invocation,
        runtimeRegistry: lease.registry,
        selections: [...state.selections, ...(state.posture?.management.providers ?? [])] });
    } finally { await lease.release(); }
  } catch (error) { throwMachineReachabilityRpcError(error); }
}

/** Native effect port reached only beneath the credentialed canonical Action executor. */
export async function executeDaemonMachineReachabilityAction(options: MetadataRoutes,
  invocation: Parameters<NonNullable<ActionExecutorDeps['machineReachabilityAction']>>[0], ingress: RpcHandlerContext): Promise<unknown> {
    const { actionId, input: raw } = invocation;
    const request = MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw);
    const { target, matches } = captureMachineReachabilityTarget(options, { actionId, input: request }, ingress);
    if (!matches()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
    const port = options.captureMetadataPort();
    const client = options.getMachineClient();
    const identity = readInstallationIdentityIfExistsSync();
    if (!client || !identity || identity.installationId !== target.installationId) throw new RpcError('Current Machine runtime is required', RPC_ERROR_CODES.FORBIDDEN);
    const projected = buildActionExecutorContextForRpc({ ...ingress, actionId, serverId: target.serverId,
      externalActionTarget: { kind: 'machine', machineId: target.machineId } });
    const context = { ...projected, ...invocation.context,
      actionRequestId: invocation.context.actionRequestId ?? projected.actionRequestId ?? ingress.transportRequestId };
    if (!context.actionRequestId) throw new RpcError('Current Action correlation is required', RPC_ERROR_CODES.FORBIDDEN);
    const execute = async (context: RpcActionExecutorContext): Promise<unknown> => {
      const runtime = actionId === 'machines.reachability.configure' ? await client.resolveMachineSetupRuntime(ingress) : null;
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      const signal = context.signal ?? ingress.signal;
      const isCurrent = async () => matches() && (!runtime || !!runtime.isCurrent && await runtime.isCurrent());
      // The first P10 stage admits this finite original Action. Cleanup and
      // later stages reuse its policy; local cancellation and root native
      // verification remain owned by the existing elevation interpreter.
      let admittedAdminPolicy: Promise<MachineAdminAccessV1> | undefined;
      const custody = createProjectNativeInvocationCustody({ signal });
      try {
      const channel = resolveManagedCliReleaseChannelSync().ringId;
      const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel });
      const component = getFirstPartyComponentCatalogEntry('happier-cli');
      const deps = { target, port, context, runtimeRegistry: lease.registry, isCurrent,
        readDaemonProof: () => observeOwnDaemonReachability({ client, signal }),
        happyHomeDir: configuration.happyHomeDir, agentIsolation: options.agentIsolation,
        nativeEffects: {
          userHomeDirectory: homedir(),
          hostEnvironment: { ...process.env },
          environmentIo: createProjectNativeIo({ ownerRemainder: options.ownerRemainder }).environmentIo.createInvocation({
            signal, retainCapture: custody.retain,
          }),
          resolveSetupScriptServiceEffects: (serviceIds: readonly string[]) => lease.registry.projectManagedServices.resolveSetupScriptServiceEffects({
            serverId: target.serverId, machineId: target.machineId, serviceIds, signal,
          }),
        },
        settleNative: () => custody.release(),
        ...(runtime ? { runtime } : {}), ...(ingress.machineAdmission ? { machineAdmission: ingress.machineAdmission } : {}),
        installationPublicKey: decodeBase64(identity.publicKey, 'base64url'), installationIdentityFile: configuration.installationIdentityFile,
        elevation: { installationId: target.installationId, installedCli: join(layout.currentPath, component.binaryRelativePath),
          readPolicy: () => admittedAdminPolicy ??= (async () => {
            const policy = await getMachineAdminAccessV1(port);
            if (policy.status !== 'ready') throw Object.assign(new Error('machine_admin_access_policy_unavailable'), { code: 'machine_admin_access_policy_unavailable' });
            return policy.policy;
          })(), observe: async () => (await options.adminAccess.observer.inspect()).observation,
          emit: (event: Parameters<NonNullable<import('@/machines/adminAccess/runElevatedEffect').MachineElevationDependencies['emit']>>[0]) => {
            if (event.data && typeof event.data === 'object' && 'phase' in event.data && typeof event.data.phase === 'string') {
              context.operationProgress?.update({ phase: event.data.phase });
            }
          },
        },
        publish: async (observation: import('@happier-dev/protocol').MachineReachabilityObservationV1) => {
          const current = options.getMachineClient();
          if (!current) throw new Error('machine_reachability_publication_unavailable');
          let published: import('@happier-dev/protocol').MachineReachabilityObservationV1 | undefined;
          const outcome = await current.updateDaemonState(state => {
            if (!state) throw new Error('machine_reachability_publication_unavailable');
            published = projectMachineReachabilityObservation(state.reachability, observation);
            return published === state.reachability ? state : { ...state, reachability: published };
          });
          if (outcome === 'suppressed' || !published) throw new Error('machine_reachability_publication_unavailable');
          return published;
        },
      };
      const result = actionId === 'machines.reachability.inspect'
        ? await inspectMachineReachability(MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1['machines.reachability.inspect'].parse(raw), deps)
        : await executeMachineReachabilityTransition(MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1['machines.reachability.configure'].parse(raw), deps);
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) return failure.data;
        return MACHINE_REACHABILITY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result);
      } finally {
        try { await custody.release(); }
        finally { custody.dispose(); await lease.release(); }
      }
    };
    try {
      return await execute(context);
    } catch (error) {
      throwMachineReachabilityRpcError(error);
    }
}

/** Preserve the owner's typed failure at the existing RPC boundary. */
function throwMachineReachabilityRpcError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
  if (code) throw new RpcError(code, code);
  throw error;
}
