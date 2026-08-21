import {
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
    TranscriptRawAgentEventV1Schema,
    TranscriptRawRecordV1Schema,
    agentEventAttentionImpact,
    type SessionMessageAttentionImpact,
} from "@happier-dev/protocol";

/**
 * Canonical owner of stored-message attention-impact resolution.
 *
 * `attentionImpact` marks messages that must NOT affect unread badges /
 * meaningful-activity ordering (quiet maintenance agent events). The server
 * resolves it once per stored message and attaches it to every message
 * fan-out payload so clients that cannot decrypt the content (hidden-session
 * projection routing) can still patch their session-list projection instead
 * of refetching the whole session list.
 */
export function resolvePlainStoredAgentEvent(
    content: PrismaJson.SessionMessageContent,
): ReturnType<typeof TranscriptRawAgentEventV1Schema.parse> | null {
    if (!content || content.t !== "plain") return null;
    const parsed = TranscriptRawRecordV1Schema.safeParse(content.v);
    if (
        !parsed.success
        || parsed.data.role !== "agent"
        || parsed.data.content.type !== "event"
    ) return null;
    const event = TranscriptRawAgentEventV1Schema.safeParse(parsed.data.content.data);
    return event.success ? event.data : null;
}

/**
 * Explicit write-time impact wins. Otherwise, plain content is resolved with
 * the row's outer localId so the transition-divider exception requires both
 * the strict sidecar and reserved namespace. Encrypted content remains opaque
 * and conservatively attention-bearing; the client re-evaluates after decrypt.
 */
export function resolveMessageAttentionImpact(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    localId: string | null;
    explicitAttentionImpact?: SessionMessageAttentionImpact;
}>): SessionMessageAttentionImpact {
    if (params.explicitAttentionImpact) return params.explicitAttentionImpact;
    const event = resolvePlainStoredAgentEvent(params.content);
    return event ? agentEventAttentionImpact(event, params.localId) : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}
