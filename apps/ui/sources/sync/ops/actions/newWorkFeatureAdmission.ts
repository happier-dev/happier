import { getActionNewWorkFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { resolveRuntimeFeatureDecision } from '@/sync/domains/features/featureDecisionInputs';

/** Account and Home opt-outs are consumed once before a new UI admission. */
export async function readNewWorkFeatureAdmission(actionId: string, input: unknown, context: ActionExecutorContext,
    serverId: string | undefined, readSettings: () => FeatureLocalPolicySettings | Promise<FeatureLocalPolicySettings>) {
    const featureId = getActionNewWorkFeatureId(actionId, context, input);
    if (featureId === null) return null;
    const settings = await readSettings();
    const featureDecision = await resolveRuntimeFeatureDecision({ featureId, settings, serverId });
    return featureDecision.state === 'enabled'
        ? null : { ok: false as const, errorCode: 'action_disabled', error: 'action_disabled', details: { featureDecision } };
}
