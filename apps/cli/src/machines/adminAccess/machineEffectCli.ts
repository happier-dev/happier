import { resolveInstalledFirstPartyComponentPaths, resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

export type MachineEffectCliInvocation = Readonly<{
    installedCli: string;
    installedCliArgs?: readonly string[];
}>;

/** Native isolation also needs a managed binary path, independently of elevation. */
export function resolveInstalledMachineEffectCli(): string {
    const channel = resolveManagedCliReleaseChannelSync().ringId;
    const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel });
    return paths.resolvedBinaryPath ?? paths.binaryPath;
}

/** Source daemons use their selected CLI launch; installed daemons follow their managed channel. */
export function resolveMachineEffectCli(): MachineEffectCliInvocation {
    if (process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT?.trim()) {
        const launch = buildHappyCliSubprocessLaunchSpec([]);
        return { installedCli: launch.filePath, installedCliArgs: launch.args };
    }
    return { installedCli: resolveInstalledMachineEffectCli() };
}
