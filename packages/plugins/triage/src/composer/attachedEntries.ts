import type { ComposerAttachmentViewV1, ComposerReadResultV1, PluginUiIconTokenV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRefV1, TriageSourceInstanceRefV1 } from '@happier-dev/triage-protocol/v1';

import {
    TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1,
    deriveTriageComposerEntryAttachmentKey,
    parseTriageComposerEntryAttachmentValue,
} from './attachmentValue.js';

/**
 * The one reader of Triage attachment state inside a canonical composer
 * snapshot (`core/COMPOSER.md` §1.2).
 *
 * The picker's current selection and the compact control's zero/one/many state
 * are two views of the same canonical facts, so they share this one projection.
 * Neither keeps a chip list, an attachment count, or any other selected-items
 * store: a second store would survive a host badge removal, an undo, or a
 * closed scope and then claim attachments the message will not carry.
 */

export type TriageAttachedEntryIdentityV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
}>;

export type TriageAttachedEntryV1 = Readonly<{
    /** The host-minted instance identity a removal addresses. */
    instanceId: string;
    /** The persisted canonical key; the picker matches corpus rows against it. */
    key: string;
    /**
     * `null` when the persisted value no longer parses under the currently
     * admitted declaration. The record still exists in the draft, so it is still
     * counted and still removable; it simply cannot be matched back to a corpus
     * row by identity.
     */
    identity: TriageAttachedEntryIdentityV1 | null;
    availability: ComposerAttachmentViewV1['availability'];
    /** The host-frozen immutable fallback presentation; never fresh context. */
    presentation: ComposerAttachmentViewV1['presentation'];
}>;

/**
 * Which icon the compact control renders.
 *
 * `declaration` means the icon the Triage manifest declared for this control;
 * resolving it to a concrete token is the manifest's job, not this projection's,
 * so the declaration keeps one owner and no icon literal is duplicated here.
 */
export type TriageEntriesCompactIconV1 =
    | Readonly<{ kind: 'declaration' }>
    | Readonly<{ kind: 'admitted'; token: PluginUiIconTokenV1 }>;

export type TriageEntriesCompactLabelV1 =
    | Readonly<{ kind: 'staticTitle' }>
    | Readonly<{ kind: 'entry'; text: string }>
    | Readonly<{ kind: 'count'; count: number }>;

export type TriageEntriesCompactStateV1 = Readonly<{
    kind: 'none' | 'one' | 'many';
    selected: boolean;
    label: TriageEntriesCompactLabelV1;
    icon: TriageEntriesCompactIconV1;
}>;

const DECLARATION_ICON: TriageEntriesCompactIconV1 = Object.freeze({ kind: 'declaration' });

/**
 * The truthful state when no canonical snapshot is in hand: still loading, a
 * typed unavailability, or a transport failure. It is exactly the zero state —
 * a remembered count here would keep claiming attachments after the addressed
 * scope closed.
 */
const STATIC_FALLBACK: TriageEntriesCompactStateV1 = Object.freeze({
    kind: 'none',
    selected: false,
    label: Object.freeze({ kind: 'staticTitle' }) as TriageEntriesCompactLabelV1,
    icon: DECLARATION_ICON,
});

/** Every Triage `entry` record in one canonical snapshot, in snapshot order. */
export function selectTriageAttachedEntries(
    attachments: readonly ComposerAttachmentViewV1[],
): readonly TriageAttachedEntryV1[] {
    const attached: TriageAttachedEntryV1[] = [];
    for (const record of attachments) {
        if (
            record.attachment.pluginId !== TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1.pluginId
            || record.attachment.localId !== TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1.localId
        ) {
            continue;
        }
        const parsed = parseTriageComposerEntryAttachmentValue(record.value);
        attached.push({
            instanceId: record.instanceId,
            key: record.key,
            identity: parsed.status === 'valid'
                ? { entryRef: parsed.value.entryRef, sourceInstance: parsed.value.sourceInstance }
                : null,
            availability: record.availability,
            presentation: record.presentation,
        });
    }
    return attached;
}

/**
 * The attached record for one corpus row, matched through the persisted key.
 *
 * The key rather than the parsed value is the match, so a record whose value no
 * longer parses is still recognized as attached and still offers Remove.
 */
export function findTriageAttachedEntry(
    attached: readonly TriageAttachedEntryV1[],
    entryRef: TriageEntryRefV1,
): TriageAttachedEntryV1 | null {
    const key = deriveTriageComposerEntryAttachmentKey(entryRef);
    return attached.find((entry) => entry.key === key) ?? null;
}

/**
 * The compact control's zero/one/many state, derived from one canonical read.
 *
 * A matching record is counted even when its projected presentation is
 * unavailable or invalid, because it still exists in the draft and the message
 * would still carry it.
 */
export function projectTriageEntriesCompactState(
    read: ComposerReadResultV1 | null,
): TriageEntriesCompactStateV1 {
    if (read === null || read.status !== 'ready') return STATIC_FALLBACK;

    const attached = selectTriageAttachedEntries(read.snapshot.attachments);
    if (attached.length === 0) return STATIC_FALLBACK;

    const only = attached.length === 1 ? attached[0] : undefined;
    if (only) {
        const icon = only.presentation.icon;
        return {
            kind: 'one',
            selected: true,
            label: { kind: 'entry', text: only.presentation.label },
            icon: icon === undefined ? DECLARATION_ICON : { kind: 'admitted', token: icon },
        };
    }
    return {
        kind: 'many',
        selected: true,
        label: { kind: 'count', count: attached.length },
        icon: DECLARATION_ICON,
    };
}
