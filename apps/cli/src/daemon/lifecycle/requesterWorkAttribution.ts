import type { RpcHandlerContext, RpcLocalActionContext } from '@/api/rpc/types';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectDaemonSpawnUnavailable, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { rethrowRequesterHomeReadFailure } from '../sessionEncryption/requesterCurrentness';
import { isOriginalAccountActionCustody } from '../sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionTransportContext } from '../sessionEncryption/requesterAccountActionContext';
import { readHostReviewedChildOriginalAuthorizationV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
export { RequesterWorkAttributionV1Schema, RequesterWorkAttributionStoredReadV1Schema,
  type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';

/** Stamp the held Home identity; a resource target's serverId is a local profile alias. */
export function projectDaemonRequesterWorkAttribution(target: Readonly<{
  serverId: string; custodianAccountId: string; machineId: string; installationId: string;
}> | null, homeServerIdentityId: string | null): RequesterWorkAttributionV1 | null {
  return target && homeServerIdentityId ? { serverId: homeServerIdentityId, accountId: target.custodianAccountId,
    machineId: target.machineId, installationId: target.installationId } : null;
}

/** Carry already-admitted requester facts into host-owned work, never public RPC input. */
export function projectRpcRequesterWorkAttribution(context: Readonly<Partial<Pick<RpcHandlerContext,
  'signal' | 'machineAdmission' | 'callerInputAuthorization' | 'localActionContext' | 'requesterSessionBootstrap'>> & {
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    authenticatedLocalRootCustody?: RpcLocalActionContext['authenticatedLocalRootCustody'];
  }> | undefined, serverId?: string): RequesterWorkAttributionV1 | undefined {
  const admission = context?.machineAdmission;
  const binding = context?.callerInputAuthorization?.binding;
  const localRoot = context?.authenticatedLocalRootCustody ?? context?.localActionContext?.authenticatedLocalRootCustody;
  // The authenticated Machine stamp wins over any in-process inherited context.
  const candidate = admission ? { serverId, accountId: admission.actorAccountId,
    machineId: admission.machineId, installationId: admission.installationId }
    : binding ? { serverId: serverId ?? binding.serverIdentityId, accountId: binding.accountId,
      machineId: binding.machineId, installationId: binding.installationId }
    : localRoot ? { serverId: serverId ?? localRoot.serverIdentityId, accountId: localRoot.accountId,
      machineId: localRoot.machineId, installationId: localRoot.installationId }
    : context?.requesterWorkAttributionV1 ?? context?.localActionContext?.requesterWorkAttributionV1
      ?? context?.requesterSessionBootstrap?.attribution;
  const parsed = RequesterWorkAttributionV1Schema.safeParse(candidate);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}

/** Principal equality only; the caller must still verify the admission's currentness. */
export function isCustodianMachineAdmission(admission: Pick<NonNullable<RpcHandlerContext['machineAdmission']>,
  'actorAccountId' | 'custodianAccountId'>): boolean {
  return admission.actorAccountId === admission.custodianAccountId;
}

/** Read the installed Account custody recorded on admitted Machine and Action work. */
export function hasInstalledRuntimeAccountCustody(
  admission: ActionExecutorContext['machineAdmission'],
  ...authorizations: ReadonlyArray<ActionExecutorContext['externalActionExecutionAuthorization']>
): boolean {
  return (!admission || isCustodianMachineAdmission(admission))
    && authorizations.every(authorization => !authorization
      || authorization.binding.accountId === authorization.binding.custodianAccountId);
}

/** C41 owns Machine permission. This only prevents borrowing a different Account's credentials. */
export async function canUseCustodianAccountForMachineRequest(context: Pick<RpcHandlerContext,
  'machineAdmission' | 'verifyMachineAdmissionCurrent'> & Readonly<{ signal?: AbortSignal }> | undefined): Promise<boolean> {
  return (!context?.machineAdmission || isCustodianMachineAdmission(context.machineAdmission))
    && await isMachineCredentialCurrent(context);
}

async function isMachineCredentialCurrent(
  context: Parameters<typeof canUseCustodianAccountForMachineRequest>[0],
): Promise<boolean> {
  if (!context?.machineAdmission) return !context?.signal?.aborted;
  if (context.signal?.aborted || !context.verifyMachineAdmissionCurrent) return false;
  try { return await context.verifyMachineAdmissionCurrent() && !context.signal?.aborted; }
  catch { return false; }
}

/**
 * True when ingress carries requester, external, API-token, Session-scoped or
 * requester-Session authority. Credential reuse additionally distinguishes
 * original own Account custody in canUseLocalRuntimeAccount.
 */
export function carriesNonLocalRequesterAuthority(context: Readonly<{
  callerInputAuthorization?: unknown; externalActionExecutionAuthorization?: unknown; externalActionCredential?: unknown;
  sessionActionOrigin?: unknown; rpcSessionAuthorization?: unknown; requesterSessionBootstrap?: unknown;
}> | undefined): boolean {
  return context?.callerInputAuthorization !== undefined || context?.externalActionExecutionAuthorization !== undefined
    || context?.externalActionCredential !== undefined || context?.sessionActionOrigin !== undefined
    || context?.rpcSessionAuthorization !== undefined || context?.requesterSessionBootstrap !== undefined;
}

/** Only work for this runtime's own Account can borrow its local credentials. */
export async function canUseLocalRuntimeAccount(
  context: (ActionExecutorContext & Pick<RpcHandlerContext, 'callerInputAuthorization'>) | undefined,
  localAccountId: string | null,
  serverId?: string,
): Promise<boolean> {
  return localAccountId !== null && hasOriginalRuntimeAccountAuthorities(context, localAccountId)
    && await canUseAttributedRuntimeAccount(context, localAccountId, serverId);
}

function hasOriginalRuntimeAccountAuthorities(
  context: Parameters<typeof canUseLocalRuntimeAccount>[0],
  localAccountId: string,
): boolean {
  const { externalActionExecutionAuthorization, callerInputAuthorization, ...independentAuthority } = context ?? {};
  if (carriesNonLocalRequesterAuthority(independentAuthority)) return false;
  // Inspect both verified carriers without changing the context passed to work.
  // Original own custody cannot erase an independently narrowed caller scope.
  for (const authorization of [externalActionExecutionAuthorization, callerInputAuthorization]) {
    if (authorization && (!isOriginalAccountActionCustody(authorization.binding)
      || authorization.binding.accountId !== localAccountId)) return false;
  }
  return true;
}

/** Review ports can consume the Session issuer's admitted own-Account custody.
 * Bare Session transport/origin and another Account never lend local credentials. */
export async function canUseLocalRuntimeReviewAccount(
  context: (ActionExecutorContext & Pick<RpcHandlerContext, 'callerInputAuthorization'>) | undefined,
  localAccountId: string | null,
  serverId?: string,
): Promise<boolean> {
  if (context?.rpcSessionAuthorization?.authority === 'sessionOwner' && !context.sessionActionOrigin) {
    const { rpcSessionAuthorization: _owner, ...ownerContext } = context;
    // A signed Account action admitted by Home for this Session uses the
    // Session runner's credentials. Its Machine custodian can be another Account.
    if (ownerContext.callerInputAuthorization || ownerContext.externalActionExecutionAuthorization) {
      return localAccountId !== null && hasOriginalRuntimeAccountAuthorities(ownerContext, localAccountId)
        && await canUseAttributedRuntimeAccount(ownerContext, localAccountId, serverId, 'sessionOwner');
    }
    return await canUseLocalRuntimeAccount(ownerContext, localAccountId, serverId);
  }
  if (!context?.sessionActionOrigin) return await canUseLocalRuntimeAccount(context, localAccountId, serverId);
  const { externalActionExecutionAuthorization, callerInputAuthorization, sessionActionOrigin, ...independentAuthority } = context;
  if (!localAccountId || carriesNonLocalRequesterAuthority(independentAuthority)) return false;
  // The reviewed child may attach an exact-purpose HTTP view of the same
  // root. Its verified issuer proof retains the original private custody.
  const originalAuthorization = readHostReviewedChildOriginalAuthorizationV1(context) ?? externalActionExecutionAuthorization;
  const authorizations = [originalAuthorization, callerInputAuthorization].filter(authorization => authorization !== undefined);
  if (authorizations.length === 0) return false;
  for (const authorization of authorizations) {
    const custody = readRequesterAccountActionTransportContext(authorization);
    const binding = authorization.binding;
    if (custody?.authorization !== authorization
      || binding.accountId !== localAccountId
      || !('authentication' in binding)
      || binding.authentication.kind !== 'account' && binding.authentication.kind !== 'terminal'
      || binding.workflowActionOrigin
      || !sameStrictJsonValue(sessionActionOrigin, binding.sessionActionOrigin)) return false;
  }
  return await canUseAttributedRuntimeAccount(context, localAccountId, serverId);
}

async function canUseAttributedRuntimeAccount(
  context: Parameters<typeof canUseLocalRuntimeAccount>[0], localAccountId: string, serverId?: string,
  custody: 'machine' | 'sessionOwner' = 'machine',
): Promise<boolean> {
  const attributedAccountId = projectRpcRequesterWorkAttribution(context, context?.serverId ?? serverId)?.accountId
    ?? context?.runtimeAccountId;
  return (attributedAccountId === undefined || attributedAccountId === localAccountId)
    && (custody === 'sessionOwner' || hasInstalledRuntimeAccountCustody(context?.machineAdmission,
      context?.externalActionExecutionAuthorization, context?.callerInputAuthorization))
    && await isMachineCredentialCurrent(context);
}

/** Transient launch currentness supplied by the verified ingress, not by stored attribution. */
export async function isRequesterLaunchAdmissionCurrent(options: Pick<SpawnSessionOptions,
  'verifyRequesterMachineAdmissionCurrent'>): Promise<boolean> {
  if (!options.verifyRequesterMachineAdmissionCurrent) return true;
  try { return await options.verifyRequesterMachineAdmissionCurrent(); }
  catch (error) {
    rethrowRequesterHomeReadFailure(error);
    return false;
  }
}

/** One spawn-result projection for every fresh requester admission checkpoint. */
export async function resolveRequesterLaunchAdmissionFailure(options: Pick<SpawnSessionOptions,
  'verifyRequesterMachineAdmissionCurrent'>): Promise<Extract<SpawnSessionResult, { type: 'error' }> | null> {
  const refusal = projectDaemonSpawnUnavailable('requester_machine_admission_unavailable', 'Requester Machine admission unavailable');
  try { return await isRequesterLaunchAdmissionCurrent(options) ? null : refusal; }
  catch (error) {
    if (!isPluginError(error) || error.code !== 'project_requester_home_unavailable' || error.retryable !== true) return refusal;
    return { ...refusal, errorMessage: 'Requester Home is temporarily unavailable',
      errorDetail: { kind: 'requester_home_unavailable' } };
  }
}
