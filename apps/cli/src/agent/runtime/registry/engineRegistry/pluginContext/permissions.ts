import type {
    SessionPermissionDecisionResultV1,
    SessionPermissionDecisionV1,
    SessionPermissionFollowUpPromptIntentV1,
    SessionPermissionPersistAllowRuleV1,
} from '@happier-dev/plugin-sdk';
import { isRecord } from './values';

function normalizeSessionPermissionFollowUpPrompt(
    value: unknown,
): SessionPermissionFollowUpPromptIntentV1 | undefined {
    if (!isRecord(value) || typeof value.prompt !== 'string') {
        return undefined;
    }
    const delivery = value.delivery;
    if (delivery !== 'nextTurn' && delivery !== 'followUp') {
        return undefined;
    }
    return {
        prompt: value.prompt,
        delivery,
    };
}

function normalizeSessionPermissionPersistAllowRule(
    value: unknown,
): SessionPermissionPersistAllowRuleV1 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const scope = value.scope;
    if (scope !== 'session' && scope !== 'workspace' && scope !== 'account') {
        return undefined;
    }
    const toolName = value.toolName;
    return {
        scope,
        ...(typeof toolName === 'string' ? { toolName } : {}),
    };
}

export function normalizeSessionPermissionDecisionResult(value: unknown): SessionPermissionDecisionResultV1 {
    const decision = isRecord(value) && typeof value.decision === 'string'
        ? value.decision
        : 'denied';
    if (
        decision === 'approved'
        || decision === 'approved_for_session'
        || decision === 'approved_execpolicy_amendment'
        || decision === 'denied'
        || decision === 'abort'
    ) {
        const result: {
            decision: SessionPermissionDecisionV1;
            rationale?: string;
            answers?: Readonly<Record<string, string>>;
            followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
            persistAllowRule?: SessionPermissionPersistAllowRuleV1;
            updatedInput?: Readonly<Record<string, unknown>>;
            updatedPermissions?: readonly Readonly<Record<string, unknown>>[];
        } = { decision };
        if (typeof value === 'object' && value && 'rationale' in value) {
            const rationale = (value as Readonly<Record<string, unknown>>).rationale;
            if (typeof rationale === 'string') {
                result.rationale = rationale;
            }
        }
        if (isRecord(value)) {
            const answers = value.answers;
            if (isRecord(answers)) {
                const normalizedAnswers: Record<string, string> = {};
                for (const [question, answer] of Object.entries(answers)) {
                    if (question && typeof answer === 'string') {
                        normalizedAnswers[question] = answer;
                    }
                }
                if (Object.keys(normalizedAnswers).length > 0) {
                    result.answers = normalizedAnswers;
                }
            }
            const followUpPrompt = normalizeSessionPermissionFollowUpPrompt(value.followUpPrompt);
            if (followUpPrompt) {
                result.followUpPrompt = followUpPrompt;
            }
            const persistAllowRule = normalizeSessionPermissionPersistAllowRule(value.persistAllowRule);
            if (persistAllowRule) {
                result.persistAllowRule = persistAllowRule;
            }
            const updatedInput = value.updatedInput;
            if (isRecord(updatedInput)) {
                result.updatedInput = updatedInput;
            }
            const updatedPermissions = value.updatedPermissions;
            if (Array.isArray(updatedPermissions)) {
                const normalizedUpdates = updatedPermissions.filter(isRecord);
                if (normalizedUpdates.length > 0) {
                    result.updatedPermissions = normalizedUpdates;
                }
            }
        }
        return result;
    }
    return { decision: 'denied' };
}
