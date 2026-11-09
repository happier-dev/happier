import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import { renderHook } from '@/dev/testkit';
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { useTemporaryComputerLaunch } from './useTemporaryComputerLaunch';

const pending = { state: 'pending', review: null, materialization: null, activationId: 'activation-1' } as never;
const claimed = {
    state: 'claimed',
    review: null,
    materialization: null,
    activationId: 'activation-1',
    claim: { payload: { installation: { installationId: 'installation-1' } } },
} as never;
const checkingAiAccess = {
    state: 'consented',
    progressPhase: 'checking_ai_access',
    review: {},
    readiness: null,
    materialization: null,
    activationId: 'activation-1',
    claim: { payload: { installation: { installationId: 'installation-1' } } },
} as never;

async function mountWaitingCreator(read: RunnerActivationClient['read']) {
    // One stable transport per mount, exactly like the mounted authoring owner
    // memoizes it. A fresh object per render would refetch on every render and
    // hide whether the wake is the real freshness signal.
    const client = { read } as unknown as RunnerActivationClient;
    return await renderHook(() => useTemporaryComputerLaunch({
        client,
        serverId: 'server-1',
        draftId: 'draft-wake',
        existingPublicRef: { v: 1, activationId: 'activation-1', createdOnDeviceLabel: 'This device' },
        prepareActivation: vi.fn(),
        persistPublicRef: vi.fn(),
        onMaterialized: vi.fn(),
    }));
}

describe('useTemporaryComputerLaunch freshness', () => {
    it('refetches the exact activation on the Home Account-change wake instead of on a timer', async () => {
        vi.useFakeTimers();
        try {
            const read = vi.fn(async () => pending);
            const hook = await mountWaitingCreator(read as unknown as RunnerActivationClient['read']);
            await act(async () => { await Promise.resolve(); });
            const readsAfterMount = read.mock.calls.length;
            expect(hook.getCurrent().status).toBe('waiting_for_computer');

            // No wake: an idle creator must not generate traffic of its own.
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
            expect(read.mock.calls.length).toBe(readsAfterMount);

            read.mockImplementation(async () => checkingAiAccess);
            await act(async () => {
                publishHomeAccountChange('server-1', [EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1]);
                await Promise.resolve();
            });

            expect(read.mock.calls.length).toBe(readsAfterMount + 1);
            expect(read).toHaveBeenLastCalledWith('activation-1', expect.anything());
            expect(hook.getCurrent().status).toBe('checking_ai_access');
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores a wake for another Home and still honors a conservative entity-free wake', async () => {
        const read = vi.fn(async () => pending);
        const hook = await mountWaitingCreator(read as unknown as RunnerActivationClient['read']);
        await act(async () => { await Promise.resolve(); });
        const readsAfterMount = read.mock.calls.length;

        await act(async () => {
            publishHomeAccountChange('server-2', [EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await Promise.resolve();
        });
        expect(read.mock.calls.length).toBe(readsAfterMount);

        await act(async () => {
            publishHomeAccountChange('server-1', ['teams']);
            await Promise.resolve();
        });
        expect(read.mock.calls.length).toBe(readsAfterMount);

        // A socket-only wake carries no entity ids and must stay conservative.
        await act(async () => {
            publishHomeAccountChange('server-1');
            await Promise.resolve();
        });
        expect(read.mock.calls.length).toBe(readsAfterMount + 1);
        expect(hook.getCurrent().status).toBe('waiting_for_computer');
    });

    it('keeps manual refresh available when a wake never arrives', async () => {
        const read = vi.fn(async () => pending);
        const hook = await mountWaitingCreator(read as unknown as RunnerActivationClient['read']);
        await act(async () => { await Promise.resolve(); });
        const readsAfterMount = read.mock.calls.length;

        read.mockImplementation(async () => claimed);
        await act(async () => { await hook.getCurrent().refresh(); });

        expect(read.mock.calls.length).toBe(readsAfterMount + 1);
        expect(hook.getCurrent().status).toBe('review_unavailable');
    });

    it('stops listening once the activation reaches a terminal state', async () => {
        const closed = { state: 'closed', review: null, materialization: null, activationId: 'activation-1' } as never;
        const read = vi.fn(async () => closed);
        const hook = await mountWaitingCreator(read as unknown as RunnerActivationClient['read']);
        await act(async () => { await Promise.resolve(); });
        const readsAfterMount = read.mock.calls.length;
        expect(hook.getCurrent().status).toBe('failed');

        await act(async () => {
            publishHomeAccountChange('server-1', [EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await Promise.resolve();
        });

        expect(read.mock.calls.length).toBe(readsAfterMount);
    });
});
