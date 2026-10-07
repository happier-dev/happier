import { z } from "zod";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

const AgentStateObjectSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    localControl: z.object({
        attached: z.boolean().nullish(),
        topology: z.enum(['exclusive', 'shared']).nullish(),
        remoteWritable: z.boolean().nullish(),
        canAttach: z.boolean().nullish(),
        canDetach: z.boolean().nullish(),
    }).nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        kind: z.string().optional(),
        source: z.string().optional(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        turnId: z.string().trim().min(1).optional(),
        pushNotifiedAt: z.number().optional(),
        /**
         * Optional provider-provided permission suggestions for this request.
         * (e.g. Claude Agent SDK `permission_suggestions`).
         */
        permissionSuggestions: z.any().optional(),
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        kind: z.string().optional(),
        source: z.string().optional(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort'])
            .nullish()
            .catch(undefined),
        updatedPermissions: z.any().optional(),
        // Source-owned completion evidence remains opaque here; its consumers validate it.
        allowTools: z.unknown().optional(),
        answers: z.unknown().optional(),
        structuredAnswersV1: z.unknown().optional(),
        dialogId: z.unknown().optional(),
        dialogChoice: z.unknown().optional(),
        responseTarget: z.unknown().optional(),
        subagentRef: z.unknown().optional(),
        sidechainId: z.unknown().optional(),
        permissionSuggestions: z.unknown().optional(),
        permissionDecisionActorV1: z.unknown().optional(),
        permissionDecisionClaimV1: z.unknown().optional(),
        remoteMediationSettlementId: z.unknown().optional(),
    }).passthrough()).nullish(),
    /**
     * Optional agent capabilities negotiated via agentState.
     * This must be permissive for backward/forward compatibility across agent versions.
     */
    capabilities: z.object({
        askUserQuestionAnswersInPermission: z.boolean().optional(),
        inFlightSteer: z.boolean().optional(),
        inFlightSteerSupported: z.boolean().optional(),
        inFlightSteerAvailable: z.boolean().optional(),
        /**
         * Why in-flight steering is currently unavailable (Seam A). Permissive string for
         * forward-compat across CLI versions. Known values: 'backend_unsupported' |
         * 'unsafe_window' | 'turn_settling' | 'user_terminal_draft' (X1: a terminal composer
         * draft is starving steering).
         */
        inFlightSteerUnavailableReason: z.string().nullish(),
        /** Timestamp (ms) of the last steerability evaluation — staleness guard. */
        inFlightSteerStateAt: z.number().nullish(),
        /**
         * G4 (lane Q intent): the backend can apply a steered message's config delta (permission
         * mode) to the RUNNING turn, so the busy-send affordance may offer
         * "Apply setting & steer now". Readers must fail closed when absent.
         */
        inFlightConfigApplySupported: z.boolean().nullish(),
        terminalComposerClearSupported: z.boolean().nullish(),
        sessionGoalSetSupported: z.boolean().nullish(),
        sessionGoalClearSupported: z.boolean().nullish(),
        pendingInputInterruptAndRunLocalId: z.string().trim().min(1).nullish(),
        pendingInputInterruptAndRunStateAt: z.number().int().nonnegative().nullish(),
        terminalComposerDraftPresent: z.boolean().nullish(),
        localPermissionBridgeInLocalMode: z.boolean().optional(),
        permissionsInUiWhileLocal: z.boolean().optional(),
    }).nullish(),
}).passthrough();

export const AgentStateSchema = createStoredReadSchema(z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}, AgentStateObjectSchema));

export type AgentState = z.infer<typeof AgentStateSchema>;
