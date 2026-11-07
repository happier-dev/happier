import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit';
import { collectAutomaticProviderUsageRefreshTargets, runProviderUsageRefresh } from './useProviderUsageRefresh';
import { __resetConnectedServiceQuotaSnapshotStore, buildQuotaSnapshotScopeKey, ensureQuotaSnapshotLoaded } from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { __resetProviderAccountUsageSnapshotCache, writeProviderAccountUsageSnapshotToCache } from '@/sync/domains/connectedServices/accountUsage/cache';
import { buildProviderAccountUsageRecordId, ConnectedServiceQuotaSnapshotV1Schema, ProviderAccountUsageSnapshotV1Schema, type ConnectedServiceQuotaSnapshotV1, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';

// Provider refresh requests cross the server API boundary; orchestration and caches stay real.
const api = vi.hoisted(() => {
    const refuse = () => vi.fn<(credentials: unknown, params: unknown) => Promise<boolean>>(async () => false);
    return { quotaPlain: refuse(), quotaSealed: refuse(), accountPlain: refuse(), accountSealed: refuse(),
        getQuota: vi.fn<() => Promise<{
            snapshot: ConnectedServiceQuotaSnapshotV1;
            metadata: { fetchedAt: number; staleAfterMs: number; status: 'ok' };
        } | null>>(async () => null) };
});
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({ requestConnectedServiceQuotaSnapshotRefreshV3: api.quotaPlain, getConnectedServiceQuotaSnapshotPlain: api.getQuota }));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({ requestConnectedServiceQuotaSnapshotRefresh: api.quotaSealed }));
vi.mock('@/sync/api/account/apiProviderAccountUsageV3', () => ({ requestProviderAccountUsageRefreshPlain: api.accountPlain }));
vi.mock('@/sync/api/account/apiProviderAccountUsageV2', () => ({ requestProviderAccountUsageRefreshSealed: api.accountSealed }));

describe('provider ring refresh', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetConnectedServiceQuotaSnapshotStore();
        __resetProviderAccountUsageSnapshotCache();
    });
    it('automatic requests omit inactive configured providers and wait for an exhausted account reset', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000);
            const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' } as const;
            const active = { connectedProfileRef: { serviceId: 'openai-codex', profileId: 'active' }, recordIds: [buildProviderAccountUsageRecordId(recordKey)] };
            const context = {
                credentials: { token: 'test-token', secret: 'test-secret' }, credentialScope: 'test-scope',
                resolveAccountMode: async () => 'plain' as const,
                automaticTargets: [active],
                configuredTargets: [active, { connectedProfileRef: { serviceId: 'anthropic', profileId: 'inactive' }, recordIds: ['paug_v1_ijklmnop'] }],
            };
            writeProviderAccountUsageSnapshotToCache({ credentialScope: context.credentialScope, snapshot: ProviderAccountUsageSnapshotV1Schema.parse({
                v: 1, recordId: active.recordIds[0], providerId: 'codex',
                recordKey,
                accountSubject: { kind: 'providerSubject', id: 'account' },
                observedAtMs: 1_000, fetchedAtMs: 1_000, staleAfterMs: 60_000,
                source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
                meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'count', utilizationPct: 100, resetsAt: 2_000, status: 'ok' }],
            }) });
            runProviderUsageRefresh(context, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
            await flushHookEffects();
            expect(api.quotaPlain).not.toHaveBeenCalled();
            expect(api.accountPlain).not.toHaveBeenCalled();

            vi.setSystemTime(2_000);
            runProviderUsageRefresh(context, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
            await flushHookEffects();
            expect(api.quotaPlain.mock.calls.map((call) => call[1])).toEqual([{ serviceId: 'openai-codex', profileId: 'active' }]);
            expect(api.accountPlain.mock.calls.map((call) => call[1])).toEqual([{ recordId: active.recordIds[0] }]);
        } finally {
            vi.useRealTimers();
        }
    });
    it('derives automatic account targets only from active, unarchived sessions using their runtime provider identity', () => {
        const native = { flavor: 'codex', path: '/tmp', host: 'local', providerAccountUsageRefsV1: { v: 1, recordIds: ['paug_v1_abcdefgh'], updatedAtMs: 1 } };
        const connected = { ...native, flavor: 'claude',
            agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } },
            connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } };
        expect(collectAutomaticProviderUsageRefreshTargets({ connectedServices: [], sessions: [
            { active: false, metadata: native },
            { active: true, archivedAt: 10, metadata: native },
            { active: true, metadata: connected },
            { active: true, metadata: native },
            { active: true, metadata: { ...native, flavor: 'unknown' } },
        ] })).toEqual([
            { connectedProfileRef: { serviceId: 'openai-codex', profileId: 'work' }, recordIds: ['paug_v1_abcdefgh'] },
            { connectedProfileRef: null, recordIds: ['paug_v1_abcdefgh'] },
        ]);
    });
    it('holds a connected account with no known reset while preserving its manual refresh', async () => {
        const active = { connectedProfileRef: { serviceId: 'openai-codex', profileId: 'active' }, recordIds: ['paug_v1_abcdefgh'] };
        const context = {
            credentials: { token: 'test-token', secret: 'test-secret' }, credentialScope: 'test-scope',
            resolveAccountMode: async () => 'plain' as const, automaticTargets: [active], configuredTargets: [active],
        };
        api.getQuota.mockResolvedValueOnce({ snapshot: ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1, serviceId: 'openai-codex', profileId: 'active', fetchedAt: 1_000, staleAfterMs: 60_000,
            planLabel: null, accountLabel: null,
            meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok' }],
        }), metadata: { fetchedAt: 1_000, staleAfterMs: 60_000, status: 'ok' } });
        ensureQuotaSnapshotLoaded(buildQuotaSnapshotScopeKey(context.credentialScope, 'openai-codex', 'active'), {
            ...context, serviceId: 'openai-codex', profileId: 'active',
        });
        await flushHookEffects();
        expect(api.getQuota).toHaveBeenCalled();
        runProviderUsageRefresh(context, active, { automatic: true });
        await flushHookEffects();
        expect(api.quotaPlain).not.toHaveBeenCalled();
        expect(api.accountPlain).not.toHaveBeenCalled();
        runProviderUsageRefresh(context, active);
        await flushHookEffects();
        expect(api.quotaPlain.mock.calls.map((call) => call[1])).toEqual([{ serviceId: 'openai-codex', profileId: 'active' }]);
        expect(api.accountPlain.mock.calls.map((call) => call[1])).toEqual([{ recordId: active.recordIds[0] }]);
    });
    it.each([false, true])('honours a live usage-limit failure and resumes from known reset evidence (snapshot refinement: %s)', async (refineResetFromSnapshot) => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000);
            const issue: SessionRuntimeIssueV1 = {
                v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', provider: 'codex', occurredAt: 1_000,
                usageLimit: { v: 1, resetAtMs: refineResetFromSnapshot ? null : 2_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
            };
            const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' } as const;
            const recordId = buildProviderAccountUsageRecordId(recordKey);
            const automaticTargets = collectAutomaticProviderUsageRefreshTargets({ connectedServices: [], sessions: [{
                active: true, latestTurnStatus: 'failed', lastRuntimeIssue: issue,
                metadata: { flavor: 'codex', path: '/tmp', host: 'local', providerAccountUsageRefsV1: { v: 1, recordIds: [recordId], updatedAtMs: 1 } },
            }] });
            const context = {
                credentials: { token: 'test-token', secret: 'test-secret' }, credentialScope: 'test-scope',
                resolveAccountMode: async () => 'plain' as const, automaticTargets,
            };
            if (refineResetFromSnapshot) writeProviderAccountUsageSnapshotToCache({ credentialScope: context.credentialScope,
                snapshot: ProviderAccountUsageSnapshotV1Schema.parse({
                    v: 1, recordId, recordKey, providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' },
                    observedAtMs: 500, fetchedAtMs: 500, staleAfterMs: 60_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
                    meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'count', utilizationPct: 100, resetsAt: 2_000, status: 'ok' }],
                }),
            });
            runProviderUsageRefresh(context, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
            await flushHookEffects();
            expect(api.accountPlain).not.toHaveBeenCalled();
            if (!refineResetFromSnapshot) {
                vi.setSystemTime(1_500);
                writeProviderAccountUsageSnapshotToCache({ credentialScope: context.credentialScope,
                    snapshot: ProviderAccountUsageSnapshotV1Schema.parse({
                        v: 1, recordId, recordKey, providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' },
                        observedAtMs: 1_500, fetchedAtMs: 1_500, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [],
                    }),
                });
                runProviderUsageRefresh(context, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
                await flushHookEffects();
                expect(api.accountPlain).not.toHaveBeenCalled();
            }
            vi.setSystemTime(2_000);
            runProviderUsageRefresh(context, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
            await flushHookEffects();
            expect(api.accountPlain.mock.calls.map((call) => call[1])).toEqual([{ recordId }]);
            if (refineResetFromSnapshot) {
                vi.setSystemTime(3_000);
                const nextTargets = collectAutomaticProviderUsageRefreshTargets({ connectedServices: [], sessions: [{
                    active: true, latestTurnStatus: 'failed', lastRuntimeIssue: { ...issue, occurredAt: 3_000 },
                    metadata: { flavor: 'codex', path: '/tmp', host: 'local', providerAccountUsageRefsV1: { v: 1, recordIds: [recordId], updatedAtMs: 3_000 } },
                }] });
                runProviderUsageRefresh({ ...context, automaticTargets: nextTargets }, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
                await flushHookEffects();
                // An old, elapsed reset cannot reopen a newly exhausted allowance with unknown timing.
                expect(api.accountPlain.mock.calls.map((call) => call[1])).toEqual([{ recordId }]);
            }
        } finally {
            vi.useRealTimers();
        }
    });
    it.each(['plain', 'e2ee'] as const)('refreshes all configured providers once through the %s transport', async (mode) => {
        const selected = { connectedProfileRef: { serviceId: 'anthropic', profileId: 'work' }, recordIds: ['paug_v1_abcdefgh'] };
        const context = {
            credentials: { token: 'test-token', secret: 'test-secret' }, credentialScope: 'test-scope',
            resolveAccountMode: async () => mode,
            configuredTargets: [
                selected,
                { connectedProfileRef: { serviceId: 'openai-codex', profileId: 'personal' }, recordIds: ['paug_v1_ijklmnop'] },
                selected,
            ],
        };
        runProviderUsageRefresh(context, selected);
        await flushHookEffects();
        const quotaRequests = mode === 'plain' ? api.quotaPlain : api.quotaSealed;
        const accountRequests = mode === 'plain' ? api.accountPlain : api.accountSealed;
        expect(quotaRequests.mock.calls.map((call) => call[1])).toEqual([
            { serviceId: 'anthropic', profileId: 'work' },
            { serviceId: 'openai-codex', profileId: 'personal' },
        ]);
        expect(accountRequests.mock.calls.map((call) => call[1])).toEqual([
            { recordId: 'paug_v1_abcdefgh' }, { recordId: 'paug_v1_ijklmnop' },
        ]);
    });
});
