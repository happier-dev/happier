import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { computeConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { refreshProviderAccountUsage } from '@/sync/domains/connectedServices/accountUsage/refreshProviderAccountUsage';
import { refreshQuotaSnapshot, buildQuotaSnapshotScopeKey } from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { connectedServiceQuotaGaugeFormatter } from './connectedServiceQuotaGaugeFormatter';
import { ProviderUsageDetails } from './ProviderUsageDetails';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

const auth = vi.hoisted(() => ({ credentials: { token: 'test', secret: 'test' } }));
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => auth }));
const api = vi.hoisted(() => ({ request: vi.fn(), get: vi.fn(), requestQuota: vi.fn() }));
vi.mock('@/sync/api/account/apiProviderAccountUsageV3', () => ({
    requestProviderAccountUsageRefreshPlain: api.request,
    getProviderAccountUsageSnapshotPlain: api.get,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({ requestConnectedServiceQuotaSnapshotRefreshV3: api.requestQuota }));

const recordId = 'paug_v1_abcdefgh';
const credentialScope = resolveAuthCredentialsScopeKey(auth.credentials);
function gauge(profileId: string) {
    const result = computeConnectedServiceQuotaGaugeViewModel({
        snapshot: { v: 1, serviceId: 'openai-codex', profileId, fetchedAt: 1_000, staleAfterMs: 60_000,
            planLabel: null, accountLabel: null,
            meters: [{ meterId: 'weekly', label: 'Weekly', used: 30, limit: 100, unit: 'count',
                utilizationPct: null, resetsAt: null, status: 'ok', details: {} }] },
        windowMode: 'most_constrained', nowMs: 1_000, formatter: connectedServiceQuotaGaugeFormatter,
    });
    if (!result) throw new Error('Expected usage');
    return result;
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe('usage refresh indicator', () => {
    it('appears only for the queried native account and disappears when fresh usage arrives', async () => {
        api.request.mockResolvedValue(true);
        api.get.mockResolvedValue({ recordId, fetchedAtMs: Date.now(), providerId: 'codex' });
        const screen = await renderScreen(<>
            <ProviderUsageDetails viewModel={gauge(`acct:${recordId}`)} />
            <ProviderUsageDetails viewModel={gauge('acct:paug_v1_ijklmnop')} />
        </>);
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        let done!: Promise<boolean>;
        await act(async () => {
            done = refreshProviderAccountUsage({ credentials: auth.credentials, credentialScope, recordId, mode: 'plain' });
        });
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); await done; });
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        await screen.unmount();
    });

    it('stops showing a connected-account refresh when the request fails', async () => {
        let rejectRequest!: (error: Error) => void;
        api.requestQuota.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
        const screen = await renderScreen(<ProviderUsageDetails viewModel={gauge('work')} />);
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        let done!: Promise<void>;
        await act(async () => {
            done = refreshQuotaSnapshot(buildQuotaSnapshotScopeKey(credentialScope, 'openai-codex', 'work'), {
                credentials: auth.credentials, credentialScope, serviceId: 'openai-codex', profileId: 'work',
                resolveAccountMode: async () => 'plain',
            });
        });
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
        await act(async () => { rejectRequest(new Error('offline')); await done; });
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        await screen.unmount();
    });
});
