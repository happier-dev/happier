import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import {
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceInstanceRefV1Schema,
} from '@happier-dev/triage-protocol/v1';
import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import { sameTriageSourceIdentity } from '../corpus/identity/components.js';

/**
 * The private value and key of the one Triage composer entry attachment
 * (`core/COMPOSER.md` §1.1).
 *
 * Both facts are deliberately plugin-private. They travel only inside the
 * incumbent composer draft/structured-input envelope, so the generic Session
 * message envelope encrypts them with the rest of `MessageContent`; nothing
 * here is copied into a server-readable index, relation or projection.
 */

/** The one attachment contribution local id declared by the Triage manifest. */
export const TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 = 'entry';

/**
 * The one composer control contribution local id declared by the Triage
 * manifest. It is deliberately not the attachment's id: the control is the
 * affordance that opens the picker, the attachment is what the draft carries,
 * and a mount naming one is never a mount for the other.
 */
export const TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1 = 'entries';

/**
 * The qualified identity every canonical attachment record carries. It is the
 * only thing that distinguishes a Triage attachment inside a shared composer
 * snapshot, so both the picker's current-instance projection and the compact
 * control filter through this one constant rather than a local spelling.
 */
export const TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
});

/**
 * The domain of the attachment key. It is its own domain and deliberately
 * unkeyed: the key must be identical in both Account modes and after a
 * Collection tag reprojection, so it can carry no Account key material and no
 * storage tag.
 */
const TRIAGE_ENTRY_ATTACHMENT_KEY_DOMAIN_V1 = 'happier:triage:composer-entry-attachment-key:v1';

export type TriageComposerEntryAttachmentValueV1 = Readonly<{
    v: 1;
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
    lastKnownLocator?: TriageEntryLocatorV1;
}>;

/**
 * The private, strict value schema the Triage manifest declares for its one
 * `entry` attachment.
 *
 * It is composed from the canonical published refs rather than restating their
 * grammar, so the source contract stays the one owner of what an entry ref and a
 * configured-instance ref are. Agreement between the two sources is not
 * expressible in a closed object shape, so it lives one layer up in
 * `parseTriageComposerEntryAttachmentValue`, which is the only reader of a
 * persisted value and the gate every write passes through before it is planned.
 *
 * `lastKnownLocator` is the one routing HINT the record carries, and it is
 * exactly the canonical published locator — bounded by the source contract, not
 * by a second grammar spelled here. It exists because `get` is defined over an
 * exact configured connection plus a local ref, and an ACCOUNT-WIDE connection
 * names no provider scope at all: without the last locator the target observed
 * for this entry, a perfectly valid attachment resolves `unresolved` on every
 * dispatch, forever. It grants no authority and decides nothing — the source is
 * still the only parser of its own opaque `routingToken`, still reauthorizes the
 * exact attached account, and the resolver still refuses any answer whose
 * immutable identity is not the one that was attached. A stale hint therefore
 * produces a refusal the reader can act on, never an operation against another
 * entry that happens to occupy the same route.
 */
export const TriageComposerEntryAttachmentValueV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    entryRef: TriageEntryRefV1Schema,
    sourceInstance: TriageSourceInstanceRefV1Schema,
    lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
}, { policy: 'closed' });

export type TriageComposerEntryAttachmentParseResultV1 =
    | Readonly<{ status: 'valid'; value: TriageComposerEntryAttachmentValueV1 }>
    | Readonly<{ status: 'invalid'; reason: 'shape' | 'sourceMismatch' }>;

/**
 * The one canonical attachment key for one entry.
 *
 * It is a framed digest rather than a joined identifier because
 * `collisionScope` and `entryId` are bounded provider strings that admit any
 * byte: a joined spelling silently merges `{ 'origin␟region', '42' }` with
 * `{ 'origin', '␟region42' }`, and attaching the second entry would then
 * replace the first in place through the composer's own dedupe rule. The joined
 * form is also unbounded — four contract-valid 256-byte identifiers exceed the
 * 512 code-point attachment-key ceiling — while the digest is always 43
 * characters.
 *
 * The configured instance is deliberately not an input, and neither is the
 * routing hint. One entry attached twice, through two connections or after its
 * repository moved, is one attachment: the qualified identity plus this key is
 * what makes the repeat update in place instead of adding a second selection of
 * the same entry. Routing is mutable; identity is not, and only identity keys.
 */
export function deriveTriageComposerEntryAttachmentKey(entryRef: TriageEntryRefV1): string {
    return computeCanonicalDomainSeparatedDigest(TRIAGE_ENTRY_ATTACHMENT_KEY_DOMAIN_V1, [
        entryRef.source.pluginId,
        entryRef.source.localId,
        entryRef.kindId,
        entryRef.collisionScope,
        entryRef.entryId,
    ]);
}

/**
 * The only parser of a persisted Triage attachment value.
 *
 * Source agreement is checked here rather than in the schema because the attached
 * instance decides which connected account the dispatch resolver reauthorizes:
 * an instance of another source could never have observed this entry, so the
 * pair is a refusal rather than a substitution.
 */
export function parseTriageComposerEntryAttachmentValue(
    value: unknown,
): TriageComposerEntryAttachmentParseResultV1 {
    const parsed = TriageComposerEntryAttachmentValueV1Schema.safeParse(value);
    if (!parsed.success) return { status: 'invalid', reason: 'shape' };

    const candidate = parsed.data as TriageComposerEntryAttachmentValueV1;
    const { entryRef, sourceInstance } = candidate;
    if (!sameTriageSourceIdentity(sourceInstance.source, entryRef.source)) {
        return { status: 'invalid', reason: 'sourceMismatch' };
    }
    return { status: 'valid', value: candidate };
}
