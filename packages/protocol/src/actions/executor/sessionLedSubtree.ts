import { parseSessionListQueryActionResultV1, type SessionListQueryActionResultV1 } from '../../sessions/awareness/action.js';
import { SESSION_LIST_PAGE_MAX_LIMIT, type SessionListQueryV1 } from '../../sessions/listing/query.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { resolveActionAgentStartContextV1 } from './agentStartAdmission.js';
import { SessionReadBatchResponseV1Schema } from '../../sessions/read/sessionReadBatchV1.js';

/** Reads server-proved membership; relation structure and ordinary access stay server-owned. */
export async function readActionCallerLedSubtreeSessionIds(
  deps: Partial<Pick<ActionExecutorDeps, 'sessionList' | 'resolveAgentStartContext' | 'sessionRead'>>,
  context: ActionExecutorContext,
  requestedRootSessionId?: string,
  requestedSessionIds?: readonly string[],
): Promise<ReadonlySet<string> | null> {
  const sessions = await readActionCallerLedSubtreeSessions(deps, context, requestedRootSessionId, requestedSessionIds);
  return sessions ? new Set(sessions.keys()) : null;
}

/** Retains the same server-proved rows for reference and manager projections. */
export async function readActionCallerLedSubtreeSessions(
  deps: Partial<Pick<ActionExecutorDeps, 'sessionList' | 'resolveAgentStartContext' | 'sessionRead'>>,
  context: ActionExecutorContext,
  requestedRootSessionId?: string,
  requestedSessionIds?: readonly string[],
): Promise<ReadonlyMap<string, SessionListQueryActionResultV1['sessions'][number]> | null> {
  const root = (requestedRootSessionId ?? context.defaultSessionId)?.trim();
  if (!root || context.sessionListAccess === 'unavailable' || context.signal?.aborted) return null;
  if (context.sessionListAccess === 'current_session') {
    // A contextual default is not a caller witness. Resolve identity without a
    // target so READ proof does not expand the separate START corpus.
    const caller = await resolveActionAgentStartContextV1(deps, context, undefined, { purpose: 'session_scope' });
    if (root !== context.defaultSessionId?.trim()
      || !caller || 'ok' in caller || caller.caller.kind !== 'session' || caller.caller.sessionId !== root) return null;
  }
  // This is the receiving Session owner's policy observation, not a delegated
  // HTTP effect of the Run. Its Account reader proves current relations; it
  // cannot sign as the original Run executor. Keep the signed caller proof on
  // the mutation context, but do not borrow its signer for this private read.
  const readContext = context.actionCaller?.kind === 'workflowRun'
    && context.externalActionExecutionAuthorization?.binding.workflowActionOrigin?.sessionAuthority
    ? { ...context, externalActionExecutionAuthorization: undefined }
    : context;
  if (requestedSessionIds !== undefined) {
    if (!deps.sessionRead) return null;
    const expected = new Set(requestedSessionIds);
    const sessions = new Map<string, SessionListQueryActionResultV1['sessions'][number]>();
    if (!expected.size) return sessions;
    try {
      const result = SessionReadBatchResponseV1Schema.safeParse(await deps.sessionRead({
        context: readContext, sessionIds: [...expected], underSessionId: root,
        ...(context.serverId !== undefined ? { serverId: context.serverId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
      if (!result.success || context.signal?.aborted) return null;
      for (const part of result.data.results) {
        if (!expected.delete(part.sessionId) || !part.detail) return null;
        if (part.detail.status === 404) continue;
        if (part.detail.status !== 200 || part.detail.body.session.id !== part.sessionId) return null;
        const row = part.detail.body.session;
        sessions.set(row.id, { id: row.id, active: row.active, presence: null,
          updatedAt: row.updatedAt, ...(row.manager ? { manager: row.manager } : {}) });
      }
      return expected.size ? null : sessions;
    } catch { return null; }
  }
  const sessionList = deps.sessionList;
  if (!sessionList) return null;
  // Storage partitions are independent Home reads. Preserve pagination within
  // each partition and require both to complete before admitting membership.
  const partitions = await Promise.all((['active', 'archived'] as const).map(async storage => {
    const sessions = new Map<string, SessionListQueryActionResultV1['sessions'][number]>();
    let cursor: string | undefined;
    do {
      const query: SessionListQueryV1 = {
        v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any',
        audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, underSessionId: root, limit: SESSION_LIST_PAGE_MAX_LIMIT, includeAttention: false,
        ...(cursor ? { cursor } : {}),
      };
      let result: ReturnType<typeof parseSessionListQueryActionResultV1>;
      try {
        result = parseSessionListQueryActionResultV1(await sessionList({
          context: readContext, query, includeSystem: true,
          ...(context.serverId !== undefined ? { serverId: context.serverId } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        }));
      } catch {
        return null;
      }
      if (!result || result.hasNext === undefined || result.metadataUpgradeRequiredCount
        || result.botFilterUnavailableCount || result.attentionHasNext) return null;
      for (const session of result.sessions) {
        const id: unknown = 'id' in session ? session.id : 'sessionId' in session ? session.sessionId : undefined;
        if (typeof id === 'string') sessions.set(id, session);
      }
      if (!result.hasNext) break;
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    } while (true);
    return sessions;
  }));
  if (partitions.some(ids => ids === null) || context.signal?.aborted) return null;
  return new Map(partitions.flatMap(sessions => sessions ? [...sessions] : []));
}
