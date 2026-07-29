import { AsyncLocalStorage } from 'node:async_hooks';

export type HostingProviderExecutionAuthority = Readonly<{
    pluginId: string;
    generation: string;
    contributionId: string;
}>;

const storage = new AsyncLocalStorage<HostingProviderExecutionAuthority>();

export function runWithHostingProviderExecutionAuthority<T>(
    authority: HostingProviderExecutionAuthority,
    callback: () => T,
): T {
    return storage.run(Object.freeze({ ...authority }), callback);
}

export function readHostingProviderExecutionAuthority(): HostingProviderExecutionAuthority | null {
    return storage.getStore() ?? null;
}
