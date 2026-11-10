import {
    NativePermissionChoiceAnswerV1Schema,
    NativePermissionChoicesV1Schema,
    type NativePermissionChoicesV1,
} from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { PermissionResult } from './BasePermissionHandler';
import { deepEqual } from '@/utils/deterministicJson';

/** Omitted fields in a native observation are unobserved, never an invented vendor answer. */
export function observedPermissionResultMatches(accepted: unknown, observed: unknown): boolean {
    if (!accepted || !observed || typeof accepted !== 'object' || typeof observed !== 'object'
        || Array.isArray(accepted) || Array.isArray(observed)) return deepEqual(accepted, observed);
    return Object.entries(observed).every(([key, value]) => deepEqual(Reflect.get(accepted, key), value));
}

/** Preserve the canonical vendor decision payload without the transport's approved/id fields. */
export function nativePermissionResult(response: PermissionResult): PermissionResult {
    return {
        decision: response.decision,
        ...(response.nativeChoice !== undefined ? { nativeChoice: response.nativeChoice } : {}),
        ...(response.mode !== undefined ? { mode: response.mode } : {}),
        ...(response.allowedTools !== undefined ? { allowedTools: response.allowedTools } : {}),
        ...(response.updatedPermissions !== undefined ? { updatedPermissions: response.updatedPermissions } : {}),
        ...(response.execPolicyAmendment !== undefined ? { execPolicyAmendment: response.execPolicyAmendment } : {}),
    };
}

/** Select only the exact current native offer; caller authority and application stay with the handler. */
export function resolveNativePermissionChoice(offeredValue: unknown, answerValue: unknown) {
    const offered = NativePermissionChoicesV1Schema.safeParse(offeredValue);
    const answer = NativePermissionChoiceAnswerV1Schema.safeParse(answerValue);
    if (!offered.success || !answer.success || offered.data.requirementId !== answer.data.requirementId) return null;
    const choice = offered.data.choices.find(candidate => candidate.id === answer.data.choiceId);
    if (!choice || (answer.data.feedback !== undefined && choice.allowsFeedback !== true)) return null;
    const result = nativePermissionResult({ ...choice.response, decision: choice.decision, nativeChoice: answer.data });
    return { choice, answer: answer.data, result, response: {
        ...choice.response,
        approved: choice.decision !== 'denied' && choice.decision !== 'abort',
        decision: choice.decision,
        nativeChoice: answer.data,
    } };
}

/** Native approval requires a selection from its offer even when host policy allows the tool. */
export function resolveNativePermissionImmediateDecision<T extends Readonly<{ decision: string }>>(
    decision: T | null,
    nativeChoices: NativePermissionChoicesV1 | undefined,
): T | null {
    return nativeChoices && decision?.decision !== 'denied' && decision?.decision !== 'abort' ? null : decision;
}
