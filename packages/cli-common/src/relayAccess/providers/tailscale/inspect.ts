import type { AccessProviderMembershipIntentV1, AccessProviderRoleResultV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { runTailscaleCurrentProfileId, runTailscaleStatusJson } from '../../../tailscale/commandRunner.js';
import { classifyRelayAccessDiagnosticCode } from '../../diagnostics.js';

/** Read-only built-in role codec. P20 alone owns install, join and operator effects. */
export async function inspectBuiltinTailscaleAccessProvider(
    params: Parameters<typeof runTailscaleStatusJson>[0] = {},
    deps: Parameters<typeof runTailscaleStatusJson>[1] = {},
    membership?: Readonly<{ intent: AccessProviderMembershipIntentV1; hasJoinCredential: boolean; platform: NodeJS.Platform }>,
): Promise<AccessProviderRoleResultV1> {
    try {
        const snapshot = await runTailscaleStatusJson(params, deps);
        const state = !snapshot.daemonReachable ? 'unavailable' : snapshot.running ? 'ready'
            : !snapshot.loggedIn ? 'needsAuth' : 'stopped';
        let reviewedMembership: Extract<AccessProviderRoleResultV1, { kind: 'confirmed' }>['facts']['membership'];
        if (membership) {
            if (state === 'unavailable') return { kind: 'refused', code: 'provider_unreachable' };
            const joinsWithCredential = membership.intent === 'join' && membership.hasJoinCredential;
            if (membership.intent === 'join' && !joinsWithCredential && state === 'needsAuth') {
                return { kind: 'refused', code: 'needsAuth' };
            }
            const profileId = await runTailscaleCurrentProfileId(params, deps);
            if (state !== 'needsAuth' && !profileId) return { kind: 'refused', code: 'invalid_provider_output' };
            reviewedMembership = { profileId, flags: [
                ...(joinsWithCredential && state === 'ready' ? ['switch-network'] : []),
                ...(joinsWithCredential && (membership.platform === 'linux' || membership.platform === 'darwin') ? ['set-operator'] : []),
            ] };
        }
        return { kind: 'confirmed', facts: { state, ...(reviewedMembership ? { membership: reviewedMembership } : {}), privateNetwork: {
            provider: { kind: 'builtin', id: 'tailscale' },
            networkIdentity: snapshot.tailnetName, displayName: snapshot.tailnetName,
            dnsName: snapshot.dnsName, addresses: [...snapshot.tailscaleIps], state,
            interfaceName: snapshot.interfaceName, sourceRanges: [...snapshot.sourceRanges],
            magicDnsEnabled: snapshot.magicDnsEnabled,
        } } };
    } catch (error) {
        (params.signal ?? params.deadline?.signal)?.throwIfAborted();
        return { kind: membership ? 'refused' : 'unknown', code: classifyRelayAccessDiagnosticCode(error) };
    }
}
