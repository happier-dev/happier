import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

const pendingSetupIntentStore = vi.hoisted(() => ({
    current: null as PendingSetupIntent | null,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => pendingSetupIntentStore.current,
}));

import { emitPendingSetupIntentChanged } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { usePendingSetupIntent } from './usePendingSetupIntent';

afterEach(() => {
    pendingSetupIntentStore.current = null;
    vi.unstubAllGlobals();
    standardCleanup();
});

describe('usePendingSetupIntent', () => {
    it('updates when pending setup intent writers emit a change', async () => {
        const hook = await renderHook(() => usePendingSetupIntent(), {
            flushOptions: { cycles: 1, turns: 2 },
        });

        expect(hook.getCurrent()).toBeNull();

        pendingSetupIntentStore.current = {
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        };
        await act(async () => {
            emitPendingSetupIntentChanged();
        });

        expect(hook.getCurrent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        await hook.unmount();
    });

    it('updates from web storage events for cross-tab changes', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', {
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            dispatchEvent: target.dispatchEvent.bind(target),
        });

        const hook = await renderHook(() => usePendingSetupIntent(), {
            flushOptions: { cycles: 1, turns: 2 },
        });

        pendingSetupIntentStore.current = {
            branch: 'remoteMachine',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
            machineId: 'machine-1',
            remoteSetupIntent: 'remoteMachine',
        };
        await act(async () => {
            target.dispatchEvent(new Event('storage'));
        });

        expect(hook.getCurrent()).toEqual({
            branch: 'remoteMachine',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
            machineId: 'machine-1',
            remoteSetupIntent: 'remoteMachine',
        });
        await hook.unmount();
    });
});
