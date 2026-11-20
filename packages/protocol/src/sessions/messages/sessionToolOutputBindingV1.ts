import { isRecord } from '../../actions/happierActionToolResult.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import type { StrictSessionStoredMessageContentEnvelope } from './sessionStoredMessageContent.js';

export const SessionToolOutputBodyV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    fields: z.strictObject({
        stdout: z.optional(z.string()),
        stderr: z.optional(z.string()),
        aggregatedOutput: z.optional(z.string()),
        errorMessage: z.optional(z.string()),
        output: z.optional(z.string()),
    }),
    textBlocks: z.array(z.strictObject({
        index: z.number().check(z.int(), z.minimum(0)),
        text: z.string(),
    })),
}));

export type SessionToolOutputBodyV1 = z.infer<typeof SessionToolOutputBodyV1Schema>;

const SessionToolOutputBindingV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    digest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));

export const LegacyInlineContentDigestV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)));

/** Comparison-only operand for an already-authorized historical import. */
export function createLegacyInlineContentDigestV1(
    sessionId: string,
    localId: string,
    original: StrictSessionStoredMessageContentEnvelope,
): string {
    return computeCanonicalDomainSeparatedDigest('happier.session-message.historical-inline-overlap.v1', [
        sessionId, localId, original.t,
        original.t === 'encrypted' ? original.c : createCanonicalJsonSigningInput(original),
    ]);
}

export function createSessionToolOutputBindingV1(
    sessionId: string,
    localId: string,
    part: StrictSessionStoredMessageContentEnvelope,
): Readonly<{ v: 1; digest: string }> {
    return {
        v: 1,
        digest: computeCanonicalDomainSeparatedDigest('happier.session-message.tool-output.v1', [
            sessionId, localId, createCanonicalJsonSigningInput(part),
        ]),
    };
}

export function readSessionToolOutputBindingV1(shell: unknown) {
    if (!isRecord(shell) || !isRecord(shell.meta) || !Object.hasOwn(shell.meta, 'happierToolOutputV1')) {
        return { status: 'absent' } as const;
    }
    const content = shell.content;
    if (shell.role !== 'agent' || !isRecord(content) || content.type !== 'acp' ||
        !isRecord(content.data) || content.data.type !== 'tool-result' || typeof content.data.callId !== 'string' ||
        !isRecord(content.data.output)) {
        return { status: 'invalid' } as const;
    }
    const binding = SessionToolOutputBindingV1Schema.safeParse(shell.meta.happierToolOutputV1);
    return binding.success
        ? { status: 'bound', binding: binding.data } as const
        : { status: 'invalid' } as const;
}
