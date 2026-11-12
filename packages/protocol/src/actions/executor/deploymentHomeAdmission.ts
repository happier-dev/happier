import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import { isRecord } from '../../common/records.js';

/** Uses the invocation's admitted profile/portable relationship, never the active Home. */
export function normalizeAdmittedHomeServerIdV1(serverId: string, context: Pick<ActionExecutorContext, 'serverId' | 'serverIdentityId'>): string {
  const id = serverId.trim();
  return id === context.serverId?.trim() ? context.serverIdentityId?.trim() || id : id;
}

/** Runs at target admission, before preparation, review, digests and signing. */
export function admitDeploymentHomeInputV1(input: unknown, context: ActionExecutorContext,
  resolveScopeId: ActionExecutorDeps['resolveServerProfileScopeId']): Readonly<{ input: unknown }> | ActionExecuteFailure {
  if (!isRecord(input) || !context.serverId)
    return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
  const localProfileId = context.serverId.trim();
  const serverIdentityId = context.serverIdentityId?.trim()
    || (resolveScopeId ? resolveScopeId(localProfileId)?.trim() : localProfileId);
  if (!serverIdentityId) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
  const normalize = (id: string) => normalizeAdmittedHomeServerIdV1(id, { serverId: localProfileId, serverIdentityId });
  const belongs = (id: unknown) => typeof id === 'string'
    && (context.externalActionExecutionAuthorization
      ? id === serverIdentityId
      : normalize(id) === serverIdentityId || resolveScopeId?.(id.trim()) === serverIdentityId);
  if ('serverId' in input && !belongs(input.serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
  const result: Record<string, unknown> = { ...input, ...('serverId' in input ? { serverId: serverIdentityId } : {}) };
  // Normalize declared workspace addresses, never arbitrary user configuration.
  if (isRecord(result.workspace) && 'serverId' in result.workspace) {
    if (!belongs(result.workspace.serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    result.workspace = { ...result.workspace, serverId: serverIdentityId };
  }
  if (isRecord(result.destination) && isRecord(result.destination.workspace)) {
    if (!belongs(result.destination.workspace.serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    result.destination = { ...result.destination, workspace: { ...result.destination.workspace, serverId: serverIdentityId } };
  }
  return { input: result };
}
