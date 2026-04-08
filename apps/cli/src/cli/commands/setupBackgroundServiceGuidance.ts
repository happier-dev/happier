import {
    deriveManagedReleaseChannelInventory,
    discoverHappierInstallations,
    discoverHappierServices,
} from '@happier-dev/cli-common/happierRuntime';
import {
    buildBackgroundServiceSetupGuidance,
    type BackgroundServiceSetupGuidance,
} from '@happier-dev/cli-common/systemTasks';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

function resolveCurrentPlatform(): 'darwin' | 'linux' | 'win32' {
    return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
        ? process.platform
        : 'darwin';
}

export async function readSetupBackgroundServiceGuidance(params: Readonly<{
    targetReleaseChannel: PublicReleaseRingId;
    targetServerUrl: string;
}>): Promise<BackgroundServiceSetupGuidance> {
    const installations = await discoverHappierInstallations({
        processEnv: process.env,
        invokedPath: process.execPath,
    });
    const managedReleaseChannelInventory = await deriveManagedReleaseChannelInventory({
        inventory: installations,
        processEnv: process.env,
    });
    const serviceInventory = await discoverHappierServices({
        processEnv: process.env,
        platform: resolveCurrentPlatform(),
    });

    return buildBackgroundServiceSetupGuidance({
        targetReleaseChannel: params.targetReleaseChannel,
        targetServerUrl: params.targetServerUrl,
        managedReleaseChannelInventory,
        services: serviceInventory.services,
        platform: resolveCurrentPlatform(),
        mode: 'user',
    });
}

export type { BackgroundServiceSetupGuidance };
