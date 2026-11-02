import { isDeepStrictEqual } from 'node:util';
import { waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { configuration } from '@/configuration';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { resolveRequesterSessionExecutionIdentityForHost, type RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '@/daemon/types';
import { readStoredCredentialsForServerId, sameStoredCredentials, type StoredCredentials } from '@/persistence';

/** One invocation-owned qualification; each native launch owns only its wait
 * and subsequent fresh authority checks, never a sibling's shared read. */
export function createRunnerIsolationIdentity(input: Readonly<{
  signal: AbortSignal;
  serverId: string;
  serverBaseUrl: string;
  machineId: string;
  sessionId: string;
  credentials: StoredCredentials;
  custodianAccountId?: string | null;
  tracked: TrackedSession;
  origin: CurrentMachineExecutionOriginContext | null;
  readOrigin?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
  isCurrent(): boolean;
  resolveRuntime?: (signal: AbortSignal) => Promise<RequesterSessionRuntimeContext | null>;
  releaseRuntime(context: RequesterSessionRuntimeContext | null): Promise<void>;
}>) {
  let identity: Promise<HostRequesterExecutionIdentity> | undefined;
  let runtime: RequesterSessionRuntimeContext | null | undefined;
  const attribution = input.tracked.requesterWorkAttributionV1 ?? input.tracked.spawnOptions?.requesterWorkAttributionV1;
  const isCurrent = async (signal = input.signal) => {
    signal.throwIfAborted();
    if (input.signal.aborted || !input.isCurrent() || !input.origin || input.origin.machineId !== input.machineId) return false;
    const current = await waitForObservation(input.readOrigin?.(signal) ?? Promise.resolve(null), signal);
    signal.throwIfAborted();
    return !input.signal.aborted && input.isCurrent() && isDeepStrictEqual(input.origin, current);
  };
  const resolve = async (launchSignal?: AbortSignal): Promise<HostRequesterExecutionIdentity> => {
    const signal = launchSignal ? AbortSignal.any([input.signal, launchSignal]) : input.signal;
    signal.throwIfAborted();
    identity ??= (async () => {
      runtime = input.tracked.requesterSessionRuntimeContext ?? await input.resolveRuntime?.(input.signal) ?? null;
      try {
        return await resolveRequesterSessionExecutionIdentityForHost({
          happyHomeDir: configuration.happyHomeDir, serverId: input.serverId,
          serverHttpBaseUrl: input.serverBaseUrl, machineId: input.machineId, sessionId: input.sessionId,
          credentials: input.credentials, attribution, runtimeContext: runtime,
          hostHomeServerIdentityId: input.origin?.machineId === input.machineId ? input.origin.serverIdentityId : null,
          sessionCustodianAccountId: input.custodianAccountId,
          isCurrent: () => isCurrent(), signal: input.signal,
        });
      } finally { await input.releaseRuntime(runtime ?? null); }
    })();
    const resolved = await waitForObservation(identity, signal);
    signal.throwIfAborted();
    if (!await isCurrent(signal) || runtime && (input.tracked.requesterSessionRuntimeContext !== runtime
      || !await waitForObservation(runtime.isCurrent(signal), signal))) return { kind: 'unknown', reason: 'session_requester_unavailable' };
    if (!runtime && resolved.kind === 'isolated') {
      try {
        const credentials = await waitForObservation(readStoredCredentialsForServerId(input.serverId), signal);
        if (!sameStoredCredentials(input.credentials, credentials)
          || readInstallationIdentityIfExistsSync()?.installationId !== resolved.requester.installationId
          || !await isCurrent(signal)) return { kind: 'unknown', reason: 'session_requester_unavailable' };
      } catch { signal.throwIfAborted(); return { kind: 'unknown', reason: 'session_requester_unavailable' }; }
      signal.throwIfAborted();
    }
    return resolved;
  };
  return { resolve, isCurrent };
}
