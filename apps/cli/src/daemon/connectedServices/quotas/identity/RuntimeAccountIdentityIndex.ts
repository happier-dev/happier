import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

import type {
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
} from './runtimeAccountIdentityTypes';

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function normalizeObservedAtMs(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function normalizeGeneration(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export class RuntimeAccountIdentityIndex {
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly bySessionId = new Map<string, RuntimeAccountIdentityEntry>();

  public constructor(params: Readonly<{ nowMs: () => number; ttlMs?: number }>) {
    this.nowMs = params.nowMs;
    this.ttlMs = typeof params.ttlMs === 'number' && Number.isFinite(params.ttlMs)
      ? Math.max(1, Math.trunc(params.ttlMs))
      : 5 * 60_000;
  }

  public record(input: RuntimeAccountIdentityRecordInput): RuntimeAccountIdentityRecordResult {
    if (input.proofStrength !== 'exact') {
      return { status: 'suppressed', reason: 'exact_provider_account_proof_required' };
    }
    const sessionId = trimOrNull(input.sessionId);
    if (!sessionId) return { status: 'suppressed', reason: 'missing_session_id' };
    const profileId = trimOrNull(input.profileId);
    if (!profileId) return { status: 'suppressed', reason: 'missing_profile_id' };
    const providerAccountId = trimOrNull(input.providerAccountId);
    if (!providerAccountId) return { status: 'suppressed', reason: 'missing_provider_account_id' };
    const observedAtMs = normalizeObservedAtMs(input.observedAtMs);
    if (observedAtMs === null) return { status: 'suppressed', reason: 'invalid_observed_at' };
    const groupId = trimOrNull(input.groupId);
    const groupGeneration = normalizeGeneration(input.groupGeneration);
    if (groupId && groupGeneration === null) {
      return { status: 'suppressed', reason: 'missing_group_generation' };
    }

    this.bySessionId.set(sessionId, {
      sessionId,
      serviceId: input.serviceId,
      groupId,
      profileId,
      providerAccountId,
      accountLabel: trimOrNull(input.accountLabel),
      observedAtMs,
      source: input.source,
      proofStrength: 'exact',
      groupGeneration,
    });
    return { status: 'recorded' };
  }

  public readSessionIdentity(sessionIdRaw: string): RuntimeAccountIdentityEntry | null {
    const sessionId = trimOrNull(sessionIdRaw);
    if (!sessionId) return null;
    const entry = this.bySessionId.get(sessionId) ?? null;
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.bySessionId.delete(sessionId);
      return null;
    }
    return entry;
  }

  public listByProviderAccount(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    providerAccountId: string;
    groupId?: string | null;
    excludeSessionId?: string | null;
    currentGroupGenerationBySessionId?: ReadonlyMap<string, number | null>;
  }>): RuntimeAccountIdentityEntry[] {
    const providerAccountId = trimOrNull(input.providerAccountId);
    if (!providerAccountId) return [];
    const groupId = input.groupId === undefined ? undefined : trimOrNull(input.groupId);
    const excludeSessionId = trimOrNull(input.excludeSessionId);
    const entries: RuntimeAccountIdentityEntry[] = [];
    for (const entry of this.bySessionId.values()) {
      if (this.isExpired(entry)) {
        this.bySessionId.delete(entry.sessionId);
        continue;
      }
      if (entry.serviceId !== input.serviceId) continue;
      if (entry.providerAccountId !== providerAccountId) continue;
      if (excludeSessionId && entry.sessionId === excludeSessionId) continue;
      if (groupId !== undefined && entry.groupId !== groupId) continue;
      const currentGeneration = input.currentGroupGenerationBySessionId?.get(entry.sessionId);
      if (entry.groupGeneration !== null && currentGeneration === undefined) continue;
      if (
        currentGeneration !== undefined
        && entry.groupGeneration !== null
        && normalizeGeneration(currentGeneration) !== entry.groupGeneration
      ) {
        continue;
      }
      entries.push(entry);
    }
    return entries.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  public invalidateSession(sessionIdRaw: string): void {
    const sessionId = trimOrNull(sessionIdRaw);
    if (!sessionId) return;
    this.bySessionId.delete(sessionId);
  }

  public clear(): void {
    this.bySessionId.clear();
  }

  private isExpired(entry: RuntimeAccountIdentityEntry): boolean {
    return this.nowMs() - entry.observedAtMs > this.ttlMs;
  }
}
