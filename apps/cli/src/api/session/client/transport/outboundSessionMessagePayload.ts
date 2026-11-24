import {
    encryptSessionMessagePayload,
    type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';
import { createSessionToolOutputBindingV1 } from '@happier-dev/protocol/sessions/messages/sessionToolOutputBindingV1';
import { resolveToolEnvelopeMeta } from '@happier-dev/protocol/tools/v2';
import { isRecord } from '@happier-dev/protocol/actions/happierActionToolResult';

import {
    redactAgentStatePermissionChoiceOffer,
    redactTranscriptSecrets,
    redactTranscriptSecretsExcept,
} from './transcriptSecretRedaction';

function redactFields(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
    let next = record;
    for (const field of fields) {
        if (!(field in record)) continue;
        const value = redactTranscriptSecrets(record[field]);
        if (value !== record[field]) next = { ...next, [field]: value };
    }
    return next;
}

function redactData(
    record: Record<string, unknown>,
    project: (data: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
    if (!isRecord(record.data)) return record;
    const data = project(record.data);
    return data === record.data ? record : { ...record, data };
}

function redactEventBody(data: Record<string, unknown>): Record<string, unknown> {
    return redactFields(data, data.type === 'worker-report' ? ['summary', 'deliverables'] : ['message', 'sanitizedErrorPreview']);
}

function redactAcpBody(data: Record<string, unknown>): Record<string, unknown> {
    switch (data.type) {
        case 'message':
        case 'reasoning':
            return redactFields(data, ['message']);
        case 'thinking':
            return redactFields(data, ['text']);
        case 'tool-call': {
            const next = redactFields(data, ['input']);
            const permission = next.permission;
            if (!isRecord(permission) || !('nativeChoices' in permission)) return next;
            const nativeChoices = redactAgentStatePermissionChoiceOffer(permission.nativeChoices);
            return nativeChoices === permission.nativeChoices ? next : { ...next, permission: { ...permission, nativeChoices } };
        }
        case 'tool-result':
            return redactFields(data, ['output']);
        case 'file-edit':
            return redactFields(data, ['description', 'diff', 'oldContent', 'newContent']);
        case 'terminal-output':
            return redactFields(data, ['data']);
        case 'permission-request':
            return redactFields(data, ['description', 'options']);
        case 'event':
            return redactData(data, redactEventBody);
        case 'context-compaction':
            return redactFields(data, ['sanitizedErrorPreview']);
        case 'task_started':
        case 'task_complete':
        case 'turn_failed':
        case 'turn_cancelled':
        case 'turn_aborted':
        case 'permission-response':
        case 'token_count':
        case 'output':
            return data;
        default:
            // A body this projection does not know is Agent content; it can over-mask, never leak.
            return redactTranscriptSecretsExcept(data, ['type']);
    }
}

/**
 * The one projection of a stored Session message onto its Agent-authored content: user text and, in
 * an ACP body, message text, tool input and tool output values, file-edit text and terminal data.
 * Role, content and body types, ids, call ids, tool names, provider and meta are host control and stay
 * byte-identical. Shared by the live, durable and historical-import writers.
 */
export function redactSessionMessageContentSecrets(message: unknown): unknown {
    // A bare value is text; a record without message content (delivery facts) is host control.
    if (!isRecord(message)) return redactTranscriptSecrets(message);
    if (!isRecord(message.content)) return message;
    const content = message.content;
    const projected = content.type === 'text' ? redactFields(content, ['text'])
        : content.type === 'acp' ? redactData(content, redactAcpBody)
            : content.type === 'event' ? redactData(content, redactEventBody)
                // A content shape this projection does not know is Agent content; it can over-mask, never leak.
                : redactTranscriptSecretsExcept(content, ['type']);
    return projected === content ? message : { ...message, content: projected };
}

/** Socket transcript payload shape; encryption stays owned by the Session codec. Live host-minted secrets are redacted first. */
export function buildOutboundSessionMessagePayload(
    context: SessionStoredContentCryptoContext,
    content: unknown,
): string | { t: 'plain'; v: unknown } {
    const redacted = redactSessionMessageContentSecrets(content);
    return context.mode === 'plain'
        ? { t: 'plain', v: redacted }
        : encryptSessionMessagePayload({ ctx: context.ctx, payload: redacted });
}

type OutboundSessionMessagePayload = ReturnType<typeof buildOutboundSessionMessagePayload>;

/** The durable serializer runs after output-derived references have been projected. */
export function buildDurableOutboundSessionMessagePayload(
    context: SessionStoredContentCryptoContext,
    input: Readonly<{ content: unknown; sessionId: string; localId: string; canonicalToolName?: string }>,
): Readonly<{ payload: OutboundSessionMessagePayload; toolOutputPart?: StrictSessionStoredMessageContentEnvelope }> {
    const content = redactSessionMessageContentSecrets(input.content);
    const seal =(payload: unknown): OutboundSessionMessagePayload => context.mode === 'plain'
        ? { t: 'plain', v: payload }
        : encryptSessionMessagePayload({ ctx: context.ctx, payload });
    const split = splitDurableSessionToolOutput(context, { ...input, content });
    return split ? { payload: seal(split.shell), toolOutputPart: split.toolOutputPart } : { payload: seal(content) };
}

/** Detach only normalized tool output from the pre-seal durable record. */
export function splitDurableSessionToolOutput(
    context: SessionStoredContentCryptoContext,
    input: Readonly<{ content: unknown; sessionId: string; localId: string; canonicalToolName?: string }>,
): Readonly<{ shell: unknown; toolOutputPart: StrictSessionStoredMessageContentEnvelope }> | null {
    const content = input.content;
    if (!isRecord(content) || !isRecord(content.content) || content.content.type !== 'acp') return null;
    const result = content.content.data;
    // Shell terminal output has explicit body fields. Other tools may use these
    // names for structured facts that must remain in the durable transcript.
    if (!isRecord(result) || result.type !== 'tool-result' || !isRecord(result.output)) return null;
    const canonicalToolName = input.canonicalToolName ?? resolveToolEnvelopeMeta(result.output)?.canonicalToolName;
    if (canonicalToolName !== 'Bash') return null;
    const output = { ...result.output };
    const fields: Record<string, string> = {};
    for (const key of ['stdout', 'stderr', 'aggregatedOutput', 'errorMessage', 'output'] as const) {
        const value = output[key];
        if (typeof value !== 'string' || value.length === 0) continue;
        fields[key] = value;
        delete output[key];
    }
    const textBlocks: Array<{ index: number; text: string }> = [];
    if (Array.isArray(output.content)) {
        output.content = output.content.map((block, index) => {
            if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) {
                return block;
            }
            textBlocks.push({ index, text: block.text });
            return { ...block, text: '' };
        });
    }
    if (Object.keys(fields).length === 0 && textBlocks.length === 0) return null;

    const body = { v: 1, fields, textBlocks };
    const toolOutputPart: StrictSessionStoredMessageContentEnvelope = context.mode === 'plain'
        ? { t: 'plain', v: body }
        : { t: 'encrypted', c: encryptSessionMessagePayload({ ctx: context.ctx, payload: body, purpose: 'tool-output',
            idempotencyKey: input.localId }) };
    const binding = createSessionToolOutputBindingV1(input.sessionId, input.localId, toolOutputPart);
    return {
        shell: {
            ...content,
            content: { ...content.content, data: { ...result, output } },
            meta: { ...(isRecord(content.meta) ? content.meta : {}), happierToolOutputV1: binding },
        },
        toolOutputPart,
    };
}
