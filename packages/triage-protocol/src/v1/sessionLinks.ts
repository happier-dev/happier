import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageSourceEntryLocalRefV1Schema, TriageTextV1ProtocolSchema, TriageEntryLocatorV1Schema } from './identity.js';
import {
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    TriageConfiguredSourceCredentialInstanceV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
} from './instances.js';

function linkInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1),
        instance,
        localRef: TriageSourceEntryLocalRefV1Schema,
        sessionId: SessionIdSchema,
        linked: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
    }, { policy: 'closed' });
}

function readInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    const common = { v: defineProtocolLiteral(1), instance };
    return defineProtocolUnion([
        defineProtocolObject({ ...common, localRef: TriageSourceEntryLocalRefV1Schema }, { policy: 'closed' }),
        defineProtocolObject({ ...common, sessionIds: defineProtocolArray(SessionIdSchema, { minItems: 1 }) }, { policy: 'closed' }),
    ]);
}

/** Source-owned relationships stay within the invocation's current Account and Home. */
export const TriageSourceLinkSessionInputV1Schema = linkInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageSourceLinkSessionConnectedAccountInputV1Schema = linkInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageSourceReadSessionLinksInputV1Schema = readInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageSourceReadSessionLinksConnectedAccountInputV1Schema = readInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageSourceLinkSessionCredentialInputV1Schema = linkInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export const TriageSourceReadSessionLinksCredentialInputV1Schema = readInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export type TriageSourceLinkSessionInputV1 = ReturnType<typeof TriageSourceLinkSessionInputV1Schema.parse>;
export type TriageSourceReadSessionLinksInputV1 = ReturnType<typeof TriageSourceReadSessionLinksInputV1Schema.parse>;

export const TriageSourceLinkSessionResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ status: defineProtocolLiteral('linked') }, { policy: 'closed' }),
    defineProtocolObject({ status: defineProtocolLiteral('unlinked') }, { policy: 'closed' }),
    defineProtocolObject({ status: defineProtocolLiteral('failed') }, { policy: 'closed' }),
]);
export type TriageSourceLinkSessionResultV1 = ReturnType<typeof TriageSourceLinkSessionResultV1Schema.parse>;

const sourceSessionLinks = defineProtocolArray(defineProtocolObject({
    localRef: TriageSourceEntryLocalRefV1Schema,
    sessionId: SessionIdSchema,
    linkedAtMs: defineProtocolNumber({ integer: true }),
    displayPath: TriageTextV1ProtocolSchema,
    locator: TriageEntryLocatorV1Schema.optional(),
}, { policy: 'closed' }));

const entrySessionLinks = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('complete'), links: sourceSessionLinks }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('partial'), links: sourceSessionLinks,
        /** Only these entries are unreadable; omission elsewhere establishes absence. */
        unavailableRefs: defineProtocolArray(TriageSourceEntryLocalRefV1Schema, { minItems: 1 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageSourceSessionLinksSliceV1 = ReturnType<typeof entrySessionLinks.parse>;

export const TriageSourceReadSessionLinksResultV1Schema = defineProtocolUnion([
    entrySessionLinks,
    defineProtocolObject({
        kind: defineProtocolLiteral('sessionSet'),
        slices: defineProtocolArray(defineProtocolObject({
            sessionId: SessionIdSchema, result: entrySessionLinks,
        }, { policy: 'closed' })),
    }, { policy: 'closed' }),
]);
export type TriageSourceReadSessionLinksResultV1 = ReturnType<typeof TriageSourceReadSessionLinksResultV1Schema.parse>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The host owns admission and validates its refusal envelope at the Action boundary. */
export function readTriageSessionSetEnvelopeV1(value: unknown): {
    result: unknown;
    refusals: ReadonlyMap<string, 'session_target_unavailable'>;
} {
    const refusals = new Map<string, 'session_target_unavailable'>();
    if (!isRecord(value) || value.kind !== 'sessionReadSet' || !Array.isArray(value.failures)) {
        return { result: value, refusals };
    }
    for (const failure of value.failures) {
        if (isRecord(failure) && typeof failure.sessionId === 'string' && isRecord(failure.result)
            && failure.result.errorCode === 'session_target_unavailable') {
            refusals.set(failure.sessionId, failure.result.errorCode);
        }
    }
    return { result: value.result, refusals };
}

/** Complete coverage requires an explicit valid slice for every admitted request operand. */
export function resolveTriageSourceSessionLinkSlicesV1(
    sessionIds: readonly string[], value: unknown,
): Extract<TriageSourceReadSessionLinksResultV1, { kind: 'sessionSet' }> {
    const { result: authored, refusals } = readTriageSessionSetEnvelopeV1(value);
    const parsed = TriageSourceReadSessionLinksResultV1Schema.safeParse(authored);
    const bySession = new Map<string, TriageSourceSessionLinksSliceV1 | null>();
    if (parsed.success && parsed.data.kind === 'sessionSet') {
        for (const { sessionId, result } of parsed.data.slices) {
            bySession.set(sessionId, bySession.has(sessionId)
                || (result.kind !== 'failed' && result.links.some(link => link.sessionId !== sessionId)) ? null : result);
        }
    }
    return { kind: 'sessionSet', slices: [...new Set(sessionIds)].map(id => {
        const sessionId = SessionIdSchema.parse(id);
        const code = refusals.get(sessionId);
        const result: TriageSourceSessionLinksSliceV1 = code !== undefined
            ? { kind: 'failed', failure: { class: 'permission', code } }
            : bySession.get(sessionId) ?? { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksIncomplete' } };
        return { sessionId, result };
    }) };
}
