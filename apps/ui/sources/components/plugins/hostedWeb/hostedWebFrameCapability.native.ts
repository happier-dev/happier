import { Platform } from 'react-native';

import {
    DaemonHostedWebFrameCapabilityV1Schema,
    type DaemonHostedWebFrameCapabilityV1,
} from '@happier-dev/protocol';

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
export function resolveHostedWebFrameCapability(): DaemonHostedWebFrameCapabilityV1 | null {
    const platform = Platform.OS;
    if (platform !== 'ios' && platform !== 'android') return null;
    if (!isHostedArtifactFrameNativeAdapterAvailable()) return null;

    return platform === 'ios'
        ? exactCapability({ platform: 'ios', adapter: 'WKWebView' })
        : exactCapability({ platform: 'android', adapter: 'WebViewAssetLoader' });
}
