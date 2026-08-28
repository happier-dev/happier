import type { ComposerAttachmentAuthorValueV1 } from '@happier-dev/protocol';

import {
    createServerAccountScope,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

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

export type NewSessionComposerAttachmentSeedAddressV1 = Readonly<{
    scope: ServerAccountScope | null | undefined;
    draftId: string | null | undefined;
}>;

const seedsByScopedDraft = new Map<string, readonly NewSessionComposerAttachmentSeedV1[]>();

function normalizeDraftId(draftId: string | null | undefined): string | null {
    if (typeof draftId !== 'string') return null;
    const trimmed = draftId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function addressKey(address: NewSessionComposerAttachmentSeedAddressV1): string | null {
    const scope = address.scope
        ? createServerAccountScope(address.scope.serverId, address.scope.accountId)
        : null;
    const draftId = normalizeDraftId(address.draftId);
    if (!scope || !draftId) return null;
    return `${serverAccountScopeKeySuffix(scope)}${draftId.length}:${draftId}`;
}

export function writeNewSessionComposerAttachmentSeeds(
    address: NewSessionComposerAttachmentSeedAddressV1,
    seeds: readonly NewSessionComposerAttachmentSeedV1[],
): void {
    const key = addressKey(address);
    if (!key) return;
    if (seeds.length === 0) {
        seedsByScopedDraft.delete(key);
        return;
    }
    seedsByScopedDraft.set(key, Object.freeze([...seeds]));
}

export function readNewSessionComposerAttachmentSeeds(
    address: NewSessionComposerAttachmentSeedAddressV1,
): readonly NewSessionComposerAttachmentSeedV1[] {
    const key = addressKey(address);
    if (!key) return [];
    return seedsByScopedDraft.get(key) ?? [];
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
    address: NewSessionComposerAttachmentSeedAddressV1,
    applied: readonly NewSessionComposerAttachmentSeedV1[],
): void {
    const key = addressKey(address);
    if (!key) return;
    const pending = seedsByScopedDraft.get(key);
    if (!pending) return;
    const remaining = pending.filter((seed) => !applied.includes(seed));
    if (remaining.length === 0) seedsByScopedDraft.delete(key);
    else seedsByScopedDraft.set(key, Object.freeze(remaining));
}

export function clearAllNewSessionComposerAttachmentSeeds(): void {
    seedsByScopedDraft.clear();
}
