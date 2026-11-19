import { SESSION_INPUT_HANDOFF_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import { projectActionExecuteFailure, type ActionExecuteResult } from '../../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import { completeActionResult } from '../resultProjection.js';
import { resolveActionSessionAddress, resolveActionSessionTargets } from '../sessionTargets.js';
import { projectSessionReferenceFailure } from '../sessionScope.js';
import { runSessionInputHandoffV1, resolveSessionInputHandoffSelectionV1,
  type SessionInputHandoffEffectV1 } from '../../../sessions/messages/runSessionInputHandoffV1.js';
import type { SessionInputHandoffInputV1 } from '../../../sessions/messages/sessionInputHandoffV1.js';
import type { ActionSessionAddressV1 } from '../../sessionAddressV1.js';

/** The Session owner orchestrates ordinary child Actions; it never inherits their consent. */
export async function executeSessionInputHandoffV1(args: Readonly<{
  input: SessionInputHandoffInputV1;
  context: ActionExecutorContext;
  deps: ActionExecutorDeps;
  executeChild(actionId: ActionId, input: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
  const { input, context, deps } = args;
  const compose = deps.sessionInputHandoffCompose;
  const selected = resolveSessionInputHandoffSelectionV1(input);
  let resolvedSession: ActionSessionAddressV1 | undefined;
  if (selected.destination?.kind === 'existing') {
    const sessionId = selected.destination.session;
    const resolved = await resolveActionSessionTargets(deps, {
      actionId: SESSION_INPUT_HANDOFF_ACTION_ID_V1, input: { sessionId },
      declaration: { field: 'sessionId', cardinality: 'one' }, context,
    });
    if (resolved && 'ok' in resolved) return resolved;
    if (resolved) resolvedSession = resolved.targets[0];
    else {
      const address = await resolveActionSessionAddress(deps, { sessionId }, context, SESSION_INPUT_HANDOFF_ACTION_ID_V1);
      if (address.kind !== 'unique') return projectSessionReferenceFailure(address);
      resolvedSession = address.address;
    }
  }
  // Existing child request identities are bounded and stable for this authored intent.
  // They also keep a retried create/send on the native owners' dedupe path.
  const childContext = { ...context, actionRequestId: input.idempotencyKey };
  const child = async <T>(actionId: ActionId, value: unknown, serverId?: string): Promise<SessionInputHandoffEffectV1<T>> => {
    const result = await args.executeChild(actionId, value, { ...childContext, ...(serverId ? { serverId } : {}) });
    if (!result.ok) return projectActionExecuteFailure(result);
    // Native Action outputs have already been validated by their canonical owner.
    return result as SessionInputHandoffEffectV1<T>;
  };
  return completeActionResult(await runSessionInputHandoffV1(input, {
    send: ({ session, input: content, idempotencyKey }) => child('session.message.send', {
      sessionId: session.sessionId, message: content.text,
      ...(context.actionCaller?.kind === 'plugin' ? { idempotencyKey } : {}),
      ...(content.attachments?.length ? { attachments: content.attachments } : {}),
      ...(content.forgeEvidence ? { forgeEvidence: content.forgeEvidence } : {}),
    }, session.serverId),
    spawn: value => child('session.spawn_new', value),
    author: (seed, content) => child('session.authoring.open', { seed: {
      ...seed, prompt: content.text,
      ...(content.attachments?.length ? { attachments: content.attachments } : {}),
      ...(content.forgeEvidence ? { forgeEvidence: content.forgeEvidence } : {}),
    } }),
    ...(compose ? { compose: async (session, content) => ({ ok: true as const,
      result: await compose({ session, input: content, context }),
    }) } : {}),
  }, { ...(resolvedSession ? { resolvedSession } : {}), ...(context.signal ? { signal: context.signal } : {}) }));
}
