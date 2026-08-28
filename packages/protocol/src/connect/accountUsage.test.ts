import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import * as accountUsageModule from './accountUsage.js';
import * as protocol from '../index.js';

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
    it('preserves the canonical quota-scope schema identity through the existing root export', () => {
        expect(protocol.ProviderAccountUsageQuotaScopeV1Schema)
            .toBe(accountUsageModule.ProviderAccountUsageQuotaScopeV1Schema);
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
                availableCount: 1,
                credits: [{
                    id: 'reset-credit-1',
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
                availableCount: 1,
            }),
            meters: snapshot.meters,
        }));

        expect(projectSnapshot({
            snapshot,
            source: {
                serviceId: 'com.acme.agent/novel-service',
                profileId: 'external-work',
                bindingKind: 'profile',
            },
        })).toBeNull();
    });

    it('does not export the connected-service quota back-projection helper', () => {
        expect((protocol as Record<string, unknown>).projectConnectedServiceQuotaSnapshotToProviderAccountUsageSnapshotV1)
            .toBeUndefined();
    });

    it('does not export a connected-service quota sealing helper for durable persistence', () => {
        expect((protocol as Record<string, unknown>).sealConnectedServiceQuotaSnapshotCiphertext).toBeUndefined();
        expect(
            (protocol as Record<string, unknown>)
                .sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext,
        ).toBeUndefined();
        expect(typeof (protocol as Record<string, unknown>).openConnectedServiceQuotaSnapshotCiphertext).toBe('function');
    });

    it('publishes only the canonical PAU ciphertext reader and writer', () => {
        expect(
            Object.keys(protocol)
                .filter((key) => key.includes('ProviderAccountUsageSnapshotCiphertext'))
                .sort(),
        ).toEqual([
            'openProviderAccountUsageSnapshotCiphertext',
            'sealProviderAccountUsageSnapshotCiphertext',
        ]);
    });
});
