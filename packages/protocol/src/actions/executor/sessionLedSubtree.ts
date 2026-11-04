import { parseSessionListQueryActionResultV1, type SessionListQueryActionResultV1 } from '../../sessions/awareness/action.js';
import { SESSION_LIST_PAGE_MAX_LIMIT, type SessionListQueryV1 } from '../../sessions/listing/query.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { resolveActionAgentStartContextV1 } from './agentStartAdmission.js';

/** Reads server-proved membership; relation structure and ordinary access stay server-owned. */
export async function readActionCallerLedSubtreeSessionIds(
  deps: Pick<ActionExecutorDeps, 'sessionList'> & Partial<Pick<ActionExecutorDeps, 'resolveAgentStartContext'>>,
  context: ActionExecutorContext,
  requestedRootSessionId?: string,
): Promise<ReadonlySet<string> | null> {
  const sessions = await readActionCallerLedSubtreeSessions(deps, context, requestedRootSessionId);
  return sessions ? new Set(sessions.keys()) : null;
}

/** Retains the same server-proved rows for reference and manager projections. */
export async function readActionCallerLedSubtreeSessions(
  deps: Pick<ActionExecutorDeps, 'sessionList'> & Partial<Pick<ActionExecutorDeps, 'resolveAgentStartContext'>>,
  context: ActionExecutorContext,
  requestedRootSessionId?: string,
): Promise<ReadonlyMap<string, SessionListQueryActionResultV1['sessions'][number]> | null> {
  const root = (requestedRootSessionId ?? context.defaultSessionId)?.trim();
  if (!root || context.sessionListAccess === 'unavailable') return null;
  if (context.sessionListAccess === 'current_session') {
    // A contextual default is not a caller witness. Resolve identity without a
    // target so READ proof does not expand the separate START corpus.
    const caller = await resolveActionAgentStartContextV1(deps, context, undefined, { purpose: 'session_scope' });
    if (root !== context.defaultSessionId?.trim()
      || caller?.caller.kind !== 'session' || caller.caller.sessionId !== root) return null;
  }
  // This is the receiving Session owner's policy observation, not a delegated
  // HTTP effect of the Run. Its Account reader proves current relations; it
  // cannot sign as the original Run executor. Keep the signed caller proof on
  // the mutation context, but do not borrow its signer for this private read.
  const readContext = context.actionCaller?.kind === 'workflowRun'
    && context.externalActionExecutionAuthorization?.binding.workflowActionOrigin?.sessionAuthority
    ? { ...context, externalActionExecutionAuthorization: undefined }
    : context;
  const sessionList = deps.sessionList;
  if (!sessionList) return null;
  // Storage partitions are independent Home reads. Preserve pagination within
  // each partition and require both to complete before admitting membership.
  const partitions = await Promise.all((['active', 'archived'] as const).map(async storage => {
    const sessions = new Map<string, SessionListQueryActionResultV1['sessions'][number]>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query: SessionListQueryV1 = {
        v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any',
        audiences: [], tagIds: [], underSessionId: root, limit: SESSION_LIST_PAGE_MAX_LIMIT, includeAttention: false,
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
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) return null;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    } while (true);
    return sessions;
  }));
  if (partitions.some(ids => ids === null) || context.signal?.aborted) return null;
  return new Map(partitions.flatMap(sessions => sessions ? [...sessions] : []));
}
