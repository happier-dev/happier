import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import type { SessionListHomeObservationByServerId } from '@/sync/domains/session/listing/sessionListHomeObservation';
import type { ActiveServerSnapshot, ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { SessionFollowRulesSnapshot } from '@/sync/api/session/sessionFollowRulesApi';
import type { ActivityPersonalSessionMembership } from './activityPersonalSessionMembership';

export type ActivityAttentionSource = Readonly<{
    audienceScopes?: ReadonlyMap<string, ServerAccountScope>;
    audienceLabelsVersion?: string;
    isDataReady: boolean;
    personalFollowRulesByServerId?: Readonly<Record<string, SessionFollowRulesSnapshot>>;
    accountDeliveryMutesByServerId?: ActivityPersonalSessionMembership['accountDeliveryMutesByServerId'];
    sessionsById: Readonly<Record<string, Session>>;
    sessionListRowsByServerId: StorageState['sessionListRowsByServerId'];
    ordinarySessionListMembershipByServerId: StorageState['ordinarySessionListMembershipByServerId'];
    /**
     * Activity-owned membership returned by the canonical strict `my_work`
     * query for each exact Home. Rows remain in the shared row cache; a complete
     * exact-Home query replaces ordinary candidacy, while incomplete or absent
     * query coverage preserves ordinary last-known-good candidates.
     */
    personalSessionListMembershipByServerId?: Readonly<Record<string, readonly string[]>>;
    /** Loaded rows from the authorized rule query; these are candidates, never `my_work` membership. */
    ruleSessionMembershipByServerId?: Readonly<Record<string, readonly string[]>>;
    /** Existing query-controller truth; consumers must not infer completeness from retained rows. */
    personalSessionListQueryStatesByServerId?: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    personalSessionListCoverageComplete?: boolean;
    sessionListIndexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    /** Query-aware exact-Home freshness shared with Session rows. */
    sessionListHomeObservationByServerId?: SessionListHomeObservationByServerId;
    sessionMessagesById?: StorageState['sessionMessages'];
    /** Canonical Account workspace names used by every Activity-derived surface. */
    workspaceRefsV1?: ReadonlyArray<WorkspaceRefV1>;
    /** Rule facts require the complete current Account census; display may retain stale names. */
    followRuleWorkspaceRefsV1?: ReadonlyArray<WorkspaceRefV1>;
    /** Explicit loaded assignments only; an absent entry is not a proven empty tag set. */
    followRuleTagAssignmentsBySessionKey?: StorageState['sessionOrganizationTagAssignmentsBySessionKey'];
    /** An absent entry is unavailable; a loaded null folder is a proven empty Section. */
    followRuleFolderAssignmentsBySessionKey?: StorageState['sessionOrganizationFolderAssignmentsBySessionKey'];
    /** Canonical fallback presentation preference when a workspace has no custom name. */
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    serverProfilesById?: Readonly<Record<string, ServerProfile | null | undefined>>;
    activeServerId?: string | null;
    activeServer?: Pick<ActiveServerSnapshot, 'serverId' | 'serverUrl' | 'generation'> | null;
}>;
