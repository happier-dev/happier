import * as React from 'react';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import { teamSessionsPath } from '@/components/settings/teams/teamsRoutes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { admitOpaqueInternalReturnPath } from '@/utils/path/routeUtils';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    usePortableHomeLinkTarget,
    type PortableHomeLinkTargetState,
} from '@/components/teams/join/teamJoinTarget';

/**
 * Which Home a public `/teams/:teamId/sign-in` link addresses.
 *
 * The Team page is scoped entry into one exact Home, so the Home must come from
 * the link rather than from whichever Home this device happens to have focused.
 * Child 02 §7.1 is explicit that "a device-local `ServerProfile.id` query value
 * is not a portable Home address": a profile id is local routing storage that
 * differs per device, so a link carrying one is unusable on the phone the person
 * actually opens it on.
 *
 * The portable carrier is therefore resolved through the same owner the join
 * link uses — there is one explicit-target carrier and one resolver for it, not
 * an invitation copy and a sign-in copy. The device-local `serverId` remains
 * accepted because in-app navigation and the OAuth `returnTo` still address the
 * already-adopted Home that way; it is a same-device convenience, never the
 * portable form.
 *
 * A Home this device has not adopted is not a failure. Unlike a join link, a
 * Team sign-in URL carries no bearer, so nothing secret is at stake — but the
 * entry projection still has to be requested from a Home whose identity this
 * build can verify, and adopting one is the existing Homes acquisition flow.
 * A member sign-in link carries that Home's full descriptor exactly as an
 * invitation does, so this consumes the same acquisition lifecycle the join
 * screen does rather than discarding the descriptor and asking the person to
 * find the Home by hand.
 */
export type TeamSignInHome =
    /**
     * The link named a Home this build can address. `savedProfileId` is null on
     * a device that has not adopted it: the target is still exact, it simply
     * has no local credential, which is the ordinary anonymous entry case.
     */
    | Readonly<{ kind: 'resolved'; target: HomeTargetInput; savedProfileId: string | null }>
    /** More than one saved profile claims that identity; picking one would guess. */
    | Readonly<{ kind: 'ambiguous' }>
    /** A real Home this device has not adopted, and cannot address from the link alone. */
    | Readonly<{ kind: 'unknown_home'; homeServerIdentityId: string }>
    /** The descriptor's Home is being observed and adopted; the link stays put. */
    | Extract<PortableHomeLinkTargetState, { kind: 'acquiring' | 'acquisition_failed' }>
    /** No usable Home carrier at all. */
    | Readonly<{ kind: 'unresolved' }>;

const UNRESOLVED: TeamSignInHome = Object.freeze({ kind: 'unresolved' as const });
const AMBIGUOUS: TeamSignInHome = Object.freeze({ kind: 'ambiguous' as const });

export function resolveTeamSignInHome(params: Readonly<{
    /** The portable explicit-target carrier from the link. */
    carrier?: string | null;
    /**
     * The Homes acquisition owner's live answer for that carrier. The carrier is
     * never re-resolved here: `usePortableHomeLinkTarget` is the single owner of
     * descriptor parsing, identity observation and adoption, and this projects
     * its state into the Team page's vocabulary.
     */
    linkTarget?: PortableHomeLinkTargetState | null;
    /** Device-local profile reference used by in-app navigation and OAuth return. */
    serverId?: string | null;
}>): TeamSignInHome {
    const carrier = String(params.carrier ?? '').trim();
    if (carrier) {
        const resolved = params.linkTarget ?? UNRESOLVED;
        if (resolved.kind === 'ambiguous') return AMBIGUOUS;
        if (resolved.kind === 'unknown_home') {
            return { kind: 'unknown_home', homeServerIdentityId: resolved.homeServerIdentityId };
        }
        if (resolved.kind === 'acquiring' || resolved.kind === 'acquisition_failed') return resolved;
        if (resolved.kind === 'unresolved') return UNRESOLVED;
        return {
            kind: 'resolved',
            target: resolved.target,
            // Only a saved-profile target has a device-local credential to read.
            savedProfileId: resolved.target.kind === 'saved_profile'
                ? resolved.target.profileRef
                : null,
        };
    }

    const serverId = String(params.serverId ?? '').trim();
    if (!serverId) return UNRESOLVED;
    const profile = getServerProfileById(serverId);
    if (!profile) return { kind: 'unknown_home', homeServerIdentityId: serverId };
    return {
        kind: 'resolved',
        target: { kind: 'saved_profile', profileRef: profile.id },
        savedProfileId: profile.id,
    };
}

/**
 * The live Home binding the Team sign-in page consumes.
 *
 * A saved Home resolves synchronously. A link carrying the Home's own
 * descriptor is acquired in place through the same owner the join screen uses,
 * so the page that is already mounted simply carries on once the Home is
 * adopted. Adopting a Home from the recovery action re-resolves the
 * device-local reference through the profiles generation.
 */
export function useTeamSignInHome(params: Readonly<{
    carrier?: string | null;
    serverId?: string | null;
}>): TeamSignInHome {
    const carrier = params.carrier ?? null;
    const serverId = params.serverId ?? null;
    const linkTarget = usePortableHomeLinkTarget(carrier);
    // The carrier branch's freshness now comes from the link-target owner itself.
    // This generation still serves the carrier-less `serverId` branch below, which
    // reads `getServerProfileById` directly, so it is not redundant here.
    const profilesGeneration = useServerProfilesGeneration();
    return React.useMemo(
        () => resolveTeamSignInHome({ carrier, linkTarget, serverId }),
        [carrier, linkTarget, profilesGeneration, serverId],
    );
}

/**
 * The URL that returns to this exact page after an external round trip.
 *
 * The caller's own carrier is preserved verbatim rather than rewritten to the
 * resolved profile id, so a link opened on a device that later adopts the Home
 * still returns to the Home the link named.
 */
export function teamSignInReturnPath(params: Readonly<{
    teamId: string;
    carrier?: string | null;
    serverId?: string | null;
    postAuthInvitation?: boolean;
    /**
     * The in-app page that asked this member to meet the Team's sign-in rule. Only an in-app path is carried
     * (never an address or another origin); it is where a successful sign-in returns.
     */
    returnTo?: string | null;
}>): `/teams/${string}/sign-in` | `/teams/${string}/sign-in?${string}` {
    const query = new URLSearchParams();
    const carrier = String(params.carrier ?? '').trim();
    const serverId = String(params.serverId ?? '').trim();
    const returnTo = admitOpaqueInternalReturnPath(params.returnTo);
    if (carrier) query.set('target', carrier);
    if (serverId) query.set('serverId', serverId);
    if (params.postAuthInvitation) query.set('postAuthInvitation', '1');
    if (returnTo) query.set('returnTo', returnTo);
    const search = query.toString();
    const pathname: `/teams/${string}/sign-in` = `/teams/${encodeURIComponent(params.teamId)}/sign-in`;
    return search ? `${pathname}?${search}` : pathname;
}

/**
 * Where a successful sign-in to meet a Team's rule lands: the in-app page that asked for it, so the same Share or
 * Start can follow at once, else the Team's own page. The return path arrives in a URL anyone can craft, so it is
 * admitted here as an in-app path only; an address, another origin or a malformed value falls back to the Team.
 */
export function resolveTeamSignInDestination(params: Readonly<{
    teamId: string;
    serverId: string;
    returnTo: string | null | undefined;
}>): string {
    return admitOpaqueInternalReturnPath(params.returnTo)
        ?? teamSessionsPath({ serverId: params.serverId, teamId: params.teamId });
}
