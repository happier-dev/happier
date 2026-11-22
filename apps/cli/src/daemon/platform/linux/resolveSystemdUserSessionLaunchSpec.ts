import {
    buildHappyCliSubprocessLaunchSpec,
    type HappyCliSubprocessLaunchOptions,
    type HappyCliSubprocessLaunchSpec,
} from '@/utils/spawnHappyCLI';

import {
    buildSystemdUserScopedLaunchSpec,
    isSystemdUserResourceGovernorReady,
    type SystemdUserResourceGovernorExecFile,
    type SystemdUserScopedLaunchSpec,
} from './systemdUserResourceGovernor';

export async function resolveSystemdUserSessionLaunchSpec(params: Readonly<{
    environment: NodeJS.ProcessEnv;
    systemdUserResourceGovernorExecFile?: SystemdUserResourceGovernorExecFile;
} & (
    | { args: string[]; launchOptions?: HappyCliSubprocessLaunchOptions; launchSpec?: never }
    | { launchSpec: HappyCliSubprocessLaunchSpec; args?: never; launchOptions?: never }
)>): Promise<SystemdUserScopedLaunchSpec | null> {
    if (!await isSystemdUserResourceGovernorReady({
        environment: params.environment,
        execFile: params.systemdUserResourceGovernorExecFile,
    })) {
        return null;
    }

    const launchSpec = params.launchSpec ?? buildHappyCliSubprocessLaunchSpec(params.args, params.launchOptions);
    return buildSystemdUserScopedLaunchSpec({ launchSpec });
}
