import type { ActionId } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { isSessionStateFieldActionId } from '../sessionStateFieldActions.js';
import type { ActionContextualDefaults } from '../contextualDefaults.js';
import { resolveActionAgentStartContextV1 } from './agentStartAdmission.js';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from './types.js';

export function isAutonomousSessionListSurface(surface: unknown): boolean {
  return surface === 'agent' || surface === 'mcp' || surface === 'plugin';
}

/**
 * A plugin surface is a presentation, not an origin.
 *
 * The host stamps the origin it observed: a plugin surface mounted in front of
 * the person, driven by that person, carries present-user authority plus the
 * mounted plugin caller. Such an invocation is the person reading their own
 * list through a trusted plugin, so it reads the corpus a `ui` caller reads.
 * A plugin invoked autonomously (no present user, or no mounted contribution)
 * carries neither fact and stays bound to its declared current-Session corpus.
 */
function hasPresentUserPluginOrigin(context: ActionExecutorContext | undefined): boolean {
  if (context?.surface !== 'plugin' || context.authority !== 'present_user') return false;
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
  if (hasPresentUserPluginOrigin(context)) return null;

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
 * Read Actions and registered Session field setters may use the same host
 * Session caller and server-proved led subtree as start admission. Other
 * mutations remain current-Session-only.
 */
export async function resolveActionCurrentSessionScopeFailure(
  actionId: ActionId,
  input: unknown,
  context: ActionExecutorContext | undefined,
  contextualDefaults: ActionContextualDefaults | undefined,
  deps: Pick<ActionExecutorDeps, 'resolveAgentStartContext' | 'sessionList'>,
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
  if (!Object.prototype.hasOwnProperty.call(inputRecord, 'sessionId')) return null;
  if (typeof inputRecord.sessionId !== 'string') return null;

  const defaultSessionId = context.defaultSessionId?.trim() ?? '';
  if (!defaultSessionId) {
    return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
  }

  const targetSessionId = inputRecord.sessionId.trim();
  if (targetSessionId === defaultSessionId) return null;
  if (context.sessionListAccess !== 'current_session'
    && context.sessionListAccess !== 'unavailable'
    && (getActionSpec(actionId).sideEffectClass === 'read' || isSessionStateFieldActionId(actionId))) {
    const resolved = await resolveActionAgentStartContextV1(deps, context, targetSessionId);
    if (resolved?.caller.kind === 'session'
      && resolved.caller.sessionId === defaultSessionId
      && resolved.ledSubtreeSessionIds.includes(targetSessionId)) return null;
  }
  return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
}
