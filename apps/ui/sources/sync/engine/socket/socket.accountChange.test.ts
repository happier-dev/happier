import { describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { handleUpdateContainer } from './socket';
import { parseUpdateContainer } from './socketParse';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        artifactDataKeys: new Map(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket AccountChange wake', () => {
    it('marks primary Artifact receipts as feed-backed while preserving immediate deletion observers', async () => {
        const covered = vi.fn();
        const early = vi.fn();
        const releases = [subscribeHomeAccountChange(covered, { includeCatchUpPending: 'recovery' }),
            subscribeHomeAccountChange(early)];
        try {
            const updateData = parseUpdateContainer({ id: 'artifact-receipt', seq: 13, createdAt: 1,
                body: { t: 'delete-artifact', artifactId: 'deleted-artifact' } });
            if (!updateData) throw new Error('Expected a valid Artifact receipt');
            await handleUpdateContainer({ ...buildBaseParams(), sourceServerId: 'receipt-home', updateData,
                onAccountChangeWake: () => {} });
            expect(covered).not.toHaveBeenCalled();
            expect(early).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'socket', changesCatchUp: true,
                entityIds: ['deleted-artifact'], deletedArtifactIds: ['deleted-artifact'] }));
        } finally { releases.forEach(release => release()); }
    });

    it('routes the existing typed Settings hint into durable catch-up without inventory invalidation', async () => {
        const onAccountChangeWake = vi.fn();
        const params = buildBaseParams();
        const updateData = parseUpdateContainer({ id: 'settings-wake', seq: 12, createdAt: 1,
            body: { t: 'account-settings-changed', settingsVersion: 8 } });
        if (!updateData) throw new Error('Expected an admitted Settings wake');
        await handleUpdateContainer({ ...params, updateData, onAccountChangeWake });
        expect(onAccountChangeWake).toHaveBeenCalledExactlyOnceWith(updateData.body);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(params.invalidateMachines).not.toHaveBeenCalled();
    });

    it('forwards the parsed committed routing facts without applying feed changes from a wake', async () => {
        const onAccountChangeWake = vi.fn();
        const params = buildBaseParams();
        const body = { t: 'account-change', changeKinds: ['session', 'machine'], entityIds: ['session-1', 'machine-1'],
            sessionSystemRecords: [{ sessionId: 'session-1', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } }] };
        const updateData = parseUpdateContainer({ id: 'committed-wake', seq: 12, createdAt: 1, body });
        expect(updateData).not.toBeNull();
        if (!updateData) throw new Error('Expected a valid Account-change wake');

        await handleUpdateContainer({ ...params, updateData, onAccountChangeWake });

        expect(onAccountChangeWake).toHaveBeenCalledExactlyOnceWith(body);
        expect(params.applySessions).not.toHaveBeenCalled();
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('requests the canonical AccountChange catch-up without interpreting wake content', async () => {
        const onAccountChangeWake = vi.fn();
        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_account_change',
            seq: 9,
            createdAt: 1,
            body: { t: 'account-change' },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
            onAccountChangeWake,
        });

        expect(onAccountChangeWake).toHaveBeenCalledTimes(1);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(params.invalidateMachines).not.toHaveBeenCalled();
        expect(params.invalidateArtifacts).not.toHaveBeenCalled();
        expect(params.invalidateAutomations).not.toHaveBeenCalled();
    });
});
