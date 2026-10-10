import { createProjectNativeEnvironmentIoForHost, type ProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeCommandIo } from './projectNativeResolution';
import { projectNativeSystemIo } from './projectNativeSystemIo';
import { findBuiltinNativeEnvironmentAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';

export type ProjectNativeIo = Readonly<{
    commandIo: ProjectNativeCommandIo;
    environmentIo: ProjectNativeEnvironmentIoForHost;
}>;

/** Host-only composition. Passive command IO never probes; admitted environment IO may characterize its installed tool. */
export function createProjectNativeIo(): ProjectNativeIo {
    const commandIo = projectNativeSystemIo;
    const environmentIo = createProjectNativeEnvironmentIoForHost({
        async resolveTool(tool, signal, scopedIo) {
            const adapter = findBuiltinNativeEnvironmentAdapterV1(tool, process.platform);
            if (!adapter || process.arch !== 'x64') return null;
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
