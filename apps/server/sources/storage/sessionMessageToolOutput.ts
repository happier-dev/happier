import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import {
    StrictSessionStoredMessageContentEnvelopeSchema,
    type StrictSessionStoredMessageContentEnvelope,
} from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import {
    createSessionToolOutputBindingV1,
    readSessionToolOutputBindingV1,
    SessionToolOutputBodyV1Schema,
} from '@happier-dev/protocol/sessions/messages/sessionToolOutputBindingV1';
import { decodeBase64, encodeBase64 } from 'privacy-kit';

export type SessionMessageToolOutputWrite = Readonly<{
    sessionId: string;
    localId: string;
    part: StrictSessionStoredMessageContentEnvelope;
}>;

export class SessionMessageToolOutputInvalidError extends Error {
    readonly code = 'session_tool_output_part_invalid';

    constructor() {
        super('Invalid Session tool output part or binding');
        this.name = 'SessionMessageToolOutputInvalidError';
    }
}

export function prepareSessionMessageToolOutputForWrite(
    content: StrictSessionStoredMessageContentEnvelope,
    output?: SessionMessageToolOutputWrite,
): Uint8Array<ArrayBuffer> | null {
    const binding = content.t === 'plain' ? readSessionToolOutputBindingV1(content.v) : null;
    if (!output) {
        if (binding && binding.status !== 'absent') throw new SessionMessageToolOutputInvalidError();
        return null;
    }
    const bytes = encodeSessionMessageToolOutput(output.part, content.t);
    if (!output.localId || bytes === null || (binding && (binding.status !== 'bound' ||
        binding.binding.digest !== createSessionToolOutputBindingV1(output.sessionId, output.localId, output.part).digest))) {
        throw new SessionMessageToolOutputInvalidError();
    }
    return bytes;
}

function encodeSessionMessageToolOutput(
    input: unknown,
    mode: StrictSessionStoredMessageContentEnvelope['t'],
): Uint8Array<ArrayBuffer> | null {
    const parsed = StrictSessionStoredMessageContentEnvelopeSchema.safeParse(input);
    if (!parsed.success || parsed.data.t !== mode) return null;
    if (parsed.data.t === 'encrypted') {
        return readCanonicalPaddedBase64DecodedLength(parsed.data.c) === null ? null : decodeBase64(parsed.data.c);
    }
    const body = SessionToolOutputBodyV1Schema.safeParse(parsed.data.v);
    if (!body.success) return null;
    return new TextEncoder().encode(JSON.stringify(body.data));
}

export function decodeSessionMessageToolOutput(
    bytes: Uint8Array,
    mode: StrictSessionStoredMessageContentEnvelope['t'],
): StrictSessionStoredMessageContentEnvelope {
    return mode === 'encrypted'
        ? { t: 'encrypted', c: encodeBase64(bytes) }
        : { t: 'plain', v: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
}
