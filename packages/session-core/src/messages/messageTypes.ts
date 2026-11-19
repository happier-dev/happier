import { AgentEvent } from "../raw/index.js";
import type { MessageStructuredPresentationV1, SessionPermissionDecisionActorV1, TranscriptPeerSenderV1 } from '@happier-dev/protocol';
import { MessageMeta } from "./messageMetaTypes.js";
import type { TranscriptObservationMetadata } from "./transcriptObservationProvenance.js";
import type { TranscriptAccountActorMetadata } from "./transcriptAccountActor.js";
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import type { NativePermissionChoiceAnswerV1, NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

import type { SessionMessageToolOutputAvailability } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

export type ToolCall = {
    // Provider-side identifier for this tool call (e.g. ACP callId, Claude tool_use id).
    // Optional for backward compatibility with older sessions and unit tests.
    id?: string;
    /** Original provider id retained by a source-scoped inherited projection. */
    sourceToolId?: string;
    name: string;
    state: 'running' | 'completed' | 'error' | 'unavailable';
    input: any;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: any;
    toolOutputAvailability?: SessionMessageToolOutputAvailability;
    permission?: {
        nativeChoices?: NativePermissionChoicesV1;
        /** The offered choice that was applied; its label is read from `nativeChoices`. */
        nativeChoice?: NativePermissionChoiceAnswerV1;
        id: string;
        /** Exact request custody; never inferred from the Session's latest turn. */
        turnId?: string;
        /** Request-owned response scope, retained when full AgentState unloads. */
        source?: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        kind?: string;
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        decisionActor?: SessionPermissionDecisionActorV1;
        /** Answer disposition stamped by the question owner, not the worker's requester. */
        answeredBy?: SessionQuestionHandlerV1;
        date?: number;
        /**
         * Provider-suggested permission updates that can be applied by the user when approving.
         *
         * Opaque by default so provider-specific schemas can flow through without core coupling.
         * (e.g. Claude Agent SDK `permission_suggestions` / `PermissionUpdate[]`).
         */
        suggestions?: unknown;
        mcpTool?: ResolvedMcpToolIdentityV1;
    };
};

// Flattened message types - each message represents a single block
export type UserTextMessage = {
    kind: 'user-text';
    id: string;
    realID?: string | null;
    seq?: number;
    transcriptBlockIndex?: number;
    localId: string | null;
    createdAt: number;
    text: string;
    displayText?: string; // Optional text to display in UI instead of actual text
    meta?: MessageMeta;
    structuredPresentation?: MessageStructuredPresentationV1;
} & TranscriptObservationMetadata & TranscriptAccountActorMetadata;

export type ModeSwitchMessage = {
    kind: 'agent-event';
    id: string;
    realID?: string | null;
    seq?: number;
    transcriptBlockIndex?: number;
    /**
     * The submitting client's row key. Load-bearing on this kind: the
     * Agent-transition divider is only readable at its reserved localId, so an
     * agent-event row that drops it can never be a divider.
     */
    localId: string | null;
    createdAt: number;
    event: AgentEvent;
    meta?: MessageMeta;
} & TranscriptObservationMetadata & TranscriptAccountActorMetadata;

export type AgentTextMessage = {
    kind: 'agent-text';
    id: string;
    realID?: string | null;
    seq?: number;
    transcriptBlockIndex?: number;
    localId: string | null;
    createdAt: number;
    text: string;
    isThinking?: boolean;
    /** Text another agent delivered into this Agent's conversation (teammate, cross-session, subagent hand-back). */
    peer?: TranscriptPeerSenderV1;
    meta?: MessageMeta;
    structuredPresentation?: MessageStructuredPresentationV1;
} & TranscriptObservationMetadata & TranscriptAccountActorMetadata;

export type ToolCallMessage = {
    kind: 'tool-call';
    id: string;
    realID?: string | null;
    seq?: number;
    transcriptBlockIndex?: number;
    localId: string | null;
    createdAt: number;
    tool: ToolCall;
    children: Message[];
    meta?: MessageMeta;
} & TranscriptObservationMetadata & TranscriptAccountActorMetadata;

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage;
