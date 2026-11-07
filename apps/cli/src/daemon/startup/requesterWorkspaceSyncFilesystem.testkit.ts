import { AsyncLocalStorage } from 'node:async_hooks';

export const requesterWorkspaceSyncTargetInstallationFiles = new AsyncLocalStorage<Readonly<{ path: string; identity: string }>>();

/** Each genuine receiver reads its own installation file at the filesystem boundary. */
export function requesterWorkspaceSyncInstallationFilesystemBoundary(actual: typeof import('node:fs')) {
  return { ...actual, readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
    const selected = requesterWorkspaceSyncTargetInstallationFiles.getStore();
    return selected && String(path) === selected.path ? selected.identity : Reflect.apply(actual.readFileSync, actual, [path, ...args]);
  }) as typeof actual.readFileSync };
}
