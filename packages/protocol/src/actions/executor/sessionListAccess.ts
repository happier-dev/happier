import type { ActionId } from '../actionIds.js';
import { getActionSpec, type ActionSpec } from '../actionSpecs.js';
import { isSessionStateFieldActionId } from '../sessionStateFieldActions.js';
import type { ActionContextualDefaults } from '../contextualDefaults.js';
import { resolveActionAgentStartContextV1 } from './agentStartAdmission.js';
import { readActionCallerLedSubtreeSessionIds, readActionCallerLedSubtreeSessions } from './sessionLedSubtree.js';
import { readSessionManagerSessionIdV1 } from '../../sessions/follow/sessionManagerV1.js';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { AgentStartContextV1 } from '../../account/settings/admitAgentStartV1.js';
import { isWorkflowSessionScopeTargetV1 } from '../../workflows/workflowSessionScopeV1.js';
import { resolveActionWorkflowSessionScopeV1 } from './workflowSessionScope.js';
import { areServerProfileIdentifiersEquivalent } from '../../features/payload/capabilities/serverIdentityCapabilities.js';

/** Content-free causes owned by the current-Session scope guard, never authority. */
export const ActionCurrentSessionScopeFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  cause: z.enum(['default_session_unavailable', 'current_session_only', 'session_scope_unavailable',
    'action_scope_restricted', 'caller_context_unavailable', 'caller_identity_mismatch',
    'subtree_observation_unavailable', 'target_outside_led_subtree']),
  retryable: z.optional(z.literal(true)),
}));
export type ActionCurrentSessionScopeFailureDetailsV1 = Readonly<z.infer<typeof ActionCurrentSessionScopeFailureDetailsV1Schema>>;

export function isAutonomousSessionListSurface(surface: unknown): boolean {
  return surface === 'agent' || surface === 'mcp' || surface === 'plugin';
}

/** Lifecycle Actions that share the caller's server-proved led-Session corpus. */
export function isLedSubtreeSessionLifecycleActionId(actionId: string): actionId is 'session.stop' | 'session.archive' | 'session.unarchive' {
  return actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive';
}

/**
 * A plugin surface is a presentation, not an origin.
 *
 * The mounted dispatcher stamps list-only read scope while retaining the
 * plugin's automation authority. Autonomous plugin Actions do not inherit this
 * scope and stay bound to their host-admitted current-Session corpus.
 */
function hasMountedUiPluginOrigin(context: ActionExecutorContext | undefined): boolean {
  if (context?.surface !== 'plugin' || context.sessionListAccess !== 'mounted_ui') return false;
  const caller = context.actionCaller;
  return caller?.kind === 'plugin'
    && (caller.contributionLocalId?.trim() ?? '').length > 0;
}

/** Shared admission for hosts that cannot supply an authorized Session-list corpus. */
export function resolveActionSessionListAccessFailure(
  actionId: ActionId,
  context: ActionExecutorContext | undefined,
): ActionExecuteFailure | null {
  if (actionId !== 'session.list') return null;
  if (!isAutonomousSessionListSurface(context?.surface)) return null;
  if (hasMountedUiPluginOrigin(context)) return null;

  const defaultSessionId = context?.defaultSessionId?.trim() ?? '';
  return context?.sessionListAccess !== 'unavailable'
    && defaultSessionId.length > 0
    && (context?.sessionListAccess === 'current_session'
      || context?.sessionListAccess === 'led_subtree'
      || context?.surface === 'agent')
    ? null
    : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
}

/**
 * Enforces the host's admitted current-Session corpus for Action declarations
 * whose `sessionId` is contextually bound to that Session. Contextual defaults
 * remain a convenience for unconstrained human/API callers. The Agent surface
 * is intrinsically bound to its current Session; other autonomous surfaces use
 * the host-only `sessionListAccess` fact to declare the same restricted corpus.
 * Reads, registered Session field setters and stop/archive/unarchive use the
 * same host Session caller and server-proved led subtree as start admission.
 * Headless Resume additionally requires the caller to be the target's direct manager.
 * Other mutations remain current-Session-only. A Workflow caller additionally
 * admits its accepted typed reviewSession after a fresh exact access check.
 */
export async function resolveActionCurrentSessionScopeFailure(
  actionId: ActionId,
  input: unknown,
  context: ActionExecutorContext | undefined,
  contextualDefaults: ActionContextualDefaults | undefined,
  deps: Pick<ActionExecutorDeps, 'resolveAgentStartContext' | 'sessionList' | 'workflowAction' | 'resolveSessionReference' | 'resolveServerProfileScopeId'>,
  retainCallerContext?: (resolved: AgentStartContextV1) => void,
  /** Dispatch wrappers supply the resolved Action's current effect facts. */
  scopeSideEffectClass?: ActionSpec['sideEffectClass'],
): Promise<ActionExecuteFailure | null> {
  if (contextualDefaults?.sessionId !== 'current_session') return null;
  // Agent-originated cross-Session message delivery is authorized by the
  // Message Action owner, which requires a host-stamped active-turn source and
  // causal permission authority. Do not preempt that stronger domain check
  // with the generic contextual-default guard. External MCP/plugin surfaces
  // remain bound when their host declares current-Session-only list access.
  if (actionId === 'session.message.send' && context?.surface === 'agent') return null;
  if (!isAutonomousSessionListSurface(context?.surface)) return null;
  if (context?.surface !== 'agent'
    && context?.sessionListAccess !== 'current_session'
    && context?.sessionListAccess !== 'led_subtree'
    && context?.sessionListAccess !== 'unavailable') return null;

  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const inputRecord = input as Readonly<Record<string, unknown>>;
  const ledLifecycleAction = isLedSubtreeSessionLifecycleActionId(actionId);
  // Headless Resume follows the direct-manager policy, not the led-subtree lifecycle scope:
  // only the Session's own manager may reach the native launch, which rechecks that relation.
  const headlessResume = actionId === 'session.open' && inputRecord.intent === 'resume'
    && !Object.hasOwn(inputRecord, 'destination') && !Object.hasOwn(inputRecord, 'tabId');
  if (!Object.prototype.hasOwnProperty.call(inputRecord, 'sessionId')) return null;
  if (typeof inputRecord.sessionId !== 'string') return null;

  const defaultSessionId = context.defaultSessionId?.trim() ?? '';
  const refuse = (cause: ActionCurrentSessionScopeFailureDetailsV1['cause']): ActionExecuteFailure => ({
    ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}`, details: { cause },
  });
  const targetSessionId = inputRecord.sessionId.trim();
  if (targetSessionId === defaultSessionId && defaultSessionId) {
    // Own-Session scope needs no subtree lookup, but Stop still classifies
    // the verified author, including when Archive delegates an active Stop.
    if (ledLifecycleAction && context.actionCaller?.kind === 'session') {
      const resolved = await resolveActionAgentStartContextV1(deps, context, undefined, { purpose: 'session_scope' });
      if (resolved?.caller.kind === 'session' && resolved.caller.sessionId === defaultSessionId) retainCallerContext?.(resolved);
    }
    return null;
  }
  if (context.actionCaller?.kind === 'workflowRun') {
    // Accepted admission witnesses and the exact invocation frame own this
    // corpus. A typed field alone, including one in a sibling, grants nothing.
    const scope = await resolveActionWorkflowSessionScopeV1(actionId, context, deps);
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if (!scope) return refuse('session_scope_unavailable');
    if (!isWorkflowSessionScopeTargetV1({ scope, sessionId: targetSessionId })) return refuse('action_scope_restricted');
    if (typeof inputRecord.serverId === 'string') {
      const requestedServerId = inputRecord.serverId;
      const sameHome = (left: string, right: string | null | undefined) => areServerProfileIdentifiersEquivalent(left, right,
        identifier => identifier === context.serverId && context.serverIdentityId ? context.serverIdentityId
          : identifier === context.serverIdentityId ? context.serverIdentityId : deps.resolveServerProfileScopeId?.(identifier));
      if (!scope.sessions.some(address => address.sessionId === targetSessionId && sameHome(requestedServerId, address.serverId))) {
        return refuse('action_scope_restricted');
      }
    }
    return null;
  }
  // Compact's contextual safety admission owns own-versus-other approval.
  // A current-Session default is selection, not a restriction on this control.
  if (actionId === 'session.compact' && context.surface === 'agent') return null;
  if (!defaultSessionId) {
    return refuse('default_session_unavailable');
  }

  const sideEffectClass = scopeSideEffectClass ?? getActionSpec(actionId).sideEffectClass;
  if (context.sessionListAccess === 'current_session' && sideEffectClass !== 'read') {
    return refuse('current_session_only');
  }
  if (context.sessionListAccess === 'unavailable') return refuse('session_scope_unavailable');
  if (sideEffectClass !== 'read' && !isSessionStateFieldActionId(actionId)
    && !ledLifecycleAction && !headlessResume) {
    return refuse('action_scope_restricted');
  }
  const resolved = await resolveActionAgentStartContextV1(deps, context, undefined, { purpose: 'session_scope' });
  if (!resolved) return refuse('caller_context_unavailable');
  if (resolved.caller.kind !== 'session' || resolved.caller.sessionId !== defaultSessionId) {
    return refuse('caller_identity_mismatch');
  }
  // Retain identity facts only within the execution owner's current invocation.
  // The Home membership observation below still runs at every effect fence.
  if (ledLifecycleAction) retainCallerContext?.(resolved);
  if (headlessResume) {
    const rows = await readActionCallerLedSubtreeSessions(deps, context);
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const row = rows?.get(targetSessionId);
    if (!rows) return refuse('subtree_observation_unavailable');
    return row && 'manager' in row && readSessionManagerSessionIdV1(row) === defaultSessionId
      ? null : refuse('action_scope_restricted');
  }
  // Observe membership through the same canonical reader used by start
  // admission, retaining failure separately from a successful empty subtree.
  const ids = await readActionCallerLedSubtreeSessionIds(deps, context);
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  if (!ids) return ledLifecycleAction
    ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { cause: 'subtree_observation_unavailable', retryable: true } }
    : refuse('subtree_observation_unavailable');
  return ids.has(targetSessionId) ? null : refuse('target_outside_led_subtree');
}
