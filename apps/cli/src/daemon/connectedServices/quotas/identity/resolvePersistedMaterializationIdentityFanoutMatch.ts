import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

import type {
  PersistedSessionAccountIdentity,
  RuntimeAccountIdentityEntry,
} from './runtimeAccountIdentityTypes';

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function normalizeGeneration(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * Durable same-account fanout proof for the `provider_account_id` strategy (codex).
 *
 * A codex sibling only enters same-account fanout when a live runtime-identity probe VERIFIES its
 * account. That probe is frequently UNAVAILABLE (session busy, unsupported runtime method) or INEXACT,
 * and after a daemon restart the in-memory runtime identity index is cold, so the sibling gets
 * suppressed and later hits the SAME usage limit itself (live incident 2026-07-10 18:09).
 *
 * When the live probe cannot verify identity — but has NOT verified a genuine mismatch — the
 * candidate's PERSISTED materialization identity (provider account id + group binding, which survives
 * restarts) is an acceptable fallback proof, iff:
 *   - its provider account id equals the failing account, AND
 *   - its group binding matches the candidate entry (serviceId + groupId; generation consistent).
 *
 * Fail direction: these candidates are group-bound. The switch converges a group-bound session onto
 * the group's CURRENT active account — the correct destination even if the runtime had drifted — while
 * a VERIFIED mismatch (handled upstream) still vetoes genuinely different-account sessions. So a
 * durable persisted match is safe to fan out; the only false-positive it could admit is a session the
 * group would re-converge anyway.
 */
export function persistedSessionAccountIdentityMatchesFailingAccount(input: Readonly<{
  identity: PersistedSessionAccountIdentity;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  providerAccountId: string;
  candidate: Pick<RuntimeAccountIdentityEntry, 'serviceId' | 'groupId' | 'groupGeneration'>;
}>): boolean {
  const expectedProviderAccountId = trimOrNull(input.providerAccountId);
  const identityProviderAccountId = trimOrNull(input.identity.providerAccountId);
  if (!expectedProviderAccountId || !identityProviderAccountId) return false;
  if (identityProviderAccountId !== expectedProviderAccountId) return false;

  if (input.identity.serviceId !== input.serviceId) return false;
  if (input.candidate.serviceId !== input.serviceId) return false;

  const groupId = trimOrNull(input.groupId);
  const identityGroupId = trimOrNull(input.identity.groupId);
  const candidateGroupId = trimOrNull(input.candidate.groupId) ?? groupId;
  if (identityGroupId !== null && identityGroupId !== groupId) return false;
  if (candidateGroupId !== groupId) return false;

  // Generation consistency: a persisted generation must not contradict the candidate entry's
  // generation. Either side being unknown (null) is treated as consistent — the candidate entry's
  // generation was already validated upstream against the current group generation.
  const identityGeneration = normalizeGeneration(input.identity.groupGeneration);
  const candidateGeneration = normalizeGeneration(input.candidate.groupGeneration);
  if (identityGeneration !== null && candidateGeneration !== null && identityGeneration !== candidateGeneration) {
    return false;
  }

  return true;
}
