import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScmActionExecute } from '@happier-dev/protocol';

export type HostingProviderExecutionAuthority = Readonly<{
    pluginId: string;
    occurrenceId: string;
    contributionId: string;
}>;

export type ExecuteHostingProviderAction = NonNullable<Parameters<ScmActionExecute>[0]['executeHostingProviderAction']>;
type HostingExecutionScope = Readonly<{
    authority?: HostingProviderExecutionAuthority;
    executeAction?: ExecuteHostingProviderAction;
}>;
const storage = new AsyncLocalStorage<HostingExecutionScope>();

/** Private root callback follows the admitted SCM operation through provider calls. */
export function runWithScmHostingActionExecutor<T>(executeAction: ExecuteHostingProviderAction | undefined, callback: () => T): T {
    return storage.run({ ...storage.getStore(), ...(executeAction ? { executeAction } : {}) }, callback);
}
export function readScmHostingActionExecutor(): ExecuteHostingProviderAction | undefined {
    return storage.getStore()?.executeAction;
}

export function runWithHostingProviderExecutionAuthority<T>(
    authority: HostingProviderExecutionAuthority,
    callback: () => T,
): T {
    return storage.run({ ...storage.getStore(), authority: Object.freeze({ ...authority }) }, callback);
}

export function readHostingProviderExecutionAuthority(): HostingProviderExecutionAuthority | null {
    return storage.getStore()?.authority ?? null;
}
