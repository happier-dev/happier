import {
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
    TranscriptRawAgentEventV1Schema,
    TranscriptRawRecordV1Schema,
    agentEventAttentionImpact,
    type SessionMessageAttentionImpact,
} from "@happier-dev/protocol";

export function resolveMessageAttentionImpact(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    /**
     * The row's local id. Required, because the Agent-transition divider's
     * attention exemption is only trustworthy when the reserved localId
     * namespace — which every generic ingress refuses — backs the sidecar.
     * `null` for a row that genuinely has none.
     */
    localId: string | null;
    explicitAttentionImpact?: SessionMessageAttentionImpact;
}>): SessionMessageAttentionImpact {
    if (params.explicitAttentionImpact) return params.explicitAttentionImpact;
    if (params.content.t !== "plain") return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
    const record = TranscriptRawRecordV1Schema.safeParse(params.content.v);
    if (!record.success || record.data.role !== "agent" || record.data.content.type !== "event") {
        return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
    }
    const event = TranscriptRawAgentEventV1Schema.safeParse(record.data.content.data);
    return event.success
        ? agentEventAttentionImpact(event.data, params.localId)
        : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}
