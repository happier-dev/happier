import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import * as accountUsageModule from './accountUsage.js';
import { ConnectedServiceQuotaSnapshotV1Schema, SealedConnectedServiceQuotaSnapshotV1Schema } from './connectedServiceSchemas.js';
import * as protocol from '../index.js';
import { ReleasedProviderAccountUsageSnapshotV1Schema, ReleasedSealedProviderAccountUsageSnapshotV1Schema, ReleasedProviderAccountUsagePlainWriteSchema } from './fixtures/releasedV0216AccountUsage.js';

type ProviderAccountUsageRecordKeyV1 = Readonly<{
  providerId: string;
  accountSubjectId: string;
  subjectKind: string;
  quotaScope: string;
  quotaScopeId?: string;
}>;

type ProviderAccountUsageSnapshotV1 = Readonly<{
  v: 1;
  recordId: string;
  recordKey: ProviderAccountUsageRecordKeyV1;
  providerId: string;
  accountSubject: Readonly<{ kind: string; id: string; mergeKey?: string }>;
  observedAtMs: number;
  fetchedAtMs: number;
  staleAfterMs: number;
  source: string;
  confidence: string;
  state?: string;
  planLabel?: string | null;
  accountLabel?: string | null;
  meters: readonly unknown[];
  recoveryCredits?: unknown;
}>;

type Parser<T> = Readonly<{
  parse: (input: unknown) => T;
  safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown };
}>;

function requireExport<T>(name: string, predicate: (value: unknown) => value is T): T {
  const value = (protocol as Record<string, unknown>)[name];
  expect(predicate(value)).toBe(true);
  return value as T;
}

function isFunction(value: unknown): value is (...args: readonly unknown[]) => unknown {
  return typeof value === 'function';
}

function isParser<T>(value: unknown): value is Parser<T> {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { parse?: unknown }).parse === 'function'
    && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

function canonicalKeyJson(key: ProviderAccountUsageRecordKeyV1): string {
  return JSON.stringify({
    providerId: key.providerId,
    accountSubjectId: key.accountSubjectId,
    subjectKind: key.subjectKind,
    quotaScope: key.quotaScope,
    ...(key.quotaScopeId ? { quotaScopeId: key.quotaScopeId } : {}),
  });
}

function expectedRecordId(key: ProviderAccountUsageRecordKeyV1): string {
  return `paug_v1_${createHash('sha256').update(canonicalKeyJson(key)).digest('base64url')}`;
}

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
  const recordKey = overrides.recordKey ?? {
    providerId: 'codex',
    accountSubjectId: 'acct_secret_provider_subject',
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: overrides.recordId ?? expectedRecordId(recordKey),
    recordKey,
    providerId: overrides.providerId ?? recordKey.providerId,
    accountSubject: overrides.accountSubject ?? {
      kind: 'providerSubject',
      id: recordKey.accountSubjectId,
    },
    observedAtMs: overrides.observedAtMs ?? 1_700_000_000_000,
    fetchedAtMs: overrides.fetchedAtMs ?? 1_700_000_000_000,
    staleAfterMs: overrides.staleAfterMs ?? 60_000,
    source: overrides.source ?? 'runtimeSignal',
    confidence: overrides.confidence ?? 'confirmed',
    state: overrides.state ?? 'loaded_data',
    planLabel: overrides.planLabel ?? 'Pro',
    accountLabel: overrides.accountLabel ?? 'work@example.com',
    ...(overrides.recoveryCredits ? { recoveryCredits: overrides.recoveryCredits } : {}),
    meters: overrides.meters ?? [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 82,
      limit: 100,
      remaining: 18,
      remainingPct: 18,
      usedPct: 82,
      resetAtMs: 1_700_003_600_000,
      resetSource: 'provider',
      unit: 'credits',
      utilizationPct: 82,
      resetsAt: 1_700_003_600_000,
      status: 'ok',
      source: 'in_band_provider_snapshot',
      scope: 'weekly',
      limitScope: 'account',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

describe('provider account usage protocol', () => {
  it('carries an independently fresh subscription without converting unknown renewal to cancellation', () => {
    const subscription = {
      status: 'subscribed', renewal: 'unknown', observedAtMs: 900, staleAfterMs: 60_000,
      currentPeriodEndAtMs: 1_800_000_000_000,
    };
    const parsed = accountUsageModule.ProviderAccountUsageSnapshotV1Schema.safeParse({ ...createSnapshot(), subscription });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toHaveProperty('subscription', subscription);
  });

  it('splits subscription from the strict released snapshot without losing account identity', () => {
    const split = requireExport<(...args: readonly unknown[]) => unknown>('splitProviderAccountUsageSubscription', isFunction);
    const base = createSnapshot();
    const subscription = { status: 'none', renewal: 'unknown', observedAtMs: 900, staleAfterMs: 60_000 };
    expect(split({ ...base, subscription })).toEqual({ snapshot: base, subscription });
  });

  it('keeps the sealed base compatible and binds supplemental facts to their account observation', () => {
    const seal = requireExport<(input: unknown) => { ciphertext: string; subscription?: unknown; recoveryCreditDetails?: unknown }>('sealProviderAccountUsageSnapshot', isFunction);
    const open = requireExport<(input: unknown) => unknown>('openSealedProviderAccountUsageSnapshot', isFunction);
    const material = { type: 'legacy', secret: new Uint8Array(32).fill(7) } as const;
    const base = createSnapshot();
    const subscription = { status: 'subscribed', renewal: 'off', observedAtMs: 900, staleAfterMs: 60_000, currentPeriodEndAtMs: 1_800_000_000_000 };
    const recoveryCreditDetails = { grant: { remainingCount: 2, appliesToProviderLimitIds: ['five_hour', 'seven_day'], unavailableReason: 'cooldown' } };
    const sealed = seal({ material, snapshot: { ...base, subscription, recoveryCreditDetails }, randomBytes: (length: number) => new Uint8Array(length).fill(3) });
    const quotaEnvelope = SealedConnectedServiceQuotaSnapshotV1Schema.parse(sealed);
    expect(open({ material, sealed: quotaEnvelope })).toEqual({ ...base, subscription, recoveryCreditDetails });
    expect(accountUsageModule.openProviderAccountUsageSnapshotCiphertext({ material, ciphertext: sealed.ciphertext })?.value).toEqual(base);
    expect(open({ material, sealed })).toEqual({ ...base, subscription, recoveryCreditDetails });
    const other = createSnapshot({ recordKey: { ...base.recordKey, accountSubjectId: 'other' } });
    const otherSealed = seal({ material, snapshot: other, randomBytes: (length: number) => new Uint8Array(length).fill(4) });
    expect(open({ material, sealed: { ...otherSealed, subscription: sealed.subscription } })).toBeNull();
    expect(open({ material, sealed: { ...otherSealed, recoveryCreditDetails: sealed.recoveryCreditDetails } })).toBeNull();
    const newer = seal({ material, snapshot: { ...base, fetchedAtMs: base.fetchedAtMs + 1 }, randomBytes: (length: number) => new Uint8Array(length).fill(4) });
    expect(open({ material, sealed: { ...newer, recoveryCreditDetails: sealed.recoveryCreditDetails } })).toBeNull();

    // The released outer reader ignores the facet, and its strict body still decodes.
    const releasedEnvelope = ReleasedSealedProviderAccountUsageSnapshotV1Schema.parse(sealed);
    expect(releasedEnvelope).not.toHaveProperty('recoveryCreditDetails');
    const releasedBase = accountUsageModule.openProviderAccountUsageSnapshotCiphertext({ material, ciphertext: releasedEnvelope.ciphertext });
    expect(ReleasedProviderAccountUsageSnapshotV1Schema.parse(releasedBase?.value)).toEqual(base);
    expect(ReleasedProviderAccountUsageSnapshotV1Schema.safeParse({ ...base, recoveryCreditDetails }).success).toBe(false);
    // New readers accept released envelopes without requiring display facts.
    expect(open({ material, sealed: otherSealed })).toEqual(other);

    const split = accountUsageModule.splitProviderAccountUsageSupplementalFacets(
      accountUsageModule.ProviderAccountUsageSnapshotV1Schema.parse({ ...base, recoveryCreditDetails }),
    );
    const releasedWrite = { content: { t: 'plain', v: split.snapshot }, metadata: { fetchedAt: base.fetchedAtMs, staleAfterMs: base.staleAfterMs, status: 'ok' } };
    expect(ReleasedProviderAccountUsagePlainWriteSchema.safeParse(releasedWrite).success).toBe(true);
    expect(ReleasedProviderAccountUsageSnapshotV1Schema.parse(split.snapshot)).toEqual(base);
    // Strict older writers need the explicit server bit before sending this facet.
    expect(ReleasedProviderAccountUsagePlainWriteSchema.safeParse({ ...releasedWrite, metadata: { ...releasedWrite.metadata, recoveryCreditDetails } }).success).toBe(false);
  });

  it('builds opaque stable record ids from canonical record keys', () => {
    const buildRecordId = requireExport<(...args: readonly unknown[]) => unknown>(
      'buildProviderAccountUsageRecordId',
      isFunction,
    );
    const key = {
      providerId: 'codex',
      accountSubjectId: 'acct_secret_provider_subject',
      subjectKind: 'account',
      quotaScope: 'account',
    };

    const recordId = buildRecordId(key);

    expect(recordId).toBe(expectedRecordId(key));
    expect(recordId).toMatch(/^paug_v1_[A-Za-z0-9_-]+$/);
    expect(String(recordId)).not.toContain('acct_secret_provider_subject');
  });

  it('parses alias-free snapshots and keeps legacy alias helpers out of the public contract', () => {
    const snapshotSchema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
      'ProviderAccountUsageSnapshotV1Schema',
      isParser,
    );

    expect((protocol as Record<string, unknown>).normalizeProviderAccountUsageAliases).toBeUndefined();
    expect((protocol as Record<string, unknown>).ProviderAccountUsageAliasV1Schema).toBeUndefined();

    const result = snapshotSchema.safeParse({
      ...createSnapshot(),
      aliases: [{
        kind: 'connectedServiceProfile',
        providerId: 'codex',
        serviceId: 'openai-codex',
        profileId: 'work',
        accountSubjectId: 'acct_secret_provider_subject',
      }],
    });

    expect(snapshotSchema.safeParse(createSnapshot()).success).toBe(true);
    expect(result.success).toBe(false);
  });

  it('builds opaque local credential refs without leaking raw path material', () => {
    const buildLocalCredentialRef = requireExport<(...args: readonly unknown[]) => unknown>(
      'buildProviderAccountUsageOpaqueLocalCredentialRef',
      isFunction,
    );
    const maxSchemaCompatibleProviderId = 'p'.repeat(102);
    const maxSchemaCompatibleKind = 'k'.repeat(102);

    const ref = buildLocalCredentialRef({
      providerId: maxSchemaCompatibleProviderId,
      kind: maxSchemaCompatibleKind,
      value: '/Users/alice/.codex/auth.json',
    });

    expect(String(ref)).toHaveLength(256);
    expect(String(ref)).toMatch(/^opaque:/);
    expect(String(ref)).not.toContain('/Users/alice/.codex/auth.json');
    expect(() => buildLocalCredentialRef({
      providerId: 'p'.repeat(103),
      kind: maxSchemaCompatibleKind,
      value: 'credential',
    })).toThrow();
    expect(() => buildLocalCredentialRef({
      providerId: maxSchemaCompatibleProviderId,
      kind: 'k'.repeat(103),
      value: 'credential',
    })).toThrow();
  });

  it('parses canonical snapshots with shared meter semantics and rejects mismatched ids', () => {
    const snapshotSchema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
      'ProviderAccountUsageSnapshotV1Schema',
      isParser,
    );

    const snapshot = snapshotSchema.parse(createSnapshot());

    expect(snapshot.recordId).toBe(expectedRecordId(snapshot.recordKey));
    expect(snapshot.meters[0]).toEqual(expect.objectContaining({
      remainingPct: 18,
      usedPct: 82,
      limitScope: 'account',
      confidence: 'exact',
    }));
    expect(snapshotSchema.safeParse({
      ...createSnapshot(),
      recordId: expectedRecordId({
        providerId: 'codex',
        accountSubjectId: 'acct_other',
        subjectKind: 'account',
        quotaScope: 'account',
      }),
    }).success).toBe(false);
  });

  it('rejects diagnostics that can leak raw credential material', () => {
    const snapshotSchema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
      'ProviderAccountUsageSnapshotV1Schema',
      isParser,
    );

    expect(snapshotSchema.safeParse({
      ...createSnapshot(),
      diagnostics: [{
        kind: 'provider_http',
        headers: {
          authorization: 'Bearer secret',
        },
      }],
    }).success).toBe(false);

    expect(snapshotSchema.safeParse({
      ...createSnapshot(),
      diagnostics: [{
        kind: 'provider_http',
        message: 'provider failed with authorization: bearer sk-secret-token-value-1234567890',
      }],
    }).success).toBe(false);

    expect(snapshotSchema.safeParse({
      ...createSnapshot(),
      diagnostics: [{
        kind: 'provider_http',
        headers: {
          'x-provider-debug': 'sk-abcdefghijklmnopqrstuvwxyz',
        },
      }],
    }).success).toBe(false);
  });

  it('keeps alias and adoption compatibility helpers off the public module surfaces', () => {
    expect((protocol as Record<string, unknown>).ProviderAccountUsageAdoptionV1Schema).toBeUndefined();
    expect((protocol as Record<string, unknown>).normalizeProviderAccountUsageAliases).toBeUndefined();

    expect((accountUsageModule as Record<string, unknown>).ProviderAccountUsageAliasV1Schema).toBeUndefined();
    expect((accountUsageModule as Record<string, unknown>).ProviderAccountUsageAdoptionV1Schema).toBeUndefined();
    expect((accountUsageModule as Record<string, unknown>).normalizeProviderAccountUsageAliases).toBeUndefined();
  });

  it('projects provider account usage snapshots to connected-service quota compatibility snapshots', () => {
    const snapshotSchema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
      'ProviderAccountUsageSnapshotV1Schema',
      isParser,
    );
    const projectSnapshot = requireExport<(...args: readonly unknown[]) => unknown>(
      'projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1',
      isFunction,
    );
    const snapshot = snapshotSchema.parse(createSnapshot({
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        totalCount: 1,
        credits: [{
          kind: 'usage_limit_reset',
          status: 'available',
        }],
      },
    }));

    const projected = projectSnapshot({
      snapshot,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    });

    expect(projected).toEqual(expect.objectContaining({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: snapshot.fetchedAtMs,
      staleAfterMs: snapshot.staleAfterMs,
      providerId: 'codex',
      activeAccountId: snapshot.accountSubject.id,
      source: 'in_band_provider_snapshot',
      confidence: 'exact',
      recoveryCredits: expect.objectContaining({
        kind: 'usage_limit_resets',
        availableCount: 1,
      }),
      meters: snapshot.meters,
    }));
  });

  it('preserves organization quota scope without replacing the provider account identity', () => {
    const recordKey = {
      providerId: 'claude', accountSubjectId: 'acct-user', subjectKind: 'account',
      quotaScope: 'organization', quotaScopeId: 'org-work',
    };
    const projected = accountUsageModule.projectProviderAccountUsageToConnectedServiceQuotaSnapshot(
      accountUsageModule.ProviderAccountUsageSnapshotV1Schema.parse(createSnapshot({ recordKey })),
      { serviceId: 'anthropic', profileId: 'work', bindingKind: 'profile' },
    );

    expect(ConnectedServiceQuotaSnapshotV1Schema.parse(projected)).toMatchObject({
      activeAccountId: 'acct-user',
      providerOrganizationId: 'org-work',
    });
    expect(ReleasedProviderAccountUsageSnapshotV1Schema.safeParse(createSnapshot({ recordKey })).success).toBe(true);
  });

  it('does not invent organization context for account-only quota snapshots', () => {
    const projected = accountUsageModule.projectProviderAccountUsageToConnectedServiceQuotaSnapshot(
      accountUsageModule.ProviderAccountUsageSnapshotV1Schema.parse(createSnapshot()),
      { serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' },
    );
    expect(projected).not.toHaveProperty('providerOrganizationId');
  });

  it('does not export the connected-service quota back-projection helper', () => {
    expect((protocol as Record<string, unknown>).projectConnectedServiceQuotaSnapshotToProviderAccountUsageSnapshotV1)
      .toBeUndefined();
  });

  it('does not export a connected-service quota sealing helper for durable persistence', () => {
    expect((protocol as Record<string, unknown>).sealConnectedServiceQuotaSnapshotCiphertext).toBeUndefined();
    expect(typeof (protocol as Record<string, unknown>).openConnectedServiceQuotaSnapshotCiphertext).toBe('function');
  });
});
