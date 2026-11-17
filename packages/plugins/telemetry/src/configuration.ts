import { requireAccountStorage, type PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

export type CaptureProjectScope = Readonly<{ serverId: string; machineId: string; projectId: string }>;
function key(scope: CaptureProjectScope): string { return `capture:${JSON.stringify([scope.serverId, scope.machineId, scope.projectId])}`; }
/** Account-mode and Account admission remain at the SDK storage owner. */
export async function readCapturePreference(storage: PluginAccountStorageScope | undefined, scope: CaptureProjectScope): Promise<boolean> {
 const account = requireAccountStorage({ services: { storage: { account: storage } } }, { code: 'plugin_service_unavailable', message: 'Capture preferences require Account storage' });
 const entry = await account.kv.get(key(scope));
 return entry !== null && !('deleted' in entry) && entry.value === true;
}
export async function configureCapturePreference(storage: PluginAccountStorageScope | undefined, scope: CaptureProjectScope, enabled: boolean): Promise<void> {
 const account = requireAccountStorage({ services: { storage: { account: storage } } }, { code: 'plugin_service_unavailable', message: 'Capture preferences require Account storage' });
 await account.kv.transaction(async tx => {
  const entry = await tx.get(key(scope));
  const current = entry !== null && !('deleted' in entry) && entry.value === true;
  if (current === enabled) return;
  await tx.set(key(scope), enabled, { expectedVersion: entry?.version ?? 'absent' });
 });
}
