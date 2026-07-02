import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

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
    aliases: readonly Readonly<{ kind: string; providerId: string; serviceId?: string; profileId?: string; accountSubjectId: string }>[];
    observedAtMs: number;
    fetchedAtMs: number;
    staleAfterMs: number;
    source: string;
    confidence: string;
    meters: readonly unknown[];
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
    return !!value
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
        aliases: overrides.aliases ?? [
            {
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: recordKey.accountSubjectId,
            },
        ],
        observedAtMs: overrides.observedAtMs ?? 1700000000000,
        fetchedAtMs: overrides.fetchedAtMs ?? 1700000000000,
        staleAfterMs: overrides.staleAfterMs ?? 60_000,
        source: overrides.source ?? 'runtimeSignal',
        confidence: overrides.confidence ?? 'confirmed',
        meters: overrides.meters ?? [
            {
                meterId: 'weekly',
                label: 'Weekly',
                used: 82,
                limit: 100,
                remaining: 18,
                remainingPct: 18,
                usedPct: 82,
                resetAtMs: 1700003600000,
                unit: 'credits',
                utilizationPct: 82,
                resetsAt: 1700003600000,
                status: 'ok',
                limitScope: 'account',
                confidence: 'exact',
                details: { limitCategory: 'quota' },
            },
        ],
    };
}

describe('provider account usage protocol', () => {
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

    it('normalizes usage aliases deterministically', () => {
        const normalizeAliases = requireExport<(...args: readonly unknown[]) => unknown>(
            'normalizeProviderAccountUsageAliases',
            isFunction,
        );

        const normalized = normalizeAliases([
            {
                kind: 'nativeCli',
                providerId: 'codex',
                localCredentialRef: 'codex-home-main',
                accountSubjectId: 'acct_1',
            },
            {
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: 'acct_1',
            },
            {
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: 'acct_1',
            },
        ]);

        expect(normalized).toEqual([
            {
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: 'acct_1',
            },
            {
                kind: 'nativeCli',
                providerId: 'codex',
                localCredentialRef: 'codex-home-main',
                accountSubjectId: 'acct_1',
            },
        ]);
    });

    it('builds opaque local credential refs without embedding local paths', () => {
        const buildLocalCredentialRef = requireExport<(...args: readonly unknown[]) => unknown>(
            'buildProviderAccountUsageOpaqueLocalCredentialRef',
            isFunction,
        );

        const ref = buildLocalCredentialRef({
            providerId: 'codex',
            kind: 'appServerNative',
            value: '/Users/alice/.codex',
        });

        expect(ref).toMatch(/^opaque:codex:appServerNative:[A-Za-z0-9_-]+$/);
        expect(String(ref)).not.toContain('/Users/alice');
        expect(String(ref)).not.toContain('.codex');
    });

    it('rejects path-like local credential aliases at the protocol boundary', () => {
        const schema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
            'ProviderAccountUsageSnapshotV1Schema',
            isParser,
        );

        const result = schema.safeParse({
            ...createSnapshot(),
            aliases: [{
                kind: 'nativeCli',
                providerId: 'codex',
                localCredentialRef: '/Users/alice/.codex',
                accountSubjectId: 'acct_secret_provider_subject',
            }],
        });

        expect(result.success).toBe(false);
    });

    it('parses canonical snapshots with shared meter semantics', () => {
        const schema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
            'ProviderAccountUsageSnapshotV1Schema',
            isParser,
        );

        const snapshot = schema.parse(createSnapshot());

        expect(snapshot.recordId).toBe(expectedRecordId(snapshot.recordKey));
        expect(snapshot.meters[0]).toEqual(expect.objectContaining({
            remainingPct: 18,
            usedPct: 82,
            limitScope: 'account',
            confidence: 'exact',
        }));
    });

    it('rejects diagnostic headers that can leak tokens', () => {
        const schema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
            'ProviderAccountUsageSnapshotV1Schema',
            isParser,
        );

        const result = schema.safeParse({
            ...createSnapshot(),
            diagnostics: [
                {
                    kind: 'provider_http',
                    headers: {
                        authorization: 'Bearer secret',
                    },
                },
            ],
        });

        expect(result.success).toBe(false);
    });

    it('rejects diagnostic text that can leak raw credential material', () => {
        const schema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
            'ProviderAccountUsageSnapshotV1Schema',
            isParser,
        );

        const result = schema.safeParse({
            ...createSnapshot(),
            diagnostics: [
                {
                    kind: 'provider_http',
                    message: 'provider failed with authorization: bearer sk-secret-token-value-1234567890',
                },
            ],
        });

        expect(result.success).toBe(false);
    });

    it('rejects adoption records whose target id or aliases do not match the stable record key', () => {
        const schema = requireExport<Parser<unknown>>(
            'ProviderAccountUsageAdoptionV1Schema',
            isParser,
        );
        const stableRecordKey = {
            providerId: 'codex',
            accountSubjectId: 'acct_stable',
            subjectKind: 'account',
            quotaScope: 'account',
        };
        const mismatchedRecordKey = {
            providerId: 'codex',
            accountSubjectId: 'acct_other',
            subjectKind: 'account',
            quotaScope: 'account',
        };

        expect(schema.safeParse({
            providerId: 'codex',
            fromRecordId: expectedRecordId({
                providerId: 'codex',
                accountSubjectId: 'provisional:codex',
                subjectKind: 'unknown',
                quotaScope: 'account',
            }),
            toRecordId: expectedRecordId(mismatchedRecordKey),
            stableRecordKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 1700000000000,
            aliases: [{
                kind: 'nativeCli',
                providerId: 'codex',
                accountSubjectId: stableRecordKey.accountSubjectId,
            }],
        }).success).toBe(false);

        expect(schema.safeParse({
            providerId: 'codex',
            fromRecordId: expectedRecordId({
                providerId: 'codex',
                accountSubjectId: 'provisional:codex',
                subjectKind: 'unknown',
                quotaScope: 'account',
            }),
            toRecordId: expectedRecordId(stableRecordKey),
            stableRecordKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 1700000000000,
            aliases: [{
                kind: 'nativeCli',
                providerId: 'codex',
                accountSubjectId: 'provisional:codex',
            }],
        }).success).toBe(false);
    });

    it('projects connected-service aliases to compatibility quota snapshots', () => {
        const schema = requireExport<Parser<ProviderAccountUsageSnapshotV1>>(
            'ProviderAccountUsageSnapshotV1Schema',
            isParser,
        );
        const projectSnapshot = requireExport<(...args: readonly unknown[]) => unknown>(
            'projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1',
            isFunction,
        );
        const snapshot = schema.parse(createSnapshot());

        const projected = projectSnapshot({
            snapshot,
            serviceId: 'openai-codex',
            profileId: 'work',
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
            meters: snapshot.meters,
        }));
    });
});
