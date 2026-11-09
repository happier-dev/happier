import { getAgentBehavior, isBundledAgentId } from '@/agents/catalog/catalog';
import { getPermissionFooterCopy } from '@/agents/catalog/permissionUiCopy';
import { parseParenIdentifier } from "@happier-dev/session-core/tools";
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { NativePermissionChoiceAnswerV1, SessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/protocol/sessions/permissions/v1';

/** Legacy vocabulary retained for stored requests and producers awaiting migration. */
export type SessionPermissionAnswer = 'allowOnce' | 'allowForSession' | 'deny';

/**
 * Historical answer encoding. `codexDecision` answers
 * carry an explicit provider decision; `standard` answers express a session
 * allowance as a tool rule (optionally as provider permission updates). An Agent
 * that declares no known prompt protocol (`unavailable`) can only be refused.
 */
export type SessionPermissionAnswerPolicy = Readonly<{
    protocol: 'codexDecision' | 'standard' | 'unavailable';
    usePermissionUpdates: boolean;
}>;

type SessionPermissionBehavior = ReturnType<typeof getAgentBehavior>['permissions'];

/**
 * Legacy request interpretation. Claude/Codex predecessors are frozen below;
 * other installed Agent descriptors remain scoped to the owning machine.
 */
export function resolveSessionPermissionBehavior(input: Readonly<{
    agentId: string | null;
    metadata: unknown;
    accountScope: ServerAccountScope | null | undefined;
}>): SessionPermissionBehavior | undefined {
    // C6: old Claude/Codex occurrences did not save their policy. Freeze their
    // predecessor interpretation here so removing live declarations cannot
    // reinterpret retained requests. Native offers bypass this reader entirely.
    if (input.agentId === 'claude') return { promptProtocol: 'claude', footer: {
        usePermissionUpdates: true, forceReadOnlyAfterStop: true,
        supportsExecPolicyAmendment: false, stopHandling: 'denyAndAbortRun',
    } };
    if (input.agentId === 'codex') return { promptProtocol: 'codexDecision', footer: {
        usePermissionUpdates: false, forceReadOnlyAfterStop: false,
        supportsExecPolicyAmendment: true, stopHandling: 'denyOnly',
    } };
    const owningMachineId = resolveSessionMachineId(input.metadata);
    return input.agentId && (isBundledAgentId(input.agentId) || owningMachineId !== null)
        ? getAgentBehavior(input.agentId, owningMachineId, input.accountScope).permissions
        : undefined;
}

export function resolveSessionPermissionAnswerPolicy(input: Readonly<{
    permissionBehavior: SessionPermissionBehavior | undefined;
    /** Provider-suggested permission updates carried by the pending request. */
    suggestions: unknown;
}>): SessionPermissionAnswerPolicy {
    const protocol = getPermissionFooterCopy(input.permissionBehavior?.promptProtocol).protocol;
    return {
        protocol: protocol === 'codexDecision' ? 'codexDecision' : protocol === 'claude' ? 'standard' : 'unavailable',
        usePermissionUpdates: input.permissionBehavior?.footer?.usePermissionUpdates === true
            || Array.isArray(input.suggestions),
    };
}

/**
 * Edit tools get "allow all edits" instead of a per-tool session rule, and plan
 * exit is a one-shot decision; the standard protocol offers no session
 * allowance for them.
 */
const NO_SESSION_RULE_TOOL_NAMES = new Set([
    'Edit',
    'MultiEdit',
    'Write',
    'NotebookEdit',
    'exit_plan_mode',
    'ExitPlanMode',
]);

export function supportsSessionPermissionRule(toolName: string): boolean {
    return toolName.length > 0 && !NO_SESSION_RULE_TOOL_NAMES.has(toolName);
}

/** Request-owned native scope applies to every grant, independent of the Agent's answer protocol. */
export function supportsSessionPermissionPersistence(source: string | undefined): boolean {
    return source !== NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE;
}

export function resolveSessionPermissionAnswers(input: Readonly<{
    toolName: string;
    protocol: SessionPermissionAnswerPolicy['protocol'];
    source?: string;
}>): readonly SessionPermissionAnswer[] {
    if (input.protocol === 'unavailable') return ['deny'];
    return supportsSessionPermissionPersistence(input.source)
        && (input.protocol === 'codexDecision' || supportsSessionPermissionRule(input.toolName))
        ? ['allowOnce', 'allowForSession', 'deny']
        : ['allowOnce', 'deny'];
}

type PermissionAnswerDelivery = Readonly<{
    requestId: string;
    turnId?: string;
    respondToPermission(params: Omit<SessionPermissionRespondRpcParamsV1, 'answers'>): Promise<void>;
}>;

export type AnswerSessionPermissionInput = PermissionAnswerDelivery & (Readonly<{
    nativeChoice: NativePermissionChoiceAnswerV1;
}> | Readonly<{
    source?: string;
    toolName: string;
    answer: SessionPermissionAnswer;
    policy: SessionPermissionAnswerPolicy;
}>);

export async function answerSessionPermission(input: AnswerSessionPermissionInput): Promise<void> {
    if ('nativeChoice' in input) {
        await input.respondToPermission({ id: input.requestId,
            ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), nativeChoice: input.nativeChoice });
        return;
    }
    if (input.answer === 'allowForSession' && !supportsSessionPermissionPersistence(input.source)) {
        throw Object.assign(new Error('Permission answer is unavailable for this request'), { code: 'permission_answer_unavailable' });
    }
    const { requestId: id, turnId, toolName, policy, respondToPermission } = input;
    const request = { id, ...(turnId !== undefined ? { turnId } : {}) };
    const isDecision = policy.protocol === 'codexDecision';

    if (input.answer === 'deny') {
        await respondToPermission({ ...request, approved: false, decision: 'denied' });
        return;
    }
    if (input.answer === 'allowOnce') {
        await respondToPermission({ ...request, approved: true, ...(isDecision ? { decision: 'approved' } : {}) });
        return;
    }
    if (isDecision) {
        await respondToPermission({ ...request, approved: true, decision: 'approved_for_session' });
        return;
    }
    if (policy.usePermissionUpdates) {
        const parsed = parseParenIdentifier(toolName);
        const rules = [
            parsed
                ? { toolName: parsed.name, ...(parsed.spec ? { ruleContent: parsed.spec } : {}) }
                : { toolName },
        ];
        await respondToPermission({
            ...request,
            approved: true,
            allowedTools: [toolName],
            updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }],
        });
        return;
    }
    await respondToPermission({ ...request, approved: true, allowedTools: [toolName] });
}
