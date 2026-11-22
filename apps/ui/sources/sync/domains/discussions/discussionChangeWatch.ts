import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readDiscussionChangeHintV1 } from '@happier-dev/protocol/discussions';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

export type MountedDiscussionChangeWatch = Readonly<{
    dispose(): void;
}>;

export type DiscussionMessageChanges = Readonly<{
    seqs: ReadonlySet<number>;
    exactOnly: boolean;
}>;

type ActiveWatch = Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    onInvalidated(discussionIds: readonly string[], revisions: ReadonlyMap<string, number>, readStateOnlyIds?: ReadonlySet<string>,
        docArtifactIds?: ReadonlySet<string>, messageChanges?: ReadonlyMap<string, DiscussionMessageChanges>): void;
    includeDocSourceChanges?: () => boolean;
    onSnapshotInvalidated?: () => void;
    readNotCurrent?: () => boolean;
}>;

const activeWatches = new Set<ActiveWatch>();

/**
 * Observe detailed AccountChange pages and the incumbent Home's snapshot
 * revalidation for a mounted Discussion. The Home still owns its connection
 * and cursor; this only asks the repository to reread canonical HTTP state.
 */
export function watchMountedDiscussions(input: Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    onInvalidated: ActiveWatch['onInvalidated'];
    includeDocSourceChanges?: () => boolean;
    onSnapshotInvalidated?: () => void;
    /**
     * Whether a mounted read did not succeed. Discussion and doc rows arrive through the changes
     * catch-up (`publishMountedDiscussionChanges`), so a primary-Home reconnect re-reads only then.
     */
    readNotCurrent?: () => boolean;
}>): MountedDiscussionChangeWatch {
    const watch: ActiveWatch = Object.freeze({
        scope: Object.freeze({ ...input.scope }),
        address: Object.freeze({ ...input.address }),
        onInvalidated: input.onInvalidated,
        includeDocSourceChanges: input.includeDocSourceChanges,
        onSnapshotInvalidated: input.onSnapshotInvalidated,
        readNotCurrent: input.readNotCurrent,
    });
    activeWatches.add(watch);
    const stopSnapshotWatch = input.onSnapshotInvalidated ? subscribeHomeAccountChange(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, watch.address.serverId) || event.feedPageConsumed) return;
        if (event.discussionAffects === false) return;
        // Ordinary focused wakes are followed by their detailed page. A blocked
        // cursor/snapshot repair instead requests current projections without
        // claiming that the missing historical page was materialized. A local
        // receipt with known kinds (no source, e.g. an Artifact write's socket
        // receipt) is not a repair either: its Account wake follows, as the
        // detailed page on the focused Home or a `socket` wake elsewhere.
        if ((event.source === 'catch-up-pending' || event.source === undefined) && event.changeKinds !== undefined) return;
        if (event.changeKinds !== undefined && !event.changeKinds.includes('discussion')
            && !(event.changeKinds.includes('artifact') && watch.includeDocSourceChanges?.())) return;
        watch.onSnapshotInvalidated?.();
    }, { includeCatchUpPending: true, serverIds: [watch.address.serverId], reconnect: { readNotCurrent: () => watch.readNotCurrent?.() === true } }) : undefined;
    let disposed = false;
    return Object.freeze({
        dispose(): void {
            if (disposed) return;
            disposed = true;
            activeWatches.delete(watch);
            stopSnapshotWatch?.();
        },
    });
}

/**
 * Called by the one changes-page application path before checkpointing. A
 * narrow read is safe when the page follows any coalesced resource change.
 */
export function publishMountedDiscussionChanges(input: Readonly<{
    serverId: string;
    accountId: string;
    changes: readonly ApiChangeEntry[];
    afterCursor?: number;
}>): void {
    if (activeWatches.size === 0) return;
    const revisions = new Map<string, number>();
    const readStateOnly = new Map<string, boolean>();
    const messageChanges = new Map<string, DiscussionMessageChanges>();
    const after = input.afterCursor ?? 0;
    for (const change of input.changes) {
        if (change.kind !== 'discussion') continue;
        revisions.set(change.entityId, Math.max(revisions.get(change.entityId) ?? 0, change.cursor));
        const hint = readDiscussionChangeHintV1(change.hint);
        readStateOnly.set(change.entityId, readStateOnly.get(change.entityId) !== false
            && hint?.changes.readState === true && hint.changes.resource !== true);
        const messages = hint?.messageChanges;
        if (!messages) continue;
        const seqs = new Set(messages.previous.filter(row => row.cursor > after).map(row => row.seq));
        if (messages.latestSeq !== undefined) seqs.add(messages.latestSeq);
        if (seqs.size > 0) messageChanges.set(change.entityId, {
            seqs,
            exactOnly: messages.latestSeq !== undefined && messages.previousResourceCursor <= after,
        });
    }
    const readStateOnlyIds = new Set([...readStateOnly].filter(([, only]) => only).map(([id]) => id));
    const discussionIds = [...revisions.keys()];
    const discussionChanged = discussionIds.length > 0;
    const docArtifactIds = new Set(input.changes.filter(change => change.kind === 'artifact').map(change => change.entityId));
    const docChanged = docArtifactIds.size > 0;
    if (!discussionChanged && !docChanged) return;

    for (const watch of [...activeWatches]) {
        if (
            input.accountId !== watch.scope.accountId
            || !areServerProfileIdentifiersEquivalent(input.serverId, watch.address.serverId)
        ) {
            continue;
        }
        if (!discussionChanged && !(docChanged && watch.includeDocSourceChanges?.())) continue;
        try {
            if (messageChanges.size > 0) watch.onInvalidated(discussionIds, revisions, readStateOnlyIds, docArtifactIds, messageChanges);
            else if (docChanged) watch.onInvalidated(discussionIds, revisions, readStateOnlyIds, docArtifactIds);
            else if (readStateOnlyIds.size > 0) watch.onInvalidated(discussionIds, revisions, readStateOnlyIds);
            else watch.onInvalidated(discussionIds, revisions);
        } catch {
            // A presentation refresh cannot suppress sibling observers or the
            // AccountChange owner's own canonical materialization/checkpoint.
        }
    }
}
