import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionApprovalScopeV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { MachineServiceControlResultV1 } from '@happier-dev/protocol';
import type { MachineServiceExecResultV1 } from '@happier-dev/protocol';
import type { EnvironmentProjectManagedServiceHandle, MachineManagedServiceHandle, createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { readColdNativeComposeTargetsForHost } from './nativeComposeDiscovery';

/** Select from the mounted owner, never from retained Inbox evidence or native labels. */
export type MachineServiceTargetHandle = EnvironmentProjectManagedServiceHandle | MachineManagedServiceHandle;

/** Log-only native discovery never supplies a mounted service or execution custody. */
export type MachineServiceLogTargetHandle = MachineManagedServiceHandle | Pick<EnvironmentProjectManagedServiceHandle,
  'kind' | 'environmentId' | 'deploymentId' | 'actionScope' | 'instanceId' | 'readLogs' | 'watchLogs' | 'isCurrent' | 'retirementSignal'>;

type MachineServiceTargetInput = Readonly<{
  request: Readonly<{ serverId: string; machineId: string; serviceId: string; expectedGeneration?: string }>;
  machineId: string;
  serverId: string;
  signal?: AbortSignal;
  approvalScope?: ActionApprovalScopeV1;
  assertCurrent(): Promise<void>;
}>;

export function withMachineServiceTarget<T>(input: MachineServiceTargetInput,
  consume: (handle: MachineServiceTargetHandle) => Promise<T>): Promise<T | ActionExecuteFailure> {
  return withSelectedMachineServiceTarget(input, consume);
}

export async function withMachineServiceLogTarget<T>(input: MachineServiceTargetInput,
  consume: (handle: MachineServiceLogTargetHandle) => Promise<T>): Promise<T | ActionExecuteFailure> {
  try {
    return await withSelectedMachineServiceTarget(input, consume, undefined, owner => withColdNativeLogTarget(input, consume, owner));
  } catch (error) {
    // Preserve the native owner's typed refusal across Action/Resource dispatch;
    // generic thrown errors otherwise become action_failed at that boundary.
    if (isPluginError(error) && error.code === 'secret_redaction_unavailable')
      return { ok: false, errorCode: error.code, error: error.message,
        ...(error.data.details === undefined ? {} : { details: error.data.details }),
        ...(error.data.failureCause ? { failureCause: error.data.failureCause } : {}),
      };
    throw error;
  }
}

async function withColdNativeLogTarget<T>(input: MachineServiceTargetInput,
  consume: (handle: MachineServiceLogTargetHandle) => Promise<T>,
  owner?: Pick<ReturnType<typeof createManagedServicesOwner>, 'readEnvironmentServiceLogRedactionLease'>): Promise<T | ActionExecuteFailure> {
  const refused = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  const [environmentInstanceId, composeService, ...extra] = input.request.serviceId.split('/');
  if (!environmentInstanceId || !composeService || extra.length) return refused('service_unavailable');
  const { readOwnServerDeploymentEnvironmentIdForHost, resolveOwnServerDeploymentIdentityForHost } = await import('@/deployments/targets/ownServer/paths');
  const homeServerId = await resolveServerProfileHomeIdentityId(input.serverId);
  const environmentId = homeServerId ? readOwnServerDeploymentEnvironmentIdForHost(homeServerId, environmentInstanceId) : null;
  if (!homeServerId || !environmentId) return refused('service_unavailable');
  if (input.approvalScope && (input.approvalScope.kind !== 'environment'
    || input.approvalScope.environmentId !== environmentId)) return refused('approval_stale');
  const [{ configuration }, { createOwnServerNativeRuntime }, nativeLogs, exec, { MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES }, nativeEngine] = await Promise.all([
    import('@/configuration'), import('@/deployments/targets/ownServer/nativeRuntime'), import('./nativeComposeLifecycle'),
    import('@/plugins/runtime/invocation/services/exec'), import('@/plugins/runtime/invocation/services/managedServiceNativeLogBudget'),
    import('./nativeComposeEngine'),
  ]);
  const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
    serverId: input.serverId, environmentId });
  const signal = input.signal ?? new AbortController().signal;
  let current = true;
  const runtime = createOwnServerNativeRuntime({ cwd: configuration.happyHomeDir, signal, isCurrent: () => current });
  let launch: Awaited<ReturnType<typeof exec.authorizePluginExecLaunchForHost>> | undefined;
  try {
    const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose',
      cwd: configuration.happyHomeDir, signal });
    launch = await exec.authorizePluginExecLaunchForHost(runtime.exec, {
      executable: tool.executable, args: [], cwd: configuration.happyHomeDir,
    }, { signal });
    const tuple = launch;
    const env = Object.fromEntries(Object.entries(tuple.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const run = (args: readonly string[], readSignal?: AbortSignal) => runtime.nativeIo.run({
      command: tuple.command, args: [...tuple.args, ...args], cwd: tuple.cwd!, env,
      signal: readSignal ?? signal,
    });
    const targets = await readColdNativeComposeTargetsForHost({ ...identity, composeServices: [composeService], run });
    const target = targets?.[0];
    if (!target) return refused('service_unavailable');
    const instanceId = JSON.stringify([...target.containerIds].sort());
    if (input.request.expectedGeneration !== undefined && input.request.expectedGeneration !== instanceId)
      return refused('service_generation_changed');
    const redactionLease = owner?.readEnvironmentServiceLogRedactionLease(homeServerId, {
      kind: 'deployment', machineId: input.machineId, environmentId, environmentInstanceId, composeService,
      serviceId: input.request.serviceId,
    }, target);
    const activationMasking = redactionLease ? undefined : await machineNativeEffectAdmission.readComposeLogMasking({
      projectName: target.project, sourcePath: target.sourcePath, composeService, containerIds: target.containerIds,
    }, async () => {
      try {
        return (await nativeEngine.readNativeComposeEngine({ io: runtime.nativeIo, command: tuple.command,
          prefix: tuple.args, cwd: tuple.cwd!, env, signal })).id;
      } catch (error) {
        if (signal.aborted || !(error instanceof nativeEngine.NativeComposePrerequisiteError)) throw error;
        return undefined;
      }
    });
    signal.throwIfAborted();
    return await consume({ kind: 'environment', environmentId: target.environmentId, deploymentId: target.deploymentId,
      actionScope: { kind: 'environment', environmentId: target.environmentId }, instanceId,
      isCurrent: () => current && !signal.aborted, retirementSignal: signal,
      readLogs: options => nativeLogs.readNativeComposeLogsForHost({ containerIds: target.containerIds, environment: true,
        redactionLease: redactionLease ?? activationMasking?.lease, redactionComplete: activationMasking?.complete, run },
        { kind: 'read', maxBytes: MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES, ...options }),
    });
  } finally {
    current = false;
    try { await launch?.release(); await runtime.settleNative(); }
    finally { await exec.readPluginExecProcessCustodyForHost(runtime.exec).requestStop(); }
  }
}

/** Native settlement survives generation retirement without publishing stale state. */
export function withMachineServiceControlTarget(input: MachineServiceTargetInput,
  consume: (handle: MachineServiceTargetHandle) => Promise<MachineServiceControlResultV1 | ActionExecuteFailure>): Promise<MachineServiceControlResultV1 | ActionExecuteFailure> {
  return withSelectedMachineServiceTarget(input, consume, result => {
    if (!('kind' in result)) return { ok: false, errorCode: 'service_unavailable', error: 'service_unavailable' };
    return result.kind === 'observed' ? { kind: 'accepted', operation: result.operation } : result;
  });
}

/** Return the admitted finite command's actual settlement, including redacted output. */
export function withMachineServiceCommandTarget(input: MachineServiceTargetInput,
  consume: (handle: MachineServiceTargetHandle) => Promise<MachineServiceExecResultV1 | ActionExecuteFailure>): Promise<MachineServiceExecResultV1 | ActionExecuteFailure> {
  return withSelectedMachineServiceTarget(input, consume, 'admitted');
}

async function withSelectedMachineServiceTarget<T>(input: MachineServiceTargetInput,
  consume: (handle: MachineServiceTargetHandle) => Promise<T>,
  retainSettlement?: 'admitted' | ((result: T) => T | ActionExecuteFailure),
  missing?: (owner?: Pick<ReturnType<typeof createManagedServicesOwner>, 'readEnvironmentServiceLogRedactionLease'>) => Promise<T | ActionExecuteFailure>): Promise<T | ActionExecuteFailure> {
  const refused = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  if (input.machineId !== input.request.machineId) return refused('machine_target_mismatch');
  if (!await isServerProfileHomeIdentity(input.serverId, input.request.serverId)) return refused('server_target_mismatch');
  input.signal?.throwIfAborted();
  await input.assertCurrent();
  const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
  if (!lease) return missing ? missing() : refused('service_admission_unavailable');
  try {
    const owner = lease.registry.projectManagedServices;
    const candidates: readonly MachineServiceTargetHandle[] = [
      ...owner.listProjectServices().filter((candidate): candidate is EnvironmentProjectManagedServiceHandle => candidate.kind === 'environment'),
      ...owner.listMachineServices(),
    ];
    let handle: MachineServiceTargetHandle | undefined;
    for (const candidate of candidates) {
      if (candidate.machineId !== input.machineId || candidate.serviceId !== input.request.serviceId
        || !candidate.isCurrent() || candidate.retirementSignal.aborted
        || !await isServerProfileHomeIdentity(input.serverId, candidate.serverId)) continue;
      handle = candidate;
      break;
    }
    if (!handle) return missing ? await missing(owner) : refused('service_unavailable');
    if (input.approvalScope) {
      const scope = input.approvalScope;
      const matches = handle.kind === 'adopted'
        ? scope.kind === 'machine' && scope.machineId === handle.actionScope.machineId
        : scope.kind === 'environment' && scope.environmentId === handle.actionScope.environmentId;
      if (!matches) return refused('approval_stale');
    }
    if (input.request.expectedGeneration !== undefined && input.request.expectedGeneration !== handle.instanceId)
      return refused('service_generation_changed');
    const result = await consume(handle);
    // Only finite commands select this policy. Their native owner already
    // settled the admitted invocation; access withdrawal governs the next
    // invocation, not disclosure of this completed redacted result.
    if (retainSettlement === 'admitted') return result;
    try {
      input.signal?.throwIfAborted();
      // Caller authority was admitted before consume. Retain only physical
      // generation custody here; the next invocation admits its own caller.
      const mounted = handle.kind === 'adopted' ? owner.listMachineServices().includes(handle) : owner.listProjectServices().includes(handle);
      if (!handle.isCurrent() || handle.retirementSignal.aborted || !mounted)
        return retainSettlement ? retainSettlement(result) : refused('service_unavailable');
    } catch (error) {
      if (retainSettlement) return retainSettlement(result);
      throw error;
    }
    return result;
  } finally {
    await lease.release();
  }
}
