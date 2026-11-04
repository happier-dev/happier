import type { SessionOrganizationListViewState } from '../organization/viewState';
import { captureServerProfileScopeResolver, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '../sessionAddress';

const NO_HIDDEN_SESSIONS: ReadonlySet<string> = new Set();
export type SessionRecordingVisibility = ((address: Readonly<{ sessionId: string; serverId?: string | null }>) => boolean)
    & Readonly<{ cacheKey: string }>;
export const ALL_SESSIONS_RECORDING_VISIBLE: SessionRecordingVisibility = Object.assign(() => true, { cacheKey: 'all-visible' });
const ALL_TAGS_VISIBLE = () => true;
let nextSnapshotId = 0;

/** One Home-qualified tag policy for list projections and incidental Session identities. */
export function createSessionRecordingVisibility(
    recording: boolean,
    hiddenTagIdsByServerId: Readonly<Record<string, readonly string[]>>,
    readTagIds: (address: SessionAddress) => readonly string[],
    activeServerId = '',
    resolveHome: ProfileScopeResolver = captureServerProfileScopeResolver(),
): SessionRecordingVisibility {
    const visibleTags = createRecordingTagVisibility(recording, hiddenTagIdsByServerId, resolveHome);
    if (visibleTags === ALL_TAGS_VISIBLE) return ALL_SESSIONS_RECORDING_VISIBLE;
    const visible: (address: Parameters<SessionRecordingVisibility>[0]) => boolean = address => {
        const serverId = resolveHome(address.serverId || activeServerId);
        return visibleTags(serverId, () => readTagIds({ serverId, sessionId: address.sessionId }));
    };
    // SelectionList's existing result cache requires an explicit string invalidation key.
    return Object.assign(visible, { cacheKey: `recording-${++nextSnapshotId}` });
}

function createRecordingTagVisibility(recording: boolean,
    hiddenTagIdsByServerId: Readonly<Record<string, readonly string[]>>, resolveHome: ProfileScopeResolver,
): (serverId: string, readTagIds: () => readonly string[]) => boolean {
    if (!recording) return ALL_TAGS_VISIBLE;
    const tagsByHome = new Map<string, Set<string>>();
    for (const [serverId, tagIds] of Object.entries(hiddenTagIdsByServerId)) {
        const home = resolveHome(serverId) || serverId;
        const tags = tagsByHome.get(home) ?? new Set<string>();
        for (const tagId of tagIds) tags.add(tagId);
        if (tags.size) tagsByHome.set(home, tags);
    }
    if (!tagsByHome.size) return ALL_TAGS_VISIBLE;
    return (serverId, readTagIds) => {
        const hiddenTags = tagsByHome.get(serverId);
        return !hiddenTags || !readTagIds().some(tagId => hiddenTags.has(tagId));
    };
}

/** Join the existing Home-local tag and address projections without parsing opaque Session keys. */
export function readRecordingHiddenSessionKeys(
    recording: boolean,
    hiddenTagIdsByServerId: Readonly<Record<string, readonly string[]>>,
    organization: Pick<SessionOrganizationListViewState, 'sessionTagIdsBySessionKey' | 'orderItemAddressByItemKey'>,
): ReadonlySet<string> {
    if (!recording) return NO_HIDDEN_SESSIONS;
    // Read the existing list's address projection; opaque Session keys are never decoded.
    const resolveHome = captureServerProfileScopeResolver();
    const visibleTags = createRecordingTagVisibility(recording, hiddenTagIdsByServerId, resolveHome);
    if (visibleTags === ALL_TAGS_VISIBLE) return NO_HIDDEN_SESSIONS;
    const hidden = new Set<string>();
    for (const [key, tagIds] of Object.entries(organization.sessionTagIdsBySessionKey)) {
        const address = organization.orderItemAddressByItemKey[key];
        if (address?.itemKind !== 'session') continue;
        if (!visibleTags(resolveHome(address.serverId), () => tagIds)) hidden.add(key);
    }
    return hidden.size ? hidden : NO_HIDDEN_SESSIONS;
}
