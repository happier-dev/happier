import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

/**
 * The daemon's fresh server/machine identity source for a machine-scoped
 * execution origin. This intentionally reads the live capability response;
 * feature-snapshot caches retain last-known-good values and cannot stamp
 * execution authority.
 */
export type CurrentMachineExecutionOriginContext = Readonly<{
  serverIdentityId: string;
  machineId: string;
}>;

export function createCurrentMachineExecutionOriginContextResolver(params: Readonly<{
  serverUrl: string;
  resolveCurrentMachineId(): string | null;
  timeoutMs?: number;
}>): (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null> {
  return async (signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null> => {
    signal?.throwIfAborted();
    const snapshot = await fetchServerFeaturesSnapshot({
      serverUrl: params.serverUrl,
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    });
    signal?.throwIfAborted();
    const serverIdentityId = snapshot.status === 'ready'
      ? snapshot.features.capabilities.serverIdentity.serverIdentityId
      : null;
    let machineId: string | null;
    try {
      machineId = params.resolveCurrentMachineId();
    } catch {
      return null;
    }
    return serverIdentityId && machineId
      ? Object.freeze({ serverIdentityId, machineId })
      : null;
  };
}
