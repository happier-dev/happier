import { describe, expect, it, vi } from 'vitest';

const updatePendingRequestedAction = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/sync/ops', () => ({ resumeSession: vi.fn(), sessionSwitch: vi.fn() }));
vi.mock('@/sync/sync', () => ({
    sync: {
        abortSession: vi.fn(),
        updatePendingRequestedAction,
        enqueuePendingMessage: vi.fn(),
        encryption: { getMachineEncryption: vi.fn() },
        refreshSessionForSubmit: vi.fn(),
        sendMessage: vi.fn(),
    },
}));

describe('createSyncBackedSubmitPort', () => {
    it('forwards the canonical Pending row action mutation', async () => {
        const { createSyncBackedSubmitPort } = await import('./syncBackedSubmitPort');
        const port = createSyncBackedSubmitPort();
        await port.updatePendingRequestedAction?.('session-1', 'local-1', { v: 1, kind: 'steer_now' });
        expect(updatePendingRequestedAction).toHaveBeenCalledWith('session-1', 'local-1', { v: 1, kind: 'steer_now' });
    });
});
