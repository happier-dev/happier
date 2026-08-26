import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

import {
    TriageIdentifierV1ProtocolSchema,
    TriageSourceWorkflowSubjectV1Schema,
    TriageTextV1ProtocolSchema,
} from './identity.js';

/**
 * @internal One declared source-local entry kind. Kind entries are closed: a
 * kind carries routing and admission authority because every emitted local ref
 * is validated against this declared vocabulary (`CONTRACT.md` §3).
 */
export const TriageSourceKindDescriptorV1ProtocolSchema = defineProtocolObject({
    id: TriageIdentifierV1ProtocolSchema,
    workflowSubject: TriageSourceWorkflowSubjectV1Schema,
    displayName: TriageTextV1ProtocolSchema,
    pluralDisplayName: TriageTextV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/**
 * The source's presentation, declared Connected Account purpose, and
 * source-local kind vocabulary.
 *
 * The outer object is `additive-open/drop`: an unknown outer property is
 * bounded presentation and is dropped rather than rejected (`CONTRACT.md` §8).
 * The nested kind entries stay closed because they carry admission authority.
 * `kinds[].id` uniqueness is a keyed invariant the target enforces over the
 * parsed value (`CONTRACT.md` §2.4); the public algebra has no keyed helper.
 */
export const TriageSourceDescriptorV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    purpose: TriageIdentifierV1ProtocolSchema,
    displayName: TriageTextV1ProtocolSchema,
    kinds: defineProtocolArray(TriageSourceKindDescriptorV1ProtocolSchema, {
        minItems: 1,
    }),
    /**
     * The local id of the source's OWN `settingsPages[]` entry for putting
     * itself into PRs & Issues.
     *
     * It is a bare local id rather than a qualified reference because the only
     * page a source may nominate is one of its own: the target qualifies it
     * with the contributor identity it already holds for the admitted
     * contribution, so a source cannot name another plugin's page and the
     * target never has to trust a plugin id a descriptor supplied.
     *
     * It exists because a target with nothing configured has nowhere to send
     * the reader. The descriptor named no page, so the empty screen could only
     * describe the remedy in prose while every source already shipped the page
     * it was describing.
     *
     * **Optional, and it has to stay optional.** A source that ships no such
     * page is a source with no offer to make, not one the target refuses to
     * admit — and a required field would have made every descriptor already in
     * the wild inadmissible. A target that reads it renders the offer only
     * when it is present.
     */
    settingsPageId: TriageIdentifierV1ProtocolSchema.optional(),
}, { policy: 'additive-open/drop' });
export type TriageSourceDescriptorV1 = ReturnType<typeof TriageSourceDescriptorV1Schema.parse>;

export type TriageSourceDescriptorAdmissionV1 =
    | Readonly<{ ok: true; descriptor: TriageSourceDescriptorV1 }>
    | Readonly<{ ok: false; reason: 'invalid' | 'duplicateKindId' }>;

/**
 * The target-owned semantic admission for one source descriptor.
 *
 * The public protocol algebra owns structural parsing and JSON Schema
 * projection, but has no keyed-array uniqueness primitive. Triage owns this
 * one keyed invariant directly: consumers receive either one unambiguous kind
 * vocabulary or no admitted descriptor, never first-match behavior.
 */
export function admitTriageSourceDescriptorV1(input: unknown): TriageSourceDescriptorAdmissionV1 {
    const parsed = TriageSourceDescriptorV1Schema.safeParse(input);
    if (!parsed.success) return Object.freeze({ ok: false, reason: 'invalid' });
    const kindIds = parsed.data.kinds.map((kind) => kind.id);
    if (new Set(kindIds).size !== kindIds.length) {
        return Object.freeze({ ok: false, reason: 'duplicateKindId' });
    }
    return Object.freeze({ ok: true, descriptor: parsed.data });
}
