import { MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_SESSION_TAIL_V1 } from '@happier-dev/protocol';

import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';

type PluginTranscriptActivityTranscriptItem = Extract<
    ChatTranscriptListItem,
    { kind: 'plugin-transcript-activity' }
>;

/** Per-mounted-transcript identity reuse; never a process-wide transcript cache. */
export type PluginTranscriptActivityTranscriptItemsCache = {
    itemsByIdentity: Map<string, PluginTranscriptActivityTranscriptItem>;
    /** Current rows retained across temporary stale LKG wrappers. */
    currentItemsByIdentity: Map<string, PluginTranscriptActivityTranscriptItem>;
};

export function createPluginTranscriptActivityTranscriptItemsCache(): PluginTranscriptActivityTranscriptItemsCache {
    return {
        itemsByIdentity: new Map(),
        currentItemsByIdentity: new Map(),
    };
}

/** One bounded Resource snapshot projected into the synthetic transcript tail. */
export type PluginTranscriptActivityLiveRow = Readonly<{
    pluginId: string;
    contributionId: string;
    generation: string;
    sessionId: string;
    resourceId: string;
    localActivityId: string;
    phase: 'running' | 'succeeded' | 'failed' | 'cancelled';
    title: string;
    status: string | null;
    progress: Readonly<{ completed: number; total: number }> | null;
    checklist: readonly Readonly<{
        id: string;
        label: string;
        state: 'pending' | 'active' | 'complete' | 'failed';
    }>[];
    dismissible: boolean;
    /** Already limited to the profile's same-plugin Action allowlist. */
    actions: readonly Readonly<{ pluginId: string; localId: string; label: string | null }>[];
    freshness: 'current' | 'stale';
}>;

/**
 * JSON preserves the six ownership fields without delimiter collisions. It is
 * UI-local identity only: it is never persisted, acknowledged, or sent back to
 * the Resource owner.
 */
export function buildPluginTranscriptActivityIdentityKey(
    activity: Pick<
        PluginTranscriptActivityLiveRow,
        'pluginId' | 'contributionId' | 'generation' | 'sessionId' | 'resourceId' | 'localActivityId'
    >,
): string {
    return JSON.stringify([
        activity.pluginId,
        activity.contributionId,
        activity.generation,
        activity.sessionId,
        activity.resourceId,
        activity.localActivityId,
    ]);
}

/**
 * The authoritative Activity Resource source for one identity. This stays
 * local to dismissal reconciliation: it is never a Resource key or a host
 * transport input.
 */
export function buildPluginTranscriptActivitySourceKey(
    activity: Pick<
        PluginTranscriptActivityLiveRow,
        'pluginId' | 'contributionId' | 'generation' | 'sessionId' | 'resourceId'
    >,
): string {
    return JSON.stringify([
        activity.pluginId,
        activity.contributionId,
        activity.generation,
        activity.sessionId,
        activity.resourceId,
    ]);
}

function compareActivities(left: PluginTranscriptActivityLiveRow, right: PluginTranscriptActivityLiveRow): number {
    const leftIdentity = buildPluginTranscriptActivityIdentityKey(left);
    const rightIdentity = buildPluginTranscriptActivityIdentityKey(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function sameDerivedItem(
    left: PluginTranscriptActivityTranscriptItem,
    right: PluginTranscriptActivityTranscriptItem,
): boolean {
    if (
        left.identityKey !== right.identityKey
        || left.phase !== right.phase
        || left.title !== right.title
        || left.status !== right.status
        || left.dismissible !== right.dismissible
        || left.freshness !== right.freshness
        || left.aggregateHiddenCount !== right.aggregateHiddenCount
        || left.progress?.completed !== right.progress?.completed
        || left.progress?.total !== right.progress?.total
        || left.checklist.length !== right.checklist.length
        || left.actions.length !== right.actions.length
    ) return false;
    return left.checklist.every((item, index) => (
        item.id === right.checklist[index]?.id
        && item.label === right.checklist[index]?.label
        && item.state === right.checklist[index]?.state
    )) && left.actions.every((action, index) => (
        action.pluginId === right.actions[index]?.pluginId
        && action.localId === right.actions[index]?.localId
        && action.label === right.actions[index]?.label
    ));
}

/**
 * Extends the incumbent external-operation derivation with another *synthetic*
 * tail only. These rows deliberately have no `seq`, no wall-clock placement,
 * and never enter history/window/anchor ownership.
 */
export function appendPluginTranscriptActivityTranscriptItems(
    base: readonly ChatTranscriptListItem[],
    input: Readonly<{
        sessionId: string;
        activities: readonly PluginTranscriptActivityLiveRow[];
        dismissedActivityIds: ReadonlySet<string>;
        /** The canonical current Session Action controller's admission result. */
        isActionAvailable: (action: Readonly<{ pluginId: string; localId: string }>) => boolean;
        /** A mount-local cache that preserves unchanged synthetic item identity. */
        cache?: PluginTranscriptActivityTranscriptItemsCache;
    }>,
): ChatTranscriptListItem[] {
    const nextItemsByIdentity = new Map<string, PluginTranscriptActivityTranscriptItem>();
    const nextCurrentItemsByIdentity = new Map<string, PluginTranscriptActivityTranscriptItem>();
    const sortedActivities = input.activities
        .filter((activity) => (
            activity.sessionId === input.sessionId
            && !input.dismissedActivityIds.has(buildPluginTranscriptActivityIdentityKey(activity))
        ))
        .slice()
        .sort(compareActivities);
    const concreteActivities = sortedActivities.slice(0, MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_SESSION_TAIL_V1);
    const hiddenCount = sortedActivities.length - concreteActivities.length;
    const rows = concreteActivities
        .map((activity): PluginTranscriptActivityTranscriptItem => {
            const identityKey = buildPluginTranscriptActivityIdentityKey(activity);
            const next = {
                kind: 'plugin-transcript-activity' as const,
                id: `plugin-transcript-activity:${encodeURIComponent(identityKey)}`,
                identityKey,
                ...activity,
                // The final transcript item is shared by both the painter and
                // the height/signature descriptor. Admission therefore cannot
                // disappear only at card render time and leave a stale row floor.
                actions: activity.actions.filter(input.isActionAvailable),
                createdAt: 0,
            };
            const prior = activity.freshness === 'current'
                ? input.cache?.currentItemsByIdentity.get(identityKey)
                : input.cache?.itemsByIdentity.get(identityKey);
            const item = prior && sameDerivedItem(prior, next) ? prior : next;
            nextItemsByIdentity.set(identityKey, item);
            if (activity.freshness === 'current') nextCurrentItemsByIdentity.set(identityKey, item);
            return item;
        });
    // Keep the aggregate bounded without silently pretending that rows beyond
    // the Preview cap do not exist. The summary is a truthful, non-dismissable
    // transcript item; it carries no fake Resource identity or actions.
    if (hiddenCount > 0) {
        rows.push({
            kind: 'plugin-transcript-activity',
            id: `plugin-transcript-activity:aggregate-overflow:${input.sessionId}`,
            identityKey: `plugin-transcript-activity:aggregate-overflow:${input.sessionId}`,
            pluginId: '',
            contributionId: '',
            generation: '',
            sessionId: input.sessionId,
            resourceId: '',
            localActivityId: '',
            phase: 'succeeded',
            title: '',
            status: null,
            progress: null,
            checklist: [],
            dismissible: false,
            actions: [],
            freshness: 'current',
            aggregateHiddenCount: hiddenCount,
            createdAt: 0,
        });
    }
    if (input.cache) {
        input.cache.itemsByIdentity = nextItemsByIdentity;
        const staleSourceKeys = new Set(rows.flatMap((row) => (
            row.freshness === 'stale' ? [buildPluginTranscriptActivitySourceKey(row)] : []
        )));
        input.cache.currentItemsByIdentity = staleSourceKeys.size === 0
            ? nextCurrentItemsByIdentity
            : new Map([
                ...[...input.cache.currentItemsByIdentity].filter(([, item]) => (
                    staleSourceKeys.has(buildPluginTranscriptActivitySourceKey(item))
                )),
                ...nextCurrentItemsByIdentity,
            ]);
    }
    return [...base, ...rows];
}
