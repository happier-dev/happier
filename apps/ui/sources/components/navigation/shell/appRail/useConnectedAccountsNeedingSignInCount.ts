import { countConnectedAccountsNeedingSignIn } from '@/sync/domains/connectedServices/countConnectedAccountsNeedingSignIn';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

/**
 * The Usage rail badge's summary projection: a number, so the always-mounted rail re-renders only
 * when the count changes, never on other profile updates.
 */
export function useConnectedAccountsNeedingSignInCount(): number {
    const accountTransport = resolveConnectedAccountUiNegotiation(useServerFeaturesRuntimeSnapshot());
    const { entries } = useProjectedConnectedServicesRegistry();
    return getStorage()((state) => countConnectedAccountsNeedingSignIn({ profile: state.profile, accountTransport, entries }),
        { profile: ['connectedServicesV2', 'connectedAccountsV4'] });
}
