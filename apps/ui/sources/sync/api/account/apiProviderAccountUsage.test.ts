import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
        backoffForever: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockServerConfig() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'test',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
}

function makeSnapshot(): ProviderAccountUsageSnapshotV1 {
    const recordKey = {
        providerId: 'codex',
        accountSubjectId: 'acct_stable',
        subjectKind: 'account',
        quotaScope: 'account',
    } satisfies ProviderAccountUsageSnapshotV1['recordKey'];
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: {
            kind: 'providerSubject',
            id: 'acct_stable',
        },
        aliases: [
            {
                kind: 'nativeCli',
                providerId: 'codex',
                localCredentialRef: 'codex-home',
                accountSubjectId: 'acct_stable',
            },
        ],
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 2,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: null,
        accountLabel: null,
        meters: [],
    });
}

async function loadApi() {
    try {
        return await import('./apiProviderAccountUsage');
    } catch (error) {
        expect.fail(`canonical provider account usage API is missing: ${String(error)}`);
    }
}

describe('apiProviderAccountUsage', () => {
    it('gets a plaintext provider account usage snapshot by record id', async () => {
        mockServerConfig();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    content: { t: 'plain', v: snapshot },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotPlain } = await loadApi();
        const result = await getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId });

        expect(result?.recordId).toBe(snapshot.recordId);
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it('gets a sealed provider account usage snapshot by record id', async () => {
        mockServerConfig();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotSealed } = await loadApi();
        const result = await getProviderAccountUsageSnapshotSealed(credentials, { recordId: snapshot.recordId });

        expect(result?.sealed.ciphertext).toBe('ciphertext');
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v2/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });
});
