import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { readConfiguredServerUrlEnv } from '../readConfiguredServerUrlEnv';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { isPersonalHomeBootstrapRuntimeHost } from '@/utils/platform/personalHomeBootstrapHost';
import { resolveBuildDefaultProfile } from '@happier-dev/cli-common/happierCloud';
import { readOrganizationPolicy } from '@/sync/domains/organizationPolicy/organizationPolicy';

export type SetupSurfacePolicy = Readonly<{
    relay: Readonly<{
        allowRelaySelection: boolean;
        allowHappierCloud: boolean;
        allowCustomRelayUrl: boolean;
        allowLocalRelayHost: boolean;
        allowRemoteSshRelayHost: boolean;
        enforcedServerUrl: string | null;
    }>;
    machine: Readonly<{
        allowLocalMachineSetup: boolean;
        allowRemoteSshMachineSetup: boolean;
    }>;
    providers: Readonly<{
        allowProviderSetup: boolean;
    }>;
    relayAccess: Readonly<{
        allowTailscale: boolean;
        allowCloudflareTunnel: boolean;
    }>;
}>;

function isAllowedByBuildPolicy(featureId: Parameters<typeof getFeatureBuildPolicyDecision>[0]): boolean {
    return getFeatureBuildPolicyDecision(featureId) !== 'deny';
}

export function resolveSetupSurfacePolicy(): SetupSurfacePolicy {
    const organizationPolicy = readOrganizationPolicy();
    const governedHomeSelection = organizationPolicy.status === 'invalid'
        || (organizationPolicy.status === 'loaded' && organizationPolicy.policy.home?.locked === true);
    const allowRelaySelection = !governedHomeSelection && isAllowedByBuildPolicy('setup.relay.allowRelaySelection');
    const configuredServerUrl = readConfiguredServerUrlEnv();

    return {
        relay: {
            allowRelaySelection,
            allowHappierCloud: isAllowedByBuildPolicy('setup.relay.allowHappierCloud'),
            allowCustomRelayUrl: isAllowedByBuildPolicy('setup.relay.allowCustomRelayUrl'),
            allowLocalRelayHost: isAllowedByBuildPolicy('setup.relay.allowLocalRelayHost'),
            allowRemoteSshRelayHost: isAllowedByBuildPolicy('setup.relay.allowRemoteSshRelayHost'),
            enforcedServerUrl: !allowRelaySelection && configuredServerUrl ? configuredServerUrl : null,
        },
        machine: {
            allowLocalMachineSetup: isAllowedByBuildPolicy('setup.machine.allowLocalMachineSetup'),
            allowRemoteSshMachineSetup: isAllowedByBuildPolicy('setup.machine.allowRemoteSshMachineSetup'),
        },
        providers: {
            allowProviderSetup: isAllowedByBuildPolicy('setup.providers.allowProviderSetup'),
        },
        relayAccess: {
            allowTailscale: isAllowedByBuildPolicy('setup.relayAccess.allowTailscale'),
            allowCloudflareTunnel: isAllowedByBuildPolicy('setup.relayAccess.allowCloudflareTunnel'),
        },
    };
}

/**
 * Whether this device can create and run a Personal Home: only the desktop app hosts one, and only
 * where the build lets the person choose a Home and host it locally. Every "Create a Personal Home"
 * entry (welcome, the Add a Home sheet) asks this one question.
 */
export type PersonalHomeAdmission = 'auto' | 'offer' | 'off';

/** One admission owner for automatic bootstrap and every new local Personal Home entry. */
export function resolvePersonalHomeAdmission(
    policy: SetupSurfacePolicy = resolveSetupSurfacePolicy(),
    input: Readonly<{
        host?: boolean;
        /** Effective policy value; the organization-policy projection can supply this here. */
        personalHome?: PersonalHomeAdmission;
    }> = {},
): PersonalHomeAdmission {
    const organizationPolicy = readOrganizationPolicy();
    if (organizationPolicy.status === 'invalid') return 'off';
    if (!(input.host ?? isPersonalHomeBootstrapRuntimeHost())
        || !policy.relay.allowRelaySelection
        || !policy.relay.allowLocalRelayHost) return 'off';
    const personalHome = organizationPolicy.status === 'loaded' ? organizationPolicy.policy.personalHome : undefined;
    return (personalHome?.locked ? personalHome.value : input.personalHome)
        ?? personalHome?.value ?? resolveBuildDefaultProfile().personalHome?.value ?? 'offer';
}

export function canHostPersonalHomeHere(policy: SetupSurfacePolicy = resolveSetupSurfacePolicy()): boolean {
    return resolvePersonalHomeAdmission(policy) !== 'off';
}

/** Server Home setup also allows the desktop SSH relay-host task. */
export function canSetUpServerHomeHere(policy: SetupSurfacePolicy = resolveSetupSurfacePolicy()): boolean {
    return desktopHostKind() === 'tauri'
        && policy.relay.allowRelaySelection
        && (policy.relay.allowLocalRelayHost || policy.relay.allowRemoteSshRelayHost);
}
