import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

const factShape = {
    authorityReason: z.enum(['target', 'descriptor', 'identity', 'descriptor_identity', 'destination', 'destination_not_allowed']),
    authorityPhase: z.enum(['first_contact', 'post_claim', 'controller_approval', 'authenticated']),
    authorityCarrier: z.enum(['https', 'iroh']),
    authorityDescriptorPresent: z.boolean(),
};
const factsSchema = z.strictObject(factShape);
export type HomeAuthorityMismatchFacts = Readonly<z.infer<typeof factsSchema>>;
export const HomeAuthorityMismatchFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('homeAuthorityMismatch'), ...factShape,
}));
export type HomeAuthorityMismatchFailureDetailsV1 = Readonly<z.infer<typeof HomeAuthorityMismatchFailureDetailsV1Schema>>;

/** Only these producer facts may cross CLI, task and operation boundaries. */
export function readHomeAuthorityMismatchFacts(value: unknown): HomeAuthorityMismatchFacts | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const result = factsSchema.safeParse({
        authorityReason: Reflect.get(value, 'authorityReason'), authorityPhase: Reflect.get(value, 'authorityPhase'),
        authorityCarrier: Reflect.get(value, 'authorityCarrier'), authorityDescriptorPresent: Reflect.get(value, 'authorityDescriptorPresent'),
    });
    return result.success ? result.data : undefined;
}

export function formatHomeAuthorityMismatchFacts(facts: HomeAuthorityMismatchFacts): string {
    return `authorityReason ${facts.authorityReason}; authorityPhase ${facts.authorityPhase}; authorityCarrier ${facts.authorityCarrier}; authorityDescriptorPresent ${facts.authorityDescriptorPresent}`;
}

function parseFacts(text: string): HomeAuthorityMismatchFacts | undefined {
    const match = /^authorityReason ([a-z_]+); authorityPhase ([a-z_]+); authorityCarrier ([a-z]+); authorityDescriptorPresent (true|false)$/u.exec(text);
    return match ? readHomeAuthorityMismatchFacts({ authorityReason: match[1], authorityPhase: match[2],
        authorityCarrier: match[3], authorityDescriptorPresent: match[4] === 'true' }) : undefined;
}

const message = 'The acquired enrollment runtime does not match the resolved Home authority.';
export function formatHomeAuthorityMismatchFailure(facts?: HomeAuthorityMismatchFacts): string {
    return facts ? `${message.slice(0, -1)} (${formatHomeAuthorityMismatchFacts(facts)}).` : message;
}

/** Prepared tasks retain the finite diagnostic grammar, never native prose. */
export function readHomeAuthorityMismatchFailure(code: unknown, rawMessage: unknown): Readonly<{
    code: 'HOME_AUTHORITY_MISMATCH'; message: string; details?: HomeAuthorityMismatchFailureDetailsV1;
}> | null {
    if (code !== 'HOME_AUTHORITY_MISMATCH') return null;
    const prefix = `${message.slice(0, -1)} (`;
    const facts = typeof rawMessage === 'string' && rawMessage.startsWith(prefix) && rawMessage.endsWith(').')
        ? parseFacts(rawMessage.slice(prefix.length, -2)) : undefined;
    return { code, message: formatHomeAuthorityMismatchFailure(facts),
        ...(facts ? { details: { kind: 'homeAuthorityMismatch', ...facts } } : {}) };
}

/** Existing remote request/stream grammars carry the same closed final suffix. */
export function splitHomeAuthorityMismatchSuffix(value: unknown): Readonly<{
    message: unknown; facts?: HomeAuthorityMismatchFacts;
}> {
    if (typeof value !== 'string') return { message: value };
    const start = value.lastIndexOf('; authorityReason ');
    const end = value.endsWith(').') ? value.length - 2 : value.endsWith(')') ? value.length - 1 : -1;
    const facts = start >= 0 && end > start ? parseFacts(value.slice(start + 2, end)) : undefined;
    return facts ? { message: value.slice(0, start) + value.slice(end), facts } : { message: value };
}
