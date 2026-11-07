import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

/**
 * Named Session access — Account, Team and Group grants, responsibility and
 * atomic initial access — is Session sharing: the exact Home's
 * `sharing.session` decision alone admits it. There is no partial mode.
 */
export type SessionCollaborationAvailability = 'unavailable' | 'available';
export type SessionCollaborationAvailabilityState = SessionCollaborationAvailability | 'loading';

export function resolveSessionCollaborationAvailability(sharingEnabled: boolean): SessionCollaborationAvailability {
    return sharingEnabled ? 'available' : 'unavailable';
}

/** Exact Home scope uses the feature owner's server-specific snapshot. */
export function useSessionCollaborationAvailability(serverId: string): SessionCollaborationAvailability {
    // Action admission intentionally fails closed until the exact Home decision settles.
    return resolveSessionCollaborationAvailability(useFeatureEnabled('sharing.session', { scopeKind: 'spawn', serverId }));
}

/** Retains an unresolved feature read instead of collapsing it into a settled refusal. */
export function useSessionCollaborationAvailabilityState(serverId: string): SessionCollaborationAvailabilityState {
    const decision = useFeatureDecision('sharing.session', { scopeKind: 'spawn', serverId });
    return decision === null ? 'loading' : resolveSessionCollaborationAvailability(decision.state === 'enabled');
}

/**
 * The one host-admission decision for the Collaboration destination.
 *
 * Named access is only one of the destination's children. `sharing.public` has
 * no catalog dependency on `sharing.session`, so a Home can publish links while
 * named access is off; hiding the destination there would remove the only entry
 * point publication has. Conversations needs no term of its own: the catalog
 * makes `sessions.conversations` depend on `sharing.session`, so it can never
 * outlive named access.
 */
export function resolveSessionCollaborationDestinationAvailabilityState(input: Readonly<{
    namedAccess: SessionCollaborationAvailabilityState;
    publicLink: SessionCollaborationAvailabilityState;
}>): SessionCollaborationAvailabilityState {
    if (input.namedAccess === 'available' || input.publicLink === 'available') return 'available';
    if (input.namedAccess === 'loading' || input.publicLink === 'loading') return 'loading';
    return 'unavailable';
}

export function useSessionCollaborationDestinationAvailabilityState(serverId: string): SessionCollaborationAvailabilityState {
    const namedAccess = useSessionCollaborationAvailabilityState(serverId);
    const publicLink = useFeatureDecision('sharing.public', { scopeKind: 'spawn', serverId });
    return resolveSessionCollaborationDestinationAvailabilityState({ namedAccess,
        publicLink: publicLink === null ? 'loading' : resolveSessionCollaborationAvailability(publicLink.state === 'enabled') });
}

/** Discovery/catalog admission fails closed; an already-open destination keeps the three-state owner above. */
export function useSessionCollaborationDestinationEntryAdmitted(serverId: string): boolean {
    return useSessionCollaborationDestinationAvailabilityState(serverId) === 'available';
}

export function canCreateSessionWithInitialAccess(
    access: SessionInitialAccessDraftV1 | null | undefined,
    availability: SessionCollaborationAvailability,
): boolean {
    return !access?.grants.length || availability === 'available';
}
