import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

const apiMocks = vi.hoisted(() => ({
    fetchAccountEncryptionMode: vi.fn(),
    setSessionPin: vi.fn(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const { createAccountEncryptionModeModuleMock } = await import('@/dev/testkit/mocks/accountEncryptionMode');
    return await createAccountEncryptionModeModuleMock({
        importOriginal,
        overrides: { fetchAccountEncryptionMode: apiMocks.fetchAccountEncryptionMode },
    });
});

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        setSessionPin: apiMocks.setSessionPin,
    };
});

describe('setSessionPin op', () => {
    afterEach(async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const state = getStorage().getState();
        for (const record of Object.values(state.sessionOrganizationOptimisticRecords)) {
            if (record.serverId === 'server-a') state.commitSessionOrganizationOptimistic(record.id);
        }
        state.clearSessionOrganizationForServer('server-a');
    });
    beforeEach(async () => {
        apiMocks.fetchAccountEncryptionMode.mockReset();
        apiMocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        apiMocks.setSessionPin.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('changes only the requested membership and keeps the existing personal position', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionPin } = await import('./setSessionPin');
        const key = buildSessionOrganizationSessionKey('server-a', 's1001');
        const initial = { sessionId: 's1001', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: true };
        getStorage().getState().commitSessionOrganizationOptimistic(
            getStorage().getState().setSessionPinOptimistic('server-a', 's1001', initial),
        );
        let settle!: (value: { pin: typeof initial }) => void;
        apiMocks.setSessionPin.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
        const operation = setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'rail', pinned: false });
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toEqual({ ...initial, railPinned: false });
        expect(apiMocks.setSessionPin).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ surface: 'rail', pinned: false }),
        }));
        settle({ pin: { ...initial, railPinned: false } });
        await operation;
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toEqual({ ...initial, railPinned: false });
    });

    it('does not roll a failed older rail write over a newer list write', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionPin } = await import('./setSessionPin');
        const key = buildSessionOrganizationSessionKey('server-a', 's1001');
        const initial = { sessionId: 's1001', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: false };
        getStorage().getState().commitSessionOrganizationOptimistic(
            getStorage().getState().setSessionPinOptimistic('server-a', 's1001', initial),
        );
        let reject!: (error: Error) => void;
        apiMocks.setSessionPin.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
        const older = setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'rail', pinned: true });
        apiMocks.setSessionPin.mockResolvedValueOnce({ pin: { ...initial, listPinned: false, railPinned: true } });
        await setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'list', pinned: false });
        reject(new Error('offline'));
        await expect(older).rejects.toThrow('offline');
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toEqual({ ...initial, listPinned: false, railPinned: true });
    });

    it('does not restore older list membership when a rail confirmation arrives after the newer list confirmation', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionPin } = await import('./setSessionPin');
        const key = buildSessionOrganizationSessionKey('server-a', 's1001');
        const initial = { sessionId: 's1001', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: false };
        getStorage().getState().commitSessionOrganizationOptimistic(
            getStorage().getState().setSessionPinOptimistic('server-a', 's1001', initial),
        );
        let settle!: (value: { pin: typeof initial }) => void;
        apiMocks.setSessionPin.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
        const older = setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'rail', pinned: true });
        const current = { ...initial, listPinned: false, railPinned: true };
        apiMocks.setSessionPin.mockResolvedValueOnce({ pin: current });
        await setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'list', pinned: false });
        settle({ pin: { ...initial, railPinned: true } });
        await older;
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toEqual(current);
    });

    it('creates rail-only membership and removes the shared row when its last membership is cleared', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionPin } = await import('./setSessionPin');
        const key = buildSessionOrganizationSessionKey('server-a', 's1001');
        const pin = { sessionId: 's1001', sortKey: null, pinnedAt: 1, listPinned: false, railPinned: true };
        apiMocks.setSessionPin.mockResolvedValueOnce({ pin });
        const add = setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'rail', pinned: true });
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toMatchObject({ listPinned: false, railPinned: true });
        await add;
        let settle!: (value: { pin: null }) => void;
        apiMocks.setSessionPin.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
        const clear = setSessionPin({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', sessionId: 's1001', surface: 'rail', pinned: false });
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toBeUndefined();
        settle({ pin: null });
        await clear;
        expect(getStorage().getState().sessionOrganizationPinsBySessionKey[key]).toBeUndefined();
    });

    it('rolls back a rejected pin and turns the server limit code into recovery guidance', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionPin } = await import('./setSessionPin');
        apiMocks.setSessionPin.mockRejectedValueOnce(new HappyError('session-pin-limit-exceeded', false));

        await expect(setSessionPin({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionId: 's1001',
            pinned: true,
        })).rejects.toThrow('You can pin up to 1,000 sessions. Unpin another session and try again.');

        const state = getStorage().getState();
        expect(state.sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey('server-a', 's1001')]).toBeUndefined();
        expect(state.sessionOrganizationOptimisticRecords).toEqual({});
    });
});
