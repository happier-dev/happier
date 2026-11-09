import { createProjectNativeToolchainIoForHost, type ProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeCommandIo } from './projectNativeResolution';
import { projectNativeSystemIo } from './projectNativeSystemIo';
import { findBuiltinNativeToolchainAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';

export type ProjectNativeIo = Readonly<{
    commandIo: ProjectNativeCommandIo;
    environmentIo: ProjectNativeToolchainIoForHost;
}>;

/** Host-only composition. Passive command IO never probes; admitted environment IO may characterize its installed tool. */
export function createProjectNativeIo(input: Readonly<{ ownerRemainder?: OwnerRemainderPort;
    agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext }> = {}): ProjectNativeIo {
    const commandIo = projectNativeSystemIo;
    const environmentIo = createProjectNativeToolchainIoForHost({
        ownerRemainder: input.ownerRemainder,
        agentIsolation: input.agentIsolation,
        async resolveTool(tool, signal, scopedIo) {
            const adapter = findBuiltinNativeToolchainAdapterV1(tool, process.platform);
            if (!adapter || process.arch !== adapter.architecture) return null;
            const resolved = await commandIo.resolveTool(adapter.executable, { cwd: process.cwd(), ...(signal ? { signal } : {}) });
            if (!resolved) return null;
            if (resolved.version) return Object.freeze({ executablePath: resolved.executablePath, args: resolved.args, version: resolved.version });
            // Version-only CLI commands are characterized independently of
            // Project evaluation and share its operation-scoped custody.
            const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
            const output = await scopedIo.run({ command: resolved.executablePath, args: [...(resolved.args ?? []), ...adapter.versionArgs],
                cwd: process.cwd(), env, ...(signal ? { signal } : {}) });
            signal?.throwIfAborted();
            if (output.exitCode !== 0) return null;
            const version = new RegExp(adapter.versionPattern).exec(output.stdout)?.[1];
            return version ? Object.freeze({ executablePath: resolved.executablePath, args: resolved.args ?? [], version }) : null;
        },
    });
    return Object.freeze({ commandIo, environmentIo });
}
