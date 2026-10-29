import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { join } from 'node:path';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';
import { readDefaultManagedReleaseChannel, shouldPersistDefaultManagedReleaseChannel } from './defaultReleaseChannelState.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';

export interface DesiredFirstPartyShimTarget {
    shimPath: string;
    binaryPath: string;
    args?: readonly string[];
}

export async function resolveDesiredShimTargets(params: Readonly<{
    componentId: FirstPartyComponentId;
    channel?: PublicReleaseRingId;
    releaseRing?: PublicReleaseRingId;
    defaultReleaseChannelOverride?: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
    sourceLaunch?: Readonly<{ shimDir: string; command: string; args: readonly string[] }>;
}>): Promise<readonly DesiredFirstPartyShimTarget[]> {
    if (params.sourceLaunch) {
        const { shimDir, command, args } = params.sourceLaunch;
        return getFirstPartyComponentCatalogEntry(params.componentId).installShims.map(name => ({
            shimPath: join(shimDir, process.platform === 'win32' ? `${name}.cmd` : name),
            binaryPath: command,
            args,
        }));
    }
    const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: params.componentId,
        channel: params.channel,
        releaseRing: params.releaseRing,
        processEnv: params.processEnv,
    });

    if (!shouldPersistDefaultManagedReleaseChannel(params.componentId)) {
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
