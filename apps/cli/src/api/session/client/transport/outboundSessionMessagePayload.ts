import {
    encryptSessionMessagePayload,
    type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';
import { createSessionToolOutputBindingV1 } from '@happier-dev/protocol/sessions/messages/sessionToolOutputBindingV1';
import { resolveToolEnvelopeMeta } from '@happier-dev/protocol/tools/v2';
import { isRecord } from '@happier-dev/protocol/actions/happierActionToolResult';

import { redactTranscriptSecrets } from './transcriptSecretRedaction';

/** Socket transcript payload shape; encryption stays owned by the Session codec. Live host-minted secrets are redacted first. */
export function buildOutboundSessionMessagePayload(
    context: SessionStoredContentCryptoContext,
    content: unknown,
): string | { t: 'plain'; v: unknown } {
    const redacted = redactTranscriptSecrets(content);
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
    const content = redactTranscriptSecrets(input.content);
    const seal = (payload: unknown): OutboundSessionMessagePayload => context.mode === 'plain'
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
