import type { TranslationKey } from '@/text';

import type { AccessEndpointRemediationAction, AccessEndpointRemediationOwnerSurface } from '../model';
import type {
    AccessChannel,
    AccessChannelDirection,
    AccessChannelKind,
    AccessChannelLimitation,
} from './model';

const kindCopyKeys = {
    'relay-access-provider': 'settings.accessEndpoints.kind.relay-access-provider',
    'ssh-tunnel-desktop': 'settings.accessEndpoints.kind.ssh-tunnel-desktop',
    'ssh-tunnel-native': 'settings.accessEndpoints.kind.ssh-tunnel-native',
    'server-profile-url': 'settings.accessEndpoints.kind.server-profile-url',
    'peer-mediation': 'settings.accessEndpoints.kind.peer-mediation',
    'manual-url': 'settings.accessEndpoints.kind.manual-url',
} as const satisfies Readonly<Record<AccessChannelKind, TranslationKey>>;

const directionCopyKeys = {
    'make-current-server-reachable': 'settings.accessEndpoints.direction.makeCurrentServerReachable',
    'reach-remote-server-from-this-device': 'settings.accessEndpoints.direction.reachRemoteServerFromThisDevice',
} as const satisfies Readonly<Record<AccessChannelDirection, TranslationKey>>;

const scopeCopyKeys = {
    'make-current-server-reachable': 'settings.accessEndpoints.scope.availableToOtherDevices',
    'reach-remote-server-from-this-device': 'settings.accessEndpoints.scope.thisDeviceOnly',
} as const satisfies Readonly<Record<AccessChannelDirection, TranslationKey>>;

const recommendedUseCopyKeys = {
    'multi-device': 'settings.accessEndpoints.recommendedUse.multi-device',
    'native-this-device': 'settings.accessEndpoints.recommendedUse.native-this-device',
    'hosted-web': 'settings.accessEndpoints.recommendedUse.hosted-web',
    'lan-only': 'settings.accessEndpoints.recommendedUse.lan-only',
    diagnostic: 'settings.accessEndpoints.recommendedUse.diagnostic',
} as const satisfies Readonly<Record<AccessChannel['recommendedUse'], TranslationKey>>;

const limitationCopyKeys = {
    'this-device-only': 'settings.accessEndpoints.limitation.this-device-only',
    'not-hosted-web-compatible': 'settings.accessEndpoints.limitation.not-hosted-web-compatible',
    'not-public-share-url': 'settings.accessEndpoints.limitation.not-public-share-url',
    'session-scoped': 'settings.accessEndpoints.limitation.session-scoped',
    'authentication-failed': 'settings.accessEndpoints.limitation.authentication-failed',
    'foreground-only': 'settings.accessEndpoints.limitation.foreground-only',
    'host-key-mismatch': 'settings.accessEndpoints.limitation.host-key-mismatch',
    'host-key-rejected': 'settings.accessEndpoints.limitation.host-key-rejected',
    'host-key-untrusted': 'settings.accessEndpoints.limitation.host-key-untrusted',
    'platform-suspended': 'settings.accessEndpoints.limitation.platform-suspended',
    'loopback-bind-failed': 'settings.accessEndpoints.limitation.loopback-bind-failed',
    'network-captive-portal': 'settings.accessEndpoints.limitation.network-captive-portal',
    'remote-service-unreachable': 'settings.accessEndpoints.limitation.remote-service-unreachable',
    'requires-auth': 'settings.accessEndpoints.limitation.requires-auth',
    'requires-host-key-trust': 'settings.accessEndpoints.limitation.requires-host-key-trust',
} as const satisfies Readonly<Record<AccessChannelLimitation['reason'], TranslationKey>>;

const remediationActionCopyKeys = {
    'tailscale.install': 'settings.accessEndpoints.remediation.tailscale.install',
    'tailscale.login': 'settings.accessEndpoints.remediation.tailscale.login',
    'tailscale.serve.enable': 'settings.accessEndpoints.remediation.tailscale.serve.enable',
    'tailscale.serve.approve': 'settings.accessEndpoints.remediation.tailscale.serve.approve',
    'tailscale.funnel.approve': 'settings.accessEndpoints.remediation.tailscale.funnel.approve',
    'cloudflare.configure': 'settings.accessEndpoints.remediation.cloudflare.configure',
    'serverProfile.configureShareableUrl': 'settings.accessEndpoints.remediation.serverProfile.configureShareableUrl',
    'remoteHost.add': 'settings.accessEndpoints.remediation.remoteHost.add',
    'remoteHost.setup': 'settings.accessEndpoints.remediation.remoteHost.setup',
    'sshTunnel.start': 'settings.accessEndpoints.remediation.sshTunnel.start',
    'sshTunnel.reuse': 'settings.accessEndpoints.remediation.sshTunnel.reuse',
    'sshTunnel.stop': 'settings.accessEndpoints.remediation.sshTunnel.stop',
    'sshTunnel.authenticate': 'settings.accessEndpoints.remediation.sshTunnel.authenticate',
    'sshTunnel.trustHost': 'settings.accessEndpoints.remediation.sshTunnel.trustHost',
} as const satisfies Readonly<Record<AccessEndpointRemediationOwnerSurface, TranslationKey>>;

export function buildAccessChannelCopyKeys(channel: AccessChannel): Readonly<{
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
}> {
    return {
        titleKey: kindCopyKeys[channel.kind],
        subtitleKey: directionCopyKeys[channel.direction],
    };
}

export function buildAccessChannelDirectionCopyKey(direction: AccessChannelDirection): TranslationKey {
    return directionCopyKeys[direction];
}

export function buildAccessChannelScopeCopyKey(channel: AccessChannel): TranslationKey {
    return scopeCopyKeys[channel.direction];
}

export function buildAccessChannelRecommendedUseCopyKey(channel: AccessChannel): TranslationKey {
    return recommendedUseCopyKeys[channel.recommendedUse];
}

export function buildAccessChannelLimitationCopyKey(limitation: AccessChannelLimitation): TranslationKey {
    return limitationCopyKeys[limitation.reason];
}

export function buildAccessEndpointRemediationActionCopyKey(action: AccessEndpointRemediationAction): TranslationKey {
    return remediationActionCopyKeys[action.ownerSurface];
}
