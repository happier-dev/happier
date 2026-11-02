import type { AccessProviderRoleResultV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { runTailscaleStatusJson } from '../../../tailscale/commandRunner.js';
import { classifyRelayAccessDiagnosticCode } from '../../diagnostics.js';

/** Read-only built-in role codec. P20 alone owns install, join and operator effects. */
export async function inspectBuiltinTailscaleAccessProvider(
    params: Parameters<typeof runTailscaleStatusJson>[0] = {},
    deps: Parameters<typeof runTailscaleStatusJson>[1] = {},
): Promise<AccessProviderRoleResultV1> {
    try {
        const snapshot = await runTailscaleStatusJson(params, deps);
        const state = !snapshot.daemonReachable ? 'unavailable' : snapshot.running ? 'ready'
            : !snapshot.loggedIn ? 'needsAuth' : 'stopped';
        return { kind: 'confirmed', facts: { state, privateNetwork: {
            provider: { kind: 'builtin', id: 'tailscale' },
            networkIdentity: snapshot.tailnetName, displayName: snapshot.tailnetName,
            dnsName: snapshot.dnsName, addresses: [...snapshot.tailscaleIps], state,
            interfaceName: snapshot.interfaceName, sourceRanges: [...snapshot.sourceRanges],
            magicDnsEnabled: snapshot.magicDnsEnabled,
        } } };
    } catch (error) {
        (params.signal ?? params.deadline?.signal)?.throwIfAborted();
        return { kind: 'unknown', code: classifyRelayAccessDiagnosticCode(error) };
    }
}
