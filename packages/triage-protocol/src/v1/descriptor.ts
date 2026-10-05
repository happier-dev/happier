import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    TRIAGE_DETAIL_ACTIONS_PANEL_V1,
    TRIAGE_DETAIL_SHARED_TABS_V1,
} from './bounds.js';
import {
    TriageIdentifierV1ProtocolSchema,
    TriageSourceWorkflowSubjectV1Schema,
    TriageTextV1ProtocolSchema,
} from './identity.js';

/**
 * One tab a source's detail offers for an entry kind (r0.42).
 *
 * `shared` names a tab of the target's vocabulary: the target owns its title,
 * order and frame, and the source renders its content when asked for that
 * `panel`. `source` is a view only this source has (a stack trace, occurrences,
 * a release); the source names it, and the target renders it after the shared
 * tabs in declared order. Both are closed: a tab id routes a mount.
 */
export const TriageSourceDetailTabV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('shared'),
        id: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_DETAIL_SHARED_TABS_V1[0]),
            defineProtocolLiteral(TRIAGE_DETAIL_SHARED_TABS_V1[1]),
            defineProtocolLiteral(TRIAGE_DETAIL_SHARED_TABS_V1[2]),
            defineProtocolLiteral(TRIAGE_DETAIL_SHARED_TABS_V1[3]),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('source'),
        id: TriageIdentifierV1ProtocolSchema,
        title: TriageTextV1ProtocolSchema,
        /** Resolved through the source's admitted translation projection; title is the fallback. */
        titleKey: TriageTextV1ProtocolSchema.optional(),
    }, { policy: 'closed' }),
]);
export type TriageSourceDetailTabV1 = ReturnType<typeof TriageSourceDetailTabV1Schema.parse>;

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
    /**
     * The detail tabs this kind supports (r0.42). Absent: the source keeps its
     * whole detail body, mounted without a `panel`, exactly as before.
     */
    detailTabs: defineProtocolArray(TriageSourceDetailTabV1Schema, {
        minItems: 1,
    }).optional(),
    /**
     * This kind's write controls render as the `actions` panel, which the
     * target places in the detail header (r0.42). Only meaningful with
     * `detailTabs`; a whole-detail source keeps its controls in its body.
     */
    detailActions: defineProtocolLiteral(true).optional(),
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
    | Readonly<{ ok: false; reason: 'invalid' | 'duplicateKindId' | 'duplicateDetailTabId' }>;

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
    // A tab id is what a `panel` request names, so one kind's tab ids must be
    // one unambiguous set: shared and source ids share the namespace.
    for (const kind of parsed.data.kinds) {
        const tabs = kind.detailTabs ?? [];
        const tabIds = tabs.map((tab) => tab.id);
        const reusesSharedId = tabs.some((tab) => tab.kind === 'source'
            && ((TRIAGE_DETAIL_SHARED_TABS_V1 as readonly string[]).includes(tab.id)
                || tab.id === TRIAGE_DETAIL_ACTIONS_PANEL_V1));
        if (reusesSharedId || new Set(tabIds).size !== tabIds.length) {
            return Object.freeze({ ok: false, reason: 'duplicateDetailTabId' });
        }
    }
    return Object.freeze({ ok: true, descriptor: parsed.data });
}
