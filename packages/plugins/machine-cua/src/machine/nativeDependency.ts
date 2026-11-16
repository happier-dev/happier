import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

export const CUA_DEPENDENCY_ID = 'cua-cli';
/**
 * The oldest `cua` CLI that has every command and flag this plugin calls (`--embedded`, `sandbox
 * create/info/suspend/resume/rm/shell/cp`, `spaces ls/add/rm/create`, `runtime doctor`, `images
 * ls/info`, `cloud status`). Those were read from trycua/cua@2bce4442, which first shipped in
 * release cua-sdk-v0.3.0 (2026-10-03, listed under its Bug Fixes); `cua --version` reports that
 * release train. Older builds fail late inside a native call; this fails at check.
 */
export const CUA_CLI_MINIMUM_VERSION = '0.3.0';
/** Reviewed local Session carrier contract: cua-sdk-v0.27.5, sandbox exec -i / shell::stream. */
export const CUA_CLI_LOCAL_MINIMUM_VERSION = '0.27.5';

function atLeast(version: string, floor: string): boolean {
    const parse = (value: string) => value.match(/^\d+(?:\.\d+){0,2}/u)?.[0].split('.').map(Number) ?? null;
    const have = parse(version), need = parse(floor);
    if (!have || !need) return false;
    for (let index = 0; index < 3; index += 1) {
        const difference = (have[index] ?? 0) - (need[index] ?? 0);
        if (difference !== 0) return difference > 0;
    }
    return true;
}

/** The one place the managed `cua` dependency becomes an executable: installed, and not older than the floor. */
export async function resolveCuaExecutable(context: Pick<PluginInvocationContext, 'services' | 'signal'>,
    minimumVersion = CUA_CLI_MINIMUM_VERSION): Promise<ManagedExecutableRef> {
    const status = await context.services.managedServices.dependencies.status(CUA_DEPENDENCY_ID, { signal: context.signal });
    // Only a status that says the CLI is absent is "not installed"; a failed status read says nothing about it.
    if (status.state === 'missing' || status.state === 'unsupported') throw new Error('cua_native_unavailable');
    if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) throw new Error('cua_native_status_unreadable');
    if (!atLeast(status.version, minimumVersion)) throw new Error('cua_native_outdated');
    return status.executable;
}
