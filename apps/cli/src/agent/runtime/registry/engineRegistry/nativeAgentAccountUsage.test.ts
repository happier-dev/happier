import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type {
    ProviderAccountUsageAdoptionV1,
} from '@/daemon/connectedServices/accountUsage/adoption';

import { createNativeAgentAccountUsageService } from './nativeAgentAccountUsage';

const {
    notifyAdoption,
    notifySnapshot,
} = vi.hoisted(() => ({
    notifyAdoption: vi.fn(),
    notifySnapshot: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    notifyDaemonProviderAccountUsageAdoption: notifyAdoption,
    notifyDaemonProviderAccountUsageSnapshot: notifySnapshot,
}));

function createSnapshot(accountSubjectId = 'acct_123'): ProviderAccountUsageSnapshotV1 {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId,
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'openai-codex',
        accountSubject: { kind: 'providerSubject', id: accountSubjectId },
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        accountLabel: null,
        planLabel: null,
        meters: [],
    };
}

function createAdoption(): ProviderAccountUsageAdoptionV1 {
    const fromKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId: 'provisional:native',
        subjectKind: 'unknown',
        quotaScope: 'account',
    };
    const stableRecordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        providerId: 'openai-codex',
        fromRecordId: buildProviderAccountUsageRecordId(fromKey),
        toRecordId: buildProviderAccountUsageRecordId(stableRecordKey),
        stableRecordKey,
        proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
        observedAtMs: 1,
    };
}

describe('native Agent account-usage host owner', () => {
    beforeEach(() => {
        notifySnapshot.mockReset();
        notifyAdoption.mockReset();
    });

    it('delivers only the bound session snapshot and preserves the daemon result', async () => {
        const snapshot = createSnapshot();
        notifySnapshot.mockResolvedValue({
            ok: true,
            result: {
                status: 'snapshot_advanced',
                recordId: snapshot.recordId,
                persisted: true,
            },
        });
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: new AbortController().signal,
        });

        await expect(service.recordSnapshot({
            sessionId: 'other-session',
            snapshot,
        })).resolves.toEqual({
            status: 'rejected',
            reason: 'session_mismatch',
        });
        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot,
            policyDisposition: 'evidence_only',
        })).resolves.toEqual({
            status: 'recorded',
            recordId: snapshot.recordId,
            persisted: true,
        });
        expect(notifySnapshot).toHaveBeenCalledOnce();
        expect(notifySnapshot).toHaveBeenCalledWith({
            sessionId: 'session-1',
            snapshot,
            policyDisposition: 'evidence_only',
        });
    });

    it('validates adoption at the session owner and fences work after retirement', async () => {
        const adoption = createAdoption();
        notifyAdoption.mockResolvedValue({
            ok: true,
            result: {
                status: 'adopted',
                fromRecordId: adoption.fromRecordId,
                toRecordId: adoption.toRecordId,
                persisted: true,
            },
        });
        const controller = new AbortController();
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: controller.signal,
        });

        await expect(service.adoptProvisionalRecord({
            sessionId: 'session-1',
            adoption,
        })).resolves.toEqual({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        });
        controller.abort(new Error('generation retired'));
        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot: createSnapshot(),
        })).rejects.toThrow('generation retired');
        expect(notifyAdoption).toHaveBeenCalledOnce();
        expect(notifySnapshot).not.toHaveBeenCalled();
    });
});
