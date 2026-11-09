import * as React from 'react';
import { parseHomeTargetInput, type HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { verifyTeamInvitationTargetBindingV1 } from '@happier-dev/protocol/teams';

import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    adoptHomeProfile,
    resolveServerProfileForPortableIdentity,
} from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';

/**
 * Which Home issued an invitation link.
 *
 * Child 05 §8 is explicit about this: the Homes producer owns the explicit-target
 * carrier encoding, its link parser, identity validation and target resolution,
 * and the join controller consumes that one resolver. When the Home cannot be
 * resolved the contract names the existing explicit-target discovery flow — and
 * names what must *not* happen: "not the chooser, focused Home, `location.origin`,
 * or an arbitrary sign-in service".
 *
 * That prohibition is a disclosure rule, not a preference. The path segment of a
 * join link is a live bearer. Asking a Home to preview it tells that Home the
 * secret, so a Home may only be asked once the link itself has named it. A single
 * saved Home is not evidence that it minted the invitation, and neither is the
 * focused one.
 *
 * The carrier is the Home's **portable** identity — the same
 * `homeServerIdentityId` the Home publishes in its connection descriptor — not a
 * device-local `ServerProfile.id`. Those two are different namespaces: a profile
 * id is local routing storage that differs per device, so comparing the carrier
 * to it would fail on every device except the one that happened to mint a
 * matching id, and could in principle match an unrelated Home. The identity-aware
 * profile resolver is the canonical owner of that lookup, including the legacy
 * identifiers a Home has been known by, and this module consumes it rather than
 * re-deriving the rule.
 */
export type PortableHomeLinkTarget =
    /**
     * Exactly one saved Home on this device holds the portable identity the link
     * named, so the bearer may be presented to it.
     */
    | Readonly<{ kind: 'resolved'; serverId: string; target: HomeTargetInput }>
    /**
     * More than one saved profile claims that identity. Picking one would be a
     * guess about where a secret goes, so nothing is sent.
     */
    | Readonly<{ kind: 'ambiguous' }>
    /**
     * The link carries the Home's own full connection descriptor for a Home this
     * device has not adopted yet — the ordinary fresh-device case. The descriptor
     * has already been validated by the portable-target parser, so it is retained
     * here rather than reduced to an identity: discarding it is what forces a
     * person to leave the live link, find the Home by hand, and come back.
     *
     * It is not yet a routing decision. Nothing may be sent to the named
     * endpoints until `acquirePortableHomeLinkTarget` has observed that Home's
     * stable identity and proven it is exactly the one the descriptor claims.
     */
    | Readonly<{
        kind: 'acquisition_required';
        homeServerIdentityId: string;
        descriptor: HomeConnectionDescriptorV1;
    }>
    /**
     * The link named a real Home this device has not adopted yet, and carried no
     * descriptor to acquire it with. Legacy identity-only links land here and
     * stay recoverable through the existing manual Add Home flow; the invitation
     * stays valid meanwhile.
     */
    | Readonly<{ kind: 'unknown_home'; homeServerIdentityId: string }>
    /**
     * The link carries no usable Home carrier at all. Nothing is guessed and
     * nothing is sent; the surface explains the state instead.
     */
    | Readonly<{ kind: 'unresolved' }>;

const UNRESOLVED: PortableHomeLinkTarget = Object.freeze({ kind: 'unresolved' as const });
const AMBIGUOUS: PortableHomeLinkTarget = Object.freeze({ kind: 'ambiguous' as const });

/**
 * Admits a Team invitation carrier before the portable target parser can inspect
 * it or the acquisition owner can probe it.
 *
 * Current descriptor links require the bearer-derived binding. The only
 * binding-less shape retained is an identity-only link that already resolves to
 * one saved Home, because it supplies no attacker-chosen endpoint to acquire.
 */
export function isTeamInvitationTargetBindingValidBeforeResolution(input: Readonly<{
    token: string;
    carrier: string | null | undefined;
    binding: string | null | undefined;
}>): boolean {
    const carrier = input.carrier ?? '';
    if (input.binding !== null && input.binding !== undefined) {
        return verifyTeamInvitationTargetBindingV1({
            token: input.token,
            homeTarget: carrier,
            binding: input.binding,
        });
    }
    const identityOnly = carrier.trim();
    if (!identityOnly) return false;
    return resolveServerProfileForPortableIdentity(identityOnly).kind === 'resolved';
}

/**
 * Resolves the issuing Home from the link's non-secret target carrier.
 *
 * `carrier` is the value the Homes link owner placed in the join URL. Its shape
 * is validated by the identity owner rather than by a regular expression here:
 * this module decides *which* Home a resolved identity routes to, never what a
 * well-formed identity looks like.
 */
export function resolvePortableHomeLinkTarget(
    carrier: string | null | undefined,
): PortableHomeLinkTarget {
    const normalizedCarrier = String(carrier ?? '').trim();
    if (!normalizedCarrier) return UNRESOLVED;
    try {
        const portableTarget = parseHomeTargetInput(JSON.parse(normalizedCarrier));
        if (portableTarget.kind !== 'descriptor') return UNRESOLVED;
        const resolution = resolveServerProfileForPortableIdentity(
            portableTarget.descriptor.homeServerIdentityId,
        );
        if (resolution.kind === 'ambiguous') return AMBIGUOUS;
        if (resolution.kind === 'resolved') {
            return {
                kind: 'resolved',
                serverId: resolution.profile.id,
                target: { kind: 'saved_profile', profileRef: resolution.profile.id },
            };
        }
        // The carrier is advisory input from a link, so it is not a resolved
        // authentication target: treating it as one would let this consumer
        // manufacture connection authority from the value it is supposed to
        // verify. The validated descriptor is still the only thing that can
        // reach that Home from a fresh device, so it is carried into the
        // acquisition state instead of being thrown away.
        return {
            kind: 'acquisition_required',
            homeServerIdentityId: portableTarget.descriptor.homeServerIdentityId,
            descriptor: portableTarget.descriptor,
        };
    } catch {
        // Legacy links carried only the stable Home identity. Keep resolving
        // those through the same profile identity/alias owner.
    }
    const resolution = resolveServerProfileForPortableIdentity(normalizedCarrier);
    if (resolution.kind === 'ambiguous') return AMBIGUOUS;
    if (resolution.kind === 'missing') {
        // The identity owner normalizes an absent or malformed carrier to an
        // empty identity, which is a link this build cannot route at all. A
        // well-formed identity with no saved profile is a Home this device has
        // simply not added yet, and those two states have different remedies.
        return resolution.serverIdentityId === ''
            ? UNRESOLVED
            : { kind: 'unknown_home', homeServerIdentityId: resolution.serverIdentityId };
    }
    return {
        kind: 'resolved',
        serverId: resolution.profile.id,
        target: { kind: 'saved_profile', profileRef: resolution.profile.id },
    };
}

/**
 * Whether two resolutions are the same answer. Every variant is fully described
 * by its kind plus the identity it names, and the descriptor is derived from the
 * carrier, so this is structural identity rather than a cache.
 */
function isSamePortableHomeLinkTarget(
    a: PortableHomeLinkTarget,
    b: PortableHomeLinkTarget,
): boolean {
    if (a === b) return true;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'resolved' && b.kind === 'resolved') return a.serverId === b.serverId;
    if (a.kind === 'unknown_home' && b.kind === 'unknown_home') {
        return a.homeServerIdentityId === b.homeServerIdentityId;
    }
    if (a.kind === 'acquisition_required' && b.kind === 'acquisition_required') {
        return a.homeServerIdentityId === b.homeServerIdentityId;
    }
    return true;
}

export type PortableHomeAcquisitionOutcome =
    /** The Home proved its identity and now has a saved profile on this device. */
    | Readonly<{ kind: 'acquired'; serverId: string; target: HomeTargetInput }>
    /**
     * Nothing was established. `identity_mismatch` means the endpoints answered
     * as a different Home than the link claimed, `unreachable` means they did not
     * answer usably at all, and `not_adopted` means this device declined to
     * record the Home. In every case no profile exists and no bearer has left
     * this device, because acquisition runs before any bearer is presented.
     */
    | Readonly<{ kind: 'rejected'; reason: 'identity_mismatch' | 'unreachable' | 'not_adopted' }>;

/**
 * Acquires the Home a current link named, proving its identity first.
 *
 * The descriptor is the link's claim about where a Home lives; the public
 * feature observation is that Home's own answer about who it is. Only when the
 * two agree exactly does this device record the Home, which is what later lets
 * `resolvePortableHomeLinkTarget` route the bearer there. A mismatched or
 * silent endpoint leaves this device exactly as it was.
 *
 * Observation is deliberately the existing unauthenticated public probe: it
 * carries no credential and no invitation, reset or recovery bearer, so a
 * hostile descriptor learns nothing it did not already put in the link.
 *
 * *Where* that probe is sent is not this module's decision. A Personal Home is
 * routinely Iroh-only with a loopback canonical URL, so reading an endpoint out
 * of the descriptor here would send a remote device's observation to its own
 * machine and report the Home as silent. Child 03 §8 is explicit that such a
 * Home travels as its published descriptor, and the enrollment transport owner
 * is what already turns one into a reachable carrier — including the Iroh
 * acquisition, its verification and its fail-closed rules. This consumes that
 * owner and holds the carrier only for the single observation.
 */
export async function acquirePortableHomeLinkTarget(
    request: Extract<PortableHomeLinkTarget, { kind: 'acquisition_required' }>,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PortableHomeAcquisitionOutcome> {
    const resolution = await resolveHomeEnrollmentTransport(request.descriptor);
    if (!resolution.ok) {
        // No carrier exists yet, so nothing was asked of any endpoint and
        // nothing was recorded. That is the retryable state, not a verdict about
        // which Home answers there.
        return { kind: 'rejected', reason: 'unreachable' };
    }
    const { transport } = resolution;
    try {
        const observation = await probeServerFeaturesAtUrl({
            // The canonical URL stays the request's stable audience; the carrier
            // supplies the transport it is actually reachable over.
            endpointUrl: transport.endpointUrl,
            runtimeOrigin: transport.runtimeOrigin,
            ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
            serverId: request.homeServerIdentityId,
            force: true,
            // Opening a link is not a latency-sensitive diagnostic. Wait for the
            // shared observation's own request-attempt bound instead of racing the
            // probe helper's short interactive budget.
            timeoutMs: 0,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (observation.status !== 'ready') return { kind: 'rejected', reason: 'unreachable' };
        const observedIdentity = String(
            observation.serverIdentityId
            ?? observation.features.capabilities.serverIdentity.serverIdentityId
            ?? '',
        ).trim();
        if (!observedIdentity || observedIdentity !== request.homeServerIdentityId) {
            return { kind: 'rejected', reason: 'identity_mismatch' };
        }
        try {
            // The link descriptor stays advisory. Observation proved *who* answers at
            // those endpoints, not that a redacted public projection may establish an
            // exact outer generation; the Home's own authenticated publication still
            // owns that through the existing reconciliation path.
            const profile = await adoptHomeProfile({
                descriptor: request.descriptor,
                source: 'url',
                descriptorAuthority: 'advisory',
            });
            return {
                kind: 'acquired',
                serverId: profile.id,
                target: { kind: 'saved_profile', profileRef: profile.id },
            };
        } catch {
            return { kind: 'rejected', reason: 'not_adopted' };
        }
    } finally {
        // An Iroh carrier is a live runtime resource, and this observation is the
        // only thing it was acquired for. Release it on every exit — adoption,
        // mismatch, silence, cancellation and throw alike — so a reopened link
        // never accumulates leases. HTTPS owns nothing and this is a no-op.
        await transport.close().catch(() => {});
    }
}

export type PortableHomeLinkTargetState =
    | Extract<PortableHomeLinkTarget, { kind: 'resolved' | 'ambiguous' | 'unknown_home' | 'unresolved' }>
    /** The named Home is being observed and adopted; the link's bearer stays put. */
    | Readonly<{ kind: 'acquiring' }>
    | Readonly<{
        kind: 'acquisition_failed';
        reason: Extract<PortableHomeAcquisitionOutcome, { kind: 'rejected' }>['reason'];
        retry: () => void;
    }>;

/**
 * The live binding every portable-link surface consumes.
 *
 * A saved Home resolves synchronously, exactly as before. A current link for an
 * unsaved Home acquires it in place and then resolves, so the route that is
 * already mounted — with its in-memory bearer and its continuation — simply
 * carries on. Nothing about the link is persisted to survive a detour, because
 * there is no longer a detour to survive.
 */
export function usePortableHomeLinkTarget(
    carrier: string | null | undefined,
): PortableHomeLinkTargetState {
    // `resolvePortableHomeLinkTarget` reads the device's saved Home profiles, so
    // adding the missing Home from the `unknown_home` recovery must re-resolve the
    // same link. The generation is the profiles owner's own change signal.
    const profilesGeneration = useServerProfilesGeneration();
    const previousResolution = React.useRef<PortableHomeLinkTarget | null>(null);
    const resolution = React.useMemo(() => {
        const next = resolvePortableHomeLinkTarget(carrier);
        // An unchanged answer keeps its identity: this value keys the acquisition
        // effect and the outcome association below, so a fresh object for the same
        // answer would abort and restart an acquisition that is already in flight.
        const previous = previousResolution.current;
        const stable = previous && isSamePortableHomeLinkTarget(previous, next) ? previous : next;
        previousResolution.current = stable;
        return stable;
    }, [carrier, profilesGeneration]);
    const [attempt, setAttempt] = React.useState(0);
    /**
     * The outcome is stored WITH the resolution it answered. `resolution` recomputes
     * synchronously when the carrier changes, while the reset below only runs after the
     * render commits — so an unassociated outcome publishes the previous Home's target
     * for the new link, and a consumer that dispatches its bearer from the first render
     * (React runs child effects before parent effects) sends it to the wrong Home.
     */
    const [acquisition, setAcquisition] = React.useState<Readonly<{
        resolution: PortableHomeLinkTarget;
        outcome: PortableHomeAcquisitionOutcome;
    }> | null>(null);
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);

    React.useEffect(() => {
        setAcquisition(null);
        if (resolution.kind !== 'acquisition_required') return undefined;
        let current = true;
        const abortController = new AbortController();
        void (async () => {
            const outcome = await acquirePortableHomeLinkTarget(resolution, {
                signal: abortController.signal,
            });
            if (current) setAcquisition({ resolution, outcome });
        })().catch(() => {
            if (current) setAcquisition({ resolution, outcome: { kind: 'rejected', reason: 'unreachable' } });
        });
        return () => {
            current = false;
            abortController.abort();
        };
    }, [attempt, resolution]);

    // Consumers key effects and requests off this value, so an unchanged state
    // must stay referentially identical across renders.
    return React.useMemo<PortableHomeLinkTargetState>(() => {
        if (resolution.kind !== 'acquisition_required') return resolution;
        if (acquisition === null || acquisition.resolution !== resolution) return ACQUIRING;
        const outcome = acquisition.outcome;
        return outcome.kind === 'acquired'
            ? { kind: 'resolved', serverId: outcome.serverId, target: outcome.target }
            : { kind: 'acquisition_failed', reason: outcome.reason, retry };
    }, [acquisition, resolution, retry]);
}

const ACQUIRING: PortableHomeLinkTargetState = Object.freeze({ kind: 'acquiring' as const });

/** Team-join compatibility name; portable Home link resolution has one owner. */
export type TeamJoinTarget = PortableHomeLinkTarget;
