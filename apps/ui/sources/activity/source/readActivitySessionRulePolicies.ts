import { matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { normalizeSessionFollowDefaultRulesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { buildSessionListRowFilterFacts } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionListPresentationOwnerMetadata, readSessionListRenderableOwnerMetadataView,
    type SessionPresentationRecord, type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import type { SessionPersonalRuleMatch } from '@/sync/domains/session/readState/sessionViewerAttention';

const NO_RULE_POLICIES: readonly FollowPolicyV1[] = Object.freeze([]);
const NO_RULE_MATCHES: readonly SessionPersonalRuleMatch[] = Object.freeze([]);
export function readActivityPersonalRuleSnapshot(source: Pick<ActivityAttentionSource, 'personalFollowRulesByServerId'>, serverId: string) {
    return source.personalFollowRulesByServerId?.[serverId]
        ?? Object.entries(source.personalFollowRulesByServerId ?? {}).find(([candidate]) => areServerProfileIdentifiersEquivalent(candidate, serverId))?.[1];
}

/** Presentation only: no enrollment, viewer mutation, event dispatch or second filter semantics. */
export function readActivitySessionRuleMatches(source: ActivityAttentionSource, address: SessionAddress, session: SessionPresentationRecord, nowMs: number,
    presentationSource?: SessionListPresentationSource): readonly SessionPersonalRuleMatch[] {
    const ownerMetadata = presentationSource ? readSessionListPresentationOwnerMetadata(presentationSource)
        : 'agentState' in session ? readSessionOwnerMetadataView(session) : readSessionListRenderableOwnerMetadataView(session);
    if (session.archivedAt != null || !isSessionContentReadable(readSessionContentAvailability(session))
        || (presentationSource?.metadataLayoutVersion ?? session.metadataLayoutVersion) === 1 && ownerMetadata == null) return NO_RULE_MATCHES;
    const follow = session.viewer?.follow;
    // The existing Follow facts distinguish an absent row (null) from explicit Unfollow.
    if (follow?.follows === false && follow.notificationLevel === 'none') return NO_RULE_MATCHES;
    const snapshot = readActivityPersonalRuleSnapshot(source, address.serverId);
    if (snapshot?.status !== 'ready') return NO_RULE_MATCHES;
    const defaults = snapshot.defaultPreferences ? normalizeSessionFollowDefaultRulesV1({ serverId: address.serverId,
        preferences: snapshot.defaultPreferences, relationships: follow?.defaultRelationships ?? {},
        hasPersistentFollow: follow == null ? undefined : follow.notificationLevel !== null }).rules : [];
    const rules = [...snapshot.rules.filter(rule => rule.receiver.kind === 'account' && rule.definition.enabled), ...defaults];
    if (rules.length === 0) return NO_RULE_MATCHES;
    const organizationKey = buildSessionOrganizationSessionKey(address.serverId, session.id);
    const folderAssignment = source.followRuleFolderAssignmentsBySessionKey?.[organizationKey];
    const facts = buildSessionListRowFilterFacts(session, address.serverId, {
        nowMs, presentationSource, viewerAccountId: snapshot.accountId, workspaceRefs: source.followRuleWorkspaceRefsV1,
        tagIds: source.followRuleTagAssignmentsBySessionKey?.[organizationKey]?.tagIds,
        section: folderAssignment === undefined ? undefined : folderAssignment.folderId === null
            ? null : { serverId: address.serverId, sectionId: folderAssignment.folderId },
        includeStatus: rules.some(rule => Boolean(rule.definition.filter.statuses?.length || rule.definition.filter.excludedStatuses?.length)),
        includeAgent: rules.some(rule => Boolean(rule.definition.filter.agents
            && rule.definition.filter.agents.include.length + rule.definition.filter.agents.exclude.length)),
        includeSource: rules.some(rule => rule.definition.filter.source !== 'all'),
    });
    return rules.filter(rule => matchSessionListFilterV1(rule.definition.filter, facts, 'daemonRule') === 'match')
        .map(rule => ({ policy: rule.definition.policy, ...('ruleId' in rule
            ? { rule: { ruleId: rule.ruleId, ruleVersion: rule.version } } : {}) }));
}

export function readActivitySessionRulePolicies(source: ActivityAttentionSource, address: SessionAddress, session: SessionPresentationRecord, nowMs: number): readonly FollowPolicyV1[] {
    const matches = readActivitySessionRuleMatches(source, address, session, nowMs);
    return matches.length ? matches.map(match => match.policy) : NO_RULE_POLICIES;
}
