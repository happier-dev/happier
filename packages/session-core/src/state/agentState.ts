import { z } from "zod/mini";
import * as zMini from "zod/mini";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionPermissionAnsweringClientCategoryV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { SessionQuestionContextV1Schema, SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY, CurrentSessionPresentationStateV1Schema } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import { SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1, SessionFollowRuleSourceEvidenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { SessionRuntimeWorkStatusV1Schema } from '@happier-dev/protocol/sessions/awareness/projectionV1';

const AgentStateObjectSchema = z.looseObject({
    workStatus: z.catch(z.nullish(SessionRuntimeWorkStatusV1Schema), null),
    // Protocol-owned schemas use Zod Mini, whose composition helpers live on the namespace.
    [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: zMini.optional(CurrentSessionPresentationStateV1Schema),
    controlledByUser: z.nullish(z.boolean()),
    localControl: z.nullish(z.object({
        attached: z.nullish(z.boolean()),
        topology: z.nullish(z.enum(['exclusive', 'shared'])),
        remoteWritable: z.nullish(z.boolean()),
        canAttach: z.nullish(z.boolean()),
        canDetach: z.nullish(z.boolean()),
    })),
    requests: z.nullish(z.record(z.string(), z.object({
        tool: z.string(),
        kind: z.optional(z.string()),
        source: z.optional(z.string()),
        arguments: z.any(),
        createdAt: z.nullish(z.number()),
        turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
        sidechainId: z.optional(z.unknown()),
        questionV1: z.optional(SessionQuestionContextV1Schema),
        currentHandler: z.optional(SessionQuestionHandlerV1Schema),
        [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: z.optional(SessionFollowRuleSourceEvidenceV1Schema),
        pushNotifiedAt: z.optional(z.number()),
        /**
         * Optional provider-provided permission suggestions for this request.
         * (e.g. Claude Agent SDK `permission_suggestions`).
         */
        permissionSuggestions: z.optional(z.any()),
        mcpTool: zMini.catch(zMini.optional(ResolvedMcpToolIdentityV1Schema), undefined),
    }))),
    completedRequests: z.nullish(z.record(z.string(), z.looseObject({
        tool: z.string(),
        kind: z.optional(z.string()),
        source: z.optional(z.string()),
        arguments: z.any(),
        createdAt: z.nullish(z.number()),
        completedAt: z.nullish(z.number()),
        turnId: z.catch(z.optional(z.string().check(z.trim(), z.minLength(1))), undefined),
        answeringClientCategory: zMini.catch(zMini.optional(SessionPermissionAnsweringClientCategoryV1Schema), undefined),
        questionV1: z.optional(SessionQuestionContextV1Schema),
        currentHandler: z.optional(SessionQuestionHandlerV1Schema),
        answeredBy: z.optional(SessionQuestionHandlerV1Schema),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.nullish(z.string()),
        mode: z.nullish(z.string()),
        allowedTools: z.nullish(z.array(z.string())),
        decision: z.catch(z.nullish(z.enum(['approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort'])), undefined),
        updatedPermissions: z.optional(z.any()),
        // Source-owned completion evidence remains opaque here; its consumers validate it.
        allowTools: z.optional(z.unknown()),
        answers: z.optional(z.unknown()),
        structuredAnswersV1: z.optional(z.unknown()),
        dialogId: z.optional(z.unknown()),
        dialogChoice: z.optional(z.unknown()),
        responseTarget: z.optional(z.unknown()),
        subagentRef: z.optional(z.unknown()),
        sidechainId: z.optional(z.unknown()),
        permissionSuggestions: z.optional(z.unknown()),
        mcpTool: zMini.catch(zMini.optional(ResolvedMcpToolIdentityV1Schema), undefined),
        permissionDecisionActorV1: z.optional(z.unknown()),
        permissionDecisionClaimV1: z.optional(z.unknown()),
        remoteMediationSettlementId: z.optional(z.unknown()),
    }))),
    /**
     * Optional agent capabilities negotiated via agentState.
     * This must be permissive for backward/forward compatibility across agent versions.
     */
    capabilities: z.nullish(z.object({
        askUserQuestionAnswersInPermission: z.optional(z.boolean()),
        inFlightSteer: z.optional(z.boolean()),
        inFlightSteerSupported: z.optional(z.boolean()),
        inFlightSteerAvailable: z.optional(z.boolean()),
        /**
         * Why in-flight steering is currently unavailable (Seam A). Permissive string for
         * forward-compat across CLI versions. Known values: 'backend_unsupported' |
         * 'unsafe_window' | 'turn_settling' | 'user_terminal_draft' (X1: a terminal composer
         * draft is starving steering).
         */
        inFlightSteerUnavailableReason: z.nullish(z.string()),
        /** Timestamp (ms) of the last steerability evaluation — staleness guard. */
        inFlightSteerStateAt: z.nullish(z.number()),
        /**
         * G4 (lane Q intent): the backend can apply a steered message's config delta (permission
         * mode) to the RUNNING turn, so the busy-send affordance may offer
         * "Apply setting & steer now". Readers must fail closed when absent.
         */
        inFlightConfigApplySupported: z.nullish(z.boolean()),
        terminalComposerClearSupported: z.nullish(z.boolean()),
        sessionGoalSetSupported: z.nullish(z.boolean()),
        sessionGoalClearSupported: z.nullish(z.boolean()),
        pendingInputInterruptAndRunLocalId: z.nullish(z.string().check(z.trim(), z.minLength(1))),
        pendingInputInterruptAndRunStateAt: z.nullish(z.number().check(z.int(), z.nonnegative())),
        terminalComposerDraftPresent: z.nullish(z.boolean()),
        localPermissionBridgeInLocalMode: z.optional(z.boolean()),
        permissionsInUiWhileLocal: z.optional(z.boolean()),
    })),
});

export const AgentStateSchema = createStoredReadSchema((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}), AgentStateObjectSchema));

export type AgentState = z.infer<typeof AgentStateSchema>;
