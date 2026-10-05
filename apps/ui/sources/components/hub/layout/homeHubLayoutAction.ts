import { HomeReachNudgeDismissInputSchema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { dismissHomeReachNudge } from '@/sync/runtime/connectivity/homeReachFailures';

/** Reachability dismissal is device-local; persisted Home customization uses the Protocol Artifact port. */
export function createHomeHubLayoutAction(port: Readonly<{ isClientTargetCurrent(): boolean }>): NonNullable<ActionExecutorDeps['homeHubLayoutAction']> {
    return async ({ actionId, input, signal }) => {
        signal?.throwIfAborted();
        if (!port.isClientTargetCurrent()) return { ok: false, errorCode: 'action_target_client_mismatch', error: 'action_target_client_mismatch' };
        if (actionId !== 'home.reachNudge.dismiss') return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        const { homeServerId } = HomeReachNudgeDismissInputSchema.parse(input);
        const profile = getServerProfileById(homeServerId);
        if (!profile) return { ok: false, errorCode: 'home_not_found', error: 'home_not_found' };
        const homeIdentityId = profile.serverIdentityId;
        if (!homeIdentityId) return { ok: false, errorCode: 'home_identity_unverified', error: 'home_identity_unverified' };
        dismissHomeReachNudge(homeIdentityId);
        return { homeIdentityId, dismissed: true };
    };
}
