import {
    NativePermissionChoiceAnswerV1Schema,
    NativePermissionChoicesV1Schema,
    type NativePermissionChoicesV1,
} from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { PermissionResult } from './BasePermissionHandler';
import type { HappierActionPermissionDecision } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import { deepEqual } from '@/utils/deterministicJson';

/** Omitted fields in a native observation are unobserved, never an invented vendor answer. */
export function observedPermissionResultMatches(accepted: unknown, observed: unknown): boolean {
    if (!accepted || !observed || typeof accepted !== 'object' || typeof observed !== 'object'
        || Array.isArray(accepted) || Array.isArray(observed)) return deepEqual(accepted, observed);
    return Object.entries(observed).every(([key, value]) => {
        const acceptedValue = Reflect.get(accepted, key);
        // Native observations report the disposition, not the host's accepted
        // persistence scope. The acknowledged choice retains that scope.
        if (key === 'decision' && value === 'approved'
            && (acceptedValue === 'approved_for_session' || acceptedValue === 'approved_execpolicy_amendment')) return true;
        return deepEqual(acceptedValue, value);
    });
}

/** Preserve the canonical vendor decision payload without the transport's approved/id fields. */
export function nativePermissionResult(response: Pick<PermissionResult,
    'decision' | 'nativeChoice' | 'mode' | 'allowedTools' | 'updatedPermissions' | 'execPolicyAmendment'
>): PermissionResult {
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

/** Translate a simple decision only when the native offer has one exact decision/scope match. */
export function resolveMediatedNativePermissionChoice(
    offered: NativePermissionChoicesV1 | undefined,
    decision: 'allow' | 'deny' | 'abort' | undefined,
    scope: 'request' | 'session' | undefined,
) {
    if (!offered || !decision || !scope) return undefined;
    const inScope = offered.choices.filter(choice => choice.scope === (scope === 'session' ? 'session' : 'once'));
    const select = (accepts: (candidate: NativePermissionChoicesV1['choices'][number]['decision']) => boolean) =>
        inScope.filter(choice => accepts(choice.decision));
    // Deny prefers the offered denial; Stop answers a deny only when no denial is offered.
    const matches = decision === 'allow'
        ? select(value => value === 'approved' || value === 'approved_for_session')
        : decision === 'abort' ? select(value => value === 'abort')
            : select(value => value === 'denied').length > 0 ? select(value => value === 'denied') : select(value => value === 'abort');
    // A simple decision cannot select between distinct native offers.
    return matches.length === 1
        ? { requirementId: offered.requirementId, choiceId: matches[0]!.id }
        : undefined;
}

/**
 * The public Allow/Deny answer of `session.permission.respond` (CLI, Agent, MCP, voice)
 * for a native-offer request: the one exactly matching offered choice, or none.
 * Grants beyond the decision (mode, tool rules, amendments, answers) are never offered natively.
 */
export function resolvePlainNativePermissionChoice(
    offered: NativePermissionChoicesV1 | undefined,
    response: Readonly<{ approved?: boolean; decision?: PermissionResult['decision']; mode?: unknown;
        allowedTools?: unknown; allowTools?: unknown; updatedPermissions?: unknown; execPolicyAmendment?: unknown; answers?: unknown }>,
) {
    if (response.approved === undefined || response.mode !== undefined || response.allowedTools !== undefined
        || response.allowTools !== undefined || response.updatedPermissions !== undefined
        || response.execPolicyAmendment !== undefined || response.answers !== undefined) return undefined;
    const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
    if (response.approved !== (decision !== 'denied' && decision !== 'abort')) return undefined;
    switch (decision) {
        case 'approved': return resolveMediatedNativePermissionChoice(offered, 'allow', 'request');
        case 'approved_for_session': return resolveMediatedNativePermissionChoice(offered, 'allow', 'session');
        case 'denied': return resolveMediatedNativePermissionChoice(offered, 'deny', 'request');
        case 'abort': return resolveMediatedNativePermissionChoice(offered, 'abort', 'request');
        default: return undefined;
    }
}

/** MCP and Happier Action owners may select an exact offered grant; other native prompts require a person. */
export function resolveNativePermissionImmediateDecision<T extends PermissionResult>(
    decision: T | null,
    nativeChoices: NativePermissionChoicesV1 | undefined,
    policyOwner?: ResolvedMcpToolIdentityV1 | Extract<HappierActionPermissionDecision, { actionId: string }> | null,
): PermissionResult | null {
    if (!nativeChoices || !decision || decision.nativeChoice) return decision;
    if (decision.decision === 'denied' || decision.decision === 'abort') {
        const answer = resolveMediatedNativePermissionChoice(nativeChoices, decision.decision === 'abort' ? 'abort' : 'deny', 'request');
        return answer ? resolveNativePermissionChoice(nativeChoices, answer)?.result ?? decision : decision;
    }
    if (!policyOwner) return null;
    const answer = resolveMediatedNativePermissionChoice(nativeChoices, 'allow',
        decision.decision === 'approved_for_session' ? 'session' : 'request');
    return answer ? resolveNativePermissionChoice(nativeChoices, answer)?.result ?? null : null;
}

/** Apply an immediate offered answer at the handler, before returning it to SDK waiters. */
export async function applyNativePermissionImmediateDecision(
    decision: PermissionResult,
    context?: Readonly<{ nativeChoices?: NativePermissionChoicesV1; acknowledgeDecisionApplication?: (decision: PermissionResult) => Promise<void> }>,
): Promise<PermissionResult> {
    if (context?.nativeChoices && decision.nativeChoice) await context.acknowledgeDecisionApplication?.(decision);
    return decision;
}
