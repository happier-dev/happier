import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { readDefaultManagedReleaseChannel } from './defaultReleaseChannelState.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';

export interface DesiredFirstPartyShimTarget {
    shimPath: string;
    binaryPath: string;
}

const DEFAULT_RELEASE_CHANNEL_COMPONENT_IDS = new Set<FirstPartyComponentId>(['happier-cli', 'happier-daemon']);

export async function resolveDesiredShimTargets(params: Readonly<{
    componentId: FirstPartyComponentId;
    channel?: PublicReleaseRingId;
    releaseRing?: PublicReleaseRingId;
    defaultReleaseChannelOverride?: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<readonly DesiredFirstPartyShimTarget[]> {
    const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: params.componentId,
        channel: params.channel,
        releaseRing: params.releaseRing,
        processEnv: params.processEnv,
    });

    if (!DEFAULT_RELEASE_CHANNEL_COMPONENT_IDS.has(params.componentId)) {
        return paths.shimPaths.map((shimPath) => ({ shimPath, binaryPath: paths.binaryPath }));
    }

    const channel = params.channel ?? params.releaseRing ?? 'stable';
    const defaultReleaseChannel =
        params.defaultReleaseChannelOverride
        ?? await readDefaultManagedReleaseChannel({ processEnv: params.processEnv });
    const defaultShimPath = resolveInstalledFirstPartyComponentPaths({
        componentId: params.componentId,
        channel: 'stable',
        processEnv: params.processEnv,
    }).shimPaths[0];

    const targets: DesiredFirstPartyShimTarget[] = paths.shimPaths
        .filter((shimPath) => shimPath !== defaultShimPath)
        .map((shimPath) => ({ shimPath, binaryPath: paths.binaryPath }));

    if (defaultShimPath && channel === defaultReleaseChannel) {
        targets.unshift({ shimPath: defaultShimPath, binaryPath: paths.binaryPath });
    }

    return targets;
}
