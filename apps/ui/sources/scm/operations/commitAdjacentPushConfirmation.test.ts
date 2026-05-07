import { describe, expect, it, vi } from 'vitest';

import type { AlertButton } from '@/modal';
import type { ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';

const alertAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => ({
    Modal: {
        alertAsync: alertAsyncMock,
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
    });
});

async function chooseButton(index: number) {
    alertAsyncMock.mockImplementationOnce(async (_title: string, _body?: string, buttons?: AlertButton[]) => {
        buttons?.[index]?.onPress?.();
    });
}

describe('confirmCommitAdjacentPush', () => {
    it('allows push immediately when push confirmation is disabled', async () => {
        const { confirmCommitAdjacentPush } = await import('./commitAdjacentPushConfirmation');

        const confirmed = await confirmCommitAdjacentPush({
            target: { remote: 'origin', branch: 'main' },
            policy: 'pull_only',
            setRemoteConfirmPolicy: vi.fn(),
            detachedHeadLabel: 'Detached HEAD',
        });

        expect(confirmed).toBe(true);
        expect(alertAsyncMock).not.toHaveBeenCalled();
    });

    it('cancels push when the user declines', async () => {
        await chooseButton(0);
        const { confirmCommitAdjacentPush } = await import('./commitAdjacentPushConfirmation');

        const confirmed = await confirmCommitAdjacentPush({
            target: { remote: 'origin', branch: 'main' },
            policy: 'always',
            setRemoteConfirmPolicy: vi.fn(),
            detachedHeadLabel: 'Detached HEAD',
        });

        expect(confirmed).toBe(false);
    });

    it('allows push when the user confirms', async () => {
        await chooseButton(1);
        const { confirmCommitAdjacentPush } = await import('./commitAdjacentPushConfirmation');

        const confirmed = await confirmCommitAdjacentPush({
            target: { remote: 'origin', branch: 'main' },
            policy: 'always',
            setRemoteConfirmPolicy: vi.fn(),
            detachedHeadLabel: 'Detached HEAD',
        });

        expect(confirmed).toBe(true);
    });

    it('disables future push confirmations when the user chooses push and do not ask again', async () => {
        await chooseButton(2);
        const setRemoteConfirmPolicy = vi.fn<(policy: ScmRemoteConfirmPolicy) => void>();
        const { confirmCommitAdjacentPush } = await import('./commitAdjacentPushConfirmation');

        const confirmed = await confirmCommitAdjacentPush({
            target: { remote: 'origin', branch: 'main' },
            policy: 'always',
            setRemoteConfirmPolicy,
            detachedHeadLabel: 'Detached HEAD',
        });

        expect(confirmed).toBe(true);
        expect(setRemoteConfirmPolicy).toHaveBeenCalledWith('pull_only');
    });
});
