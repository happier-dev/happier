import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import type { ActiveServerSnapshot, ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

export type ActivityAttentionSource = Readonly<{
    isDataReady: boolean;
    sessionsById: Readonly<Record<string, Session>>;
    sessionListRenderablesById: Readonly<Record<string, SessionListRenderableSession>>;
    sessionListIndexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    sessionMessagesById?: StorageState['sessionMessages'];
    serverProfilesById?: Readonly<Record<string, ServerProfile | null | undefined>>;
    activeServer?: Pick<ActiveServerSnapshot, 'serverId' | 'serverUrl' | 'generation'> | null;
}>;
