import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import type { BuiltInLegacyConnectedAccountOperation, ConnectedServiceId, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { QualifiedConnectedAccountPeerOperationTransport } from '@/api/client/qualifiedConnectedAccountApi';
import type { SingleFlightLoopSchedule } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import type { ConnectedServiceRuntimeRefreshTarget, ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import type { CredentialHealthReprobeState } from './credentialHealthReprobe';
import type { ConnectedServiceCredentialRefreshResult, QualifiedConnectedAccountRefreshRuntime, ScheduledQualifiedAccountHealth } from './ConnectedServiceRefreshCoordinator';

export type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
export type ScheduledHealthProbe = Readonly<{ at: number; basis?: string }
  & Partial<Pick<QualifiedConnectedAccountProfileV4, 'credentialRevision' | 'configurationRevision'>>>;

export function bindingKey(binding: BoundProfile): string {
  return `${binding.serviceId}/${binding.profileId}`;
}

export function qualifiedAccountKey(account: QualifiedConnectedAccountRef): string {
  return JSON.stringify([
    account.service.pluginId,
    account.service.localId,
    account.accountId,
  ]);
}

export async function runConnectedServiceRefreshTick(input: Readonly<{
  now(): number;
  refreshWindowMs: number;
  healthProbeIntervalMs: number;
  runtimeRegistry: Pick<ConnectedServiceRuntimeRegistry, 'listRefreshTargets'>;
  qualifiedConnectedAccountRuntime?: QualifiedConnectedAccountRefreshRuntime;
  isAccountRuntimeCurrent?: (signal?: AbortSignal) => Promise<boolean>;
  credentialHealthReprobeState: ReadonlyMap<string, CredentialHealthReprobeState>;
  scheduledHealthProbeAtByKey: Map<string, ScheduledHealthProbe>;
  resolveBoundProfiles(target: ConnectedServiceRuntimeRefreshTarget): readonly BoundProfile[];
  resolveOperationTransport(binding: BoundProfile, operation: BuiltInLegacyConnectedAccountOperation): QualifiedConnectedAccountPeerOperationTransport | null;
  isOperationAvailable(binding: BoundProfile, operation: BuiltInLegacyConnectedAccountOperation): boolean;
  maybeRefreshBinding(binding: BoundProfile, now: number, signal?: AbortSignal): Promise<ConnectedServiceCredentialRefreshResult>;
  prepareScheduledQualifiedHealth(profile: QualifiedConnectedAccountProfileV4, now: number, signal?: AbortSignal): ScheduledQualifiedAccountHealth;
}>, options?: Readonly<{ skipQualified?: boolean; signal?: AbortSignal }>): Promise<SingleFlightLoopSchedule> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const now = input.now();
  let nextRunAt: number | null = null;
  const scheduleAt = (deadline: number | null | undefined): void => {
    if (typeof deadline === 'number' && Number.isFinite(deadline)) {
      nextRunAt = nextRunAt === null ? deadline : Math.min(nextRunAt, deadline);
    }
  };
  const unique = new Map<string, BoundProfile>();
  const qualified = new Map<string, QualifiedConnectedAccountProfileV4>();
  const errors: unknown[] = [];

  for (const target of input.runtimeRegistry.listRefreshTargets()) {
    for (const binding of input.resolveBoundProfiles(target)) {
      unique.set(bindingKey(binding), binding);
    }
  }

  const qualifiedRuntime = input.qualifiedConnectedAccountRuntime;
  const shouldRefreshBinding = (binding: BoundProfile): boolean => !options?.skipQualified
    || input.resolveOperationTransport(binding, 'credential_health')?.kind !== 'v4';
  const wantsQualifiedInventory = (): boolean => !options?.skipQualified
    && qualifiedRuntime?.resolvePeerClass() === 'advertised_v4'
    && qualifiedRuntime.listScheduledAccounts !== undefined;
  let hasSelectedBinding = false;
  for (const binding of unique.values()) {
    if (shouldRefreshBinding(binding)) { hasSelectedBinding = true; break; }
  }
  // Empty or quota-owned wakes need no admission. Selected work retains the
  // incumbent negative-currentness parking result and fresh operation fences.
  if ((hasSelectedBinding || wantsQualifiedInventory())
    && input.isAccountRuntimeCurrent && !await input.isAccountRuntimeCurrent(signal)) {
    return { nextAutomaticRunAfterMs: null };
  }
  if (wantsQualifiedInventory() && qualifiedRuntime?.listScheduledAccounts) {
    try {
      for (const profile of await qualifiedRuntime.listScheduledAccounts(undefined, signal)) {
        qualified.set(qualifiedAccountKey(profile.ref), profile);
      }
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(error);
    }
  }

  for (const binding of unique.values()) {
    if (!shouldRefreshBinding(binding)) continue;
    try {
      const key = bindingKey(binding);
      const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[binding.serviceId];
      const account = { service: compatibility.service, accountId: binding.profileId };
      const profile = qualified.get(qualifiedAccountKey(account));
      const qualifiedHealth = input.resolveOperationTransport(binding, 'credential_health')?.kind === 'v4';
      if (qualifiedHealth && profile) {
        // The same qualified health deadline/settlement owns bound and unbound
        // Accounts. Its bound settlement retains native distribution.
        input.scheduledHealthProbeAtByKey.delete(key);
        continue;
      }
      const basis = qualifiedHealth ? JSON.stringify([profile?.credentialRevision,
        profile?.configurationRevision, profile?.authenticationModeId, profile?.status,
        profile?.kind, profile?.expiresAt, input.isOperationAvailable(binding, 'credential_health')]) : undefined;
      if (basis !== undefined && input.scheduledHealthProbeAtByKey.get(key)?.basis !== basis) {
        input.scheduledHealthProbeAtByKey.set(key, { at: -Infinity, basis });
      }
      const retryAt = input.credentialHealthReprobeState.get(key)?.nextProbeAt;
      const probeAt = retryAt ?? input.scheduledHealthProbeAtByKey.get(key)?.at;
      if (probeAt !== undefined && probeAt > now) {
        scheduleAt(probeAt);
      } else {
        const result = await input.maybeRefreshBinding(binding, now, signal);
        const retryAt = input.credentialHealthReprobeState.get(key)?.nextProbeAt;
        let nextProbeAt = retryAt
          ?? (qualifiedHealth ? Infinity : input.qualifiedConnectedAccountRuntime && input.isOperationAvailable(binding, 'credential_health')
            // Slow Home reads must not consume the next observation's interval.
            ? input.now() + input.healthProbeIntervalMs : undefined);
        const expiryDeadline = result.diagnostic.expiresAt === null ? null
          : result.diagnostic.expiresAt - input.refreshWindowMs;
        if (retryAt === undefined && expiryDeadline !== null && expiryDeadline > now) {
          nextProbeAt = nextProbeAt === undefined ? expiryDeadline : Math.min(nextProbeAt, expiryDeadline);
        }
        if (nextProbeAt !== undefined) input.scheduledHealthProbeAtByKey.set(key, { at: nextProbeAt, basis });
        scheduleAt(nextProbeAt);
      }
      qualified.delete(qualifiedAccountKey({
        service: compatibility.service,
        accountId: binding.profileId,
      }));
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(error);
    }
  }

  for (const profile of qualified.values()) {
    try {
      const work = input.prepareScheduledQualifiedHealth(profile, now, signal);
      if (work.due && qualifiedRuntime) {
        const [outcome] = await Promise.allSettled([qualifiedRuntime.establishedRuntimeOwner.invokeWithReceipt({ ...(signal ? { signal } : {}),
          account: profile.ref, operation: { kind: 'status' as const },
        })]);
        await work.settle(outcome, signal);
      }
      scheduleAt(work.nextDeadline());
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Connected services refresh tick failed');
  }
  const liveKeys = new Set([...unique.keys(), ...[...qualified.values()].map(profile => `qualified:${qualifiedAccountKey(profile.ref)}`)]);
  for (const key of input.scheduledHealthProbeAtByKey.keys()) {
    if (options?.skipQualified && key.startsWith('qualified:')) continue;
    if (!liveKeys.has(key)) input.scheduledHealthProbeAtByKey.delete(key);
  }
  return { nextAutomaticRunAfterMs: nextRunAt === null ? null : Math.max(1, nextRunAt - input.now()) };
}
