import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

export const CUA_DEPENDENCY_ID = 'cua-cli';
/** Shared local/BYOC prerequisite, including the reviewed sandbox exec -i / shell::stream carrier. */
export const CUA_CLI_MINIMUM_VERSION = '0.27.5';

/** Source selection owns version qualification; both Cua flows consume its ready executable. */
export async function resolveCuaExecutable(context: Pick<PluginInvocationContext, 'services' | 'signal'>): Promise<ManagedExecutableRef> {
    const status = await context.services.managedServices.dependencies.status(CUA_DEPENDENCY_ID, { signal: context.signal });
    // Only a status that says the CLI is absent is "not installed"; a failed status read says nothing about it.
    if (status.state === 'missing' || status.state === 'unsupported') throw new Error('cua_native_unavailable');
    if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) throw new Error('cua_native_status_unreadable');
    return status.executable;
}
