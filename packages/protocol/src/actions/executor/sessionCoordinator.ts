import type { ActionId } from '../actionIds.js';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '../actionExecutionResult.js';
import type { FollowRuleSetActionOutputV1 } from '../../sessions/follow/actions.js';
import { SessionCoordinatorEnableInputV1Schema, type SessionCoordinatorEnableInputV1,
  type SessionCoordinatorEnableResultV1, type SessionCoordinatorEffectV1 } from '../../sessions/follow/sessionCoordinatorActionsV1.js';

type ChildAction = (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;

/** No transaction or coordinator record: each existing owner reports its actual accepted effect. */
export async function executeSessionCoordinatorEnableV1(
  input: SessionCoordinatorEnableInputV1, child: ChildAction, signal?: AbortSignal,
): Promise<SessionCoordinatorEnableResultV1> {
  const request = SessionCoordinatorEnableInputV1Schema.parse(input);
  const effects: SessionCoordinatorEffectV1[] = [];
  const perform = async (operation: SessionCoordinatorEffectV1['operation'], actionId: ActionId,
    value: unknown, ruleId?: string): Promise<SessionCoordinatorEffectV1> => {
    const identity = { operation, ...(ruleId === undefined ? {} : { ruleId }) };
    let effect: SessionCoordinatorEffectV1;
    if (signal?.aborted) effect = { ...identity, status: 'not_attempted', errorCode: 'cancelled' };
    else {
      try {
        const result = await child(actionId, value);
        if (!result.ok) effect = { ...identity, status: 'failed', errorCode: result.errorCode };
        else {
          const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
          if (approval.success) effect = { ...identity, status: 'approval_required', approval: approval.data };
          else if (operation === 'rule') {
            // The child executor already validates the rule response and its target.
            const output = result.result as FollowRuleSetActionOutputV1;
            effect = { ...identity, status: 'accepted', version: output.rule.version };
          } else effect = { ...identity, status: 'accepted' };
        }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        effect = { ...identity, status: 'failed', errorCode: signal?.aborted ? 'cancelled' : code ?? 'action_failed' };
      }
    }
    effects.push(effect);
    return effect;
  };
  await perform('role', 'session.role.set', { sessionId: request.sessionId, roleId: request.roleId,
    ...(request.answersWorkerQuestions === undefined ? {} : { answersWorkerQuestions: request.answersWorkerQuestions }) });
  if (request.keep === 'list_pin') await perform('pin', 'session.organization.pin.set', {
    sessionId: request.sessionId, pinned: true, surface: 'list',
  });
  if (request.managedBy) await perform('manager', 'session.manager.set', { sessionId: request.sessionId, ...request.managedBy });
  for (const suggestion of request.ruleSuggestions) await perform('rule', 'follow.set', {
    ...suggestion, receiver: { kind: 'session', sessionId: request.sessionId }, policy: { preset: 'important' },
  }, suggestion.source.ruleId);
  return { sessionId: request.sessionId, status: effects.every(effect => effect.status === 'accepted') ? 'configured' : 'partial', effects };
}
