import type { ComposerAttachmentAuthorValueV1 } from '@happier-dev/protocol';

/**
 * The author-shaped composer attachments a seeded New Session is still waiting
 * to place, keyed by the draft they were seeded for.
 *
 * A seed can state the REQUEST for an attachment and nothing more: the
 * qualified contribution identity, the host-resolved type label, the
 * cardinality upsert and the host-minted instance id are all resolved by the
 * MOUNTED composer target, against the daemon projection for the machine the
 * reader is about to launch on. So the request waits here until that mount
 * exists, and the New Session composer applies it through the one authority
 * (`sessionComposerPresentationTargets.ts#createComposerPresentationTransactionApplier`).
 *
 * It is deliberately in memory and deliberately NOT part of the persisted
 * draft. The persisted draft carries finished `ComposerAttachmentDraftV1`
 * records, and writing a request there would make this a second, unauthoritative
 * attachment owner — the exact thing the persisted draft's own contract
 * forbids. This is the same shape the incumbent media sidecar
 * (`newSessionAttachmentDraftStore.ts`) already uses for material that is not
 * yet canonical, and it survives exactly what that survives: the navigation to
 * the New Session screen, for the lifetime of the app.
 *
 * There is no eviction ceiling because there is nothing to evict against: an
 * entry is removed the moment its attachment lands, an unapplied entry is a few
 * hundred bytes of author JSON, and the set is bounded by the number of New
 * Session drafts one app lifetime seeds.
 */

export type NewSessionComposerAttachmentSeedV1 = Readonly<{
    /**
     * The seeding plugin. The mount qualifies `(pluginId, attachmentLocalId)`
     * against its own current projection, so nothing here names a generation:
     * a seed applied under a later admitted generation of the same contribution
     * is the contribution the reader actually has.
     */
    pluginId: string;
    attachmentLocalId: string;
    value: ComposerAttachmentAuthorValueV1;
}>;

const seedsByDraftId = new Map<string, readonly NewSessionComposerAttachmentSeedV1[]>();

function normalizeDraftId(draftId: string | null | undefined): string | null {
    if (typeof draftId !== 'string') return null;
    const trimmed = draftId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function writeNewSessionComposerAttachmentSeeds(
    draftId: string | null | undefined,
    seeds: readonly NewSessionComposerAttachmentSeedV1[],
): void {
    const key = normalizeDraftId(draftId);
    if (!key) return;
    if (seeds.length === 0) {
        seedsByDraftId.delete(key);
        return;
    }
    seedsByDraftId.set(key, Object.freeze([...seeds]));
}

export function readNewSessionComposerAttachmentSeeds(
    draftId: string | null | undefined,
): readonly NewSessionComposerAttachmentSeedV1[] {
    const key = normalizeDraftId(draftId);
    if (!key) return [];
    return seedsByDraftId.get(key) ?? [];
}

/**
 * Drop the seeds that landed, keeping the ones that did not.
 *
 * A seed whose contribution the current machine's projection does not admit has
 * NOT failed — the reader may still change machine — so it stays pending rather
 * than being discarded with nothing said. Clearing it here is how a bulk
 * "attach all to New Session" would silently open a screen with fewer entries
 * than the reader chose.
 */
export function clearAppliedNewSessionComposerAttachmentSeeds(
    draftId: string | null | undefined,
    applied: readonly NewSessionComposerAttachmentSeedV1[],
): void {
    const key = normalizeDraftId(draftId);
    if (!key) return;
    const pending = seedsByDraftId.get(key);
    if (!pending) return;
    const remaining = pending.filter((seed) => !applied.includes(seed));
    if (remaining.length === 0) seedsByDraftId.delete(key);
    else seedsByDraftId.set(key, Object.freeze(remaining));
}

export function clearAllNewSessionComposerAttachmentSeeds(): void {
    seedsByDraftId.clear();
}
