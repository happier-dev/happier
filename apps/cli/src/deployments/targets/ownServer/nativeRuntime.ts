import { homedir } from 'node:os';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createProjectNativeEnvironmentIoForHost as createProjectNativeToolchainIoForHost, createStablePluginExecService,
    type ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';

/** The installed Docker launch policy is shared by deployment and terminal
 * retention. Retention receives no source or secret-materialization port. */
export function createOwnServerNativeRuntime(input: Readonly<{
    cwd: string; buildExecutionDirectory?: string; signal: AbortSignal;
    /** Retained service IO outlives the finite Exec caller. Finite commands
     * still pass their operation signal on each native request. */
    nativeIoSignal?: AbortSignal;
    isCurrent(): boolean;
}>) {
    const baseEnv: Record<string, string> = { HOME: homedir() };
    for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
        const value = process.env[key];
        if (value !== undefined) baseEnv[key] = value;
    }
    const tools = createPluginExecSystemToolResolver({ baseEnv,
        definitions: [{ toolId: 'docker', displayName: 'Docker', lookupNames: ['docker'] }], registerGrant() {} });
    const exec = createStablePluginExecService({
        allowedExecutables: [],
        environment: baseEnv, signal: input.signal,
        isOccurrenceCurrent: input.isCurrent, systemTools: tools,
        async resolveExecutable() { throw new PluginError({ code: 'plugin_exec_executable_denied', message: 'A resolved Docker tool is required' }); },
        async resolvePath(path) {
            if (typeof path !== 'string' || path !== input.cwd && path !== input.buildExecutionDirectory) {
                throw Object.assign(new Error('Native cwd escaped its owner'), { code: 'outside_root' });
            }
            return path;
        } });
    const captures = new Set<ProjectNativeEffectCaptureForHost>();
    const nativeIo = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } })
        .createInvocation({ signal: input.nativeIoSignal ?? input.signal, retainCapture(capture) { captures.add(capture); } });
    const settleNative = async () => { await Promise.all([...captures].map(capture => capture.waitForSettlement())); };
    return { exec, nativeIo, settleNative };
}
