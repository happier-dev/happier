import { Platform } from 'react-native';

import {
    DaemonHostedWebFrameCapabilityV1Schema,
    type DaemonHostedWebFrameCapabilityV1,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { isHostedArtifactFrameNativeAdapterAvailable } from './HostedArtifactFrame.native';

function exactCapability(value: unknown): DaemonHostedWebFrameCapabilityV1 | null {
    const parsed = DaemonHostedWebFrameCapabilityV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

/**
 * Native physical-frame projection. The Artifact renderer's one adapter probe
 * remains the authority: this only names the platform-specific transport it
 * has already proved available.
 */
let hostCapability: DaemonHostedWebFrameCapabilityV1 | null | undefined;

export function resolveHostedWebFrameCapability(): DaemonHostedWebFrameCapabilityV1 | null {
    const platform = Platform.OS;
    if (platform !== 'ios' && platform !== 'android') return null;
    if (hostCapability !== undefined) return hostCapability;
    // Native module/view availability is fixed for this loaded host. Machine
    // projection reads carry the admitted fact rather than probing it again.
    if (!isHostedArtifactFrameNativeAdapterAvailable()) return hostCapability = null;

    return hostCapability = platform === 'ios'
        ? exactCapability({ platform: 'ios', adapter: 'WKWebView' })
        : exactCapability({ platform: 'android', adapter: 'WebViewAssetLoader' });
}
