import { AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { serverAccountScopedResourceKey } from '../scope/serverAccountScope';
import type { InboxArtifactEntry } from './inboxArtifacts';

export type EnvironmentHealthNoticeEntries = Record<string, InboxArtifactEntry>;
export type EnvironmentHealthNotices = Record<string, EnvironmentHealthNoticeEntries>;

/** Routing membership only. A header awaiting its body is never a displayed health fact. */
export function healthNoticeEnvironmentKey(entry: InboxArtifactEntry | null | undefined): string | null {
    if (!entry?.noticeFamily) return null;
    const artifact = entry.artifact;
    if (!artifact.sourceServerId || !artifact.ownerAccountId || artifact.access !== 'owner'
        || artifact.publicAudience !== 'none') return null;
    const parsed = entry.notice ? null : AccountNoticeArtifactHeaderV1Schema.safeParse(artifact.rawHeader ?? artifact.header);
    const header = entry.notice?.header ?? (parsed?.success ? parsed.data : null);
    if (!header || header.source.kind !== 'host' || header.source.topic !== 'service_health'
        || !header.page || !('kind' in header.page) || !header.page.environment
        || header.page.environment.serverId !== artifact.sourceServerId) return null;
    return serverAccountScopedResourceKey({ serverId: artifact.sourceServerId, accountId: artifact.ownerAccountId },
        header.page.environment.environmentId);
}

/** Called at Artifact admission for changed ids, never by a page scanning the Account. */
export function patchEnvironmentHealthNotices(
    groups: EnvironmentHealthNotices, baseline: EnvironmentHealthNotices, id: string,
    before: InboxArtifactEntry | undefined, next: InboxArtifactEntry | null,
): EnvironmentHealthNotices {
    const previousKey = healthNoticeEnvironmentKey(before);
    const nextKey = healthNoticeEnvironmentKey(next);
    for (const key of new Set([previousKey, nextKey])) {
        if (key === null) continue;
        const current = groups[key];
        const entry = key === nextKey ? next : null;
        if (!entry && !current?.[id]) continue;
        const rows = { ...current };
        if (entry) rows[id] = entry; else delete rows[id];
        if (groups === baseline) groups = { ...groups };
        // Each bucket is an immutable input for one Environment's subscription.
        if (Object.keys(rows).length) groups[key] = rows; else delete groups[key];
    }
    return groups;
}
