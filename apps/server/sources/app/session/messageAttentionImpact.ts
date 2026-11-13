import { SESSION_MESSAGE_USER_ATTENTION_IMPACT, TranscriptRawAgentEventV1Schema, TranscriptRawRecordV1Schema, agentEventAttentionImpact, type SessionMessageAttentionImpact, type TranscriptRawRecordV1 } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';

export type PlainTranscriptRecordReader = () => TranscriptRawRecordV1 | null;

/**
 * One parse of a plain message's transcript record per write. The write path asks
 * several questions of the same record (attention, Follow event, ready event); they
 * share this reader instead of each re-parsing a large union body.
 */
export function createPlainTranscriptRecordReader(content: PrismaJson.SessionMessageContent): PlainTranscriptRecordReader {
    let record: TranscriptRawRecordV1 | null | undefined;
    return () => {
        if (record === undefined) {
            const parsed = content.t === "plain" ? TranscriptRawRecordV1Schema.safeParse(content.v) : null;
            record = parsed?.success ? parsed.data : null;
        }
        return record;
    };
}

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
    /** The write's shared reader of `content`; absent callers parse once here. */
    readPlainRecord?: PlainTranscriptRecordReader;
}>): SessionMessageAttentionImpact {
    if (params.explicitAttentionImpact) return params.explicitAttentionImpact;
    if (params.content.t !== "plain") return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
    const record = (params.readPlainRecord ?? createPlainTranscriptRecordReader(params.content))();
    if (!record || record.role !== "agent" || record.content.type !== "event") {
        return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
    }
    const event = TranscriptRawAgentEventV1Schema.safeParse(record.content.data);
    return event.success
        ? agentEventAttentionImpact(event.data, params.localId)
        : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}
