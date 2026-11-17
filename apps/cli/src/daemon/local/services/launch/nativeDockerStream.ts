import { Duplex } from 'node:stream';

import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

/** Borrow the retained native launch without transferring generation custody. */
export async function openNativeDockerStream(
    launch: HostAuthorizedPluginExecLaunch,
    prefix: readonly string[],
    args: readonly string[],
    signal?: AbortSignal,
): Promise<Awaited<ReturnType<NonNullable<ProjectNativeDockerPort['openStream']>>>> {
    signal?.throwIfAborted();
    const process = spawnAuthorizedHostExecLaunchForHost({ command: launch.command,
        args: [...prefix, ...args], cwd: launch.cwd, env: launch.env,
        ...(launch.launcherCwd ? { launcherCwd: launch.launcherCwd } : {}),
        ...(launch.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
        // Protocol bytes and credentials never enter captured command diagnostics.
        maxStdoutBytes: 0, maxStderrBytes: 0, release() {} }, { signal, pipeStdout: true });
    const stream = Duplex.from({ readable: process.child.stdout, writable: process.child.stdin });
    let closing: Promise<void> | undefined;
    return { stream, close: () => closing ??= (async () => {
        // Duplex.from emits AbortError when its live pipes are deliberately destroyed.
        stream.once('error', () => {});
        stream.destroy();
        await process.dispose();
        await process.waitForSettlement();
    })() };
}
