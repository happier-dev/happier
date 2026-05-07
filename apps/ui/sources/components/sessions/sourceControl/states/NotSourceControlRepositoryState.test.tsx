import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installReactNativeWebMock, renderScreen } from '@/dev/testkit';
import { installSessionFilesCommonModuleMocks } from '@/components/sessions/files/sessionFilesTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmRepositoryInitMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const invalidateFromMutationAndAwaitMock = vi.hoisted(() => vi.fn(async () => {}));
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));

installSessionFilesCommonModuleMocks({
    reactNative: installReactNativeWebMock(),
    text: async () => ({
        t: (key: string) => key,
    }),
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/ops/sessions', () => ({
    sessionScmRepositoryInit: sessionScmRepositoryInitMock,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: invalidateFromMutationAndAwaitMock,
    },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertMock,
            confirm: modalConfirmMock,
        },
    }).module;
});

describe('NotSourceControlRepositoryState', () => {
    beforeEach(() => {
        sessionScmRepositoryInitMock.mockClear();
        invalidateFromMutationAndAwaitMock.mockClear();
        modalAlertMock.mockClear();
        modalConfirmMock.mockClear();
    });

    it('initializes the current folder as a repository from the empty state', async () => {
        const { NotSourceControlRepositoryState } = await import('./NotSourceControlRepositoryState');
        const onInitialized = vi.fn();

        const screen = await renderScreen(
            <NotSourceControlRepositoryState
                sessionId="session-1"
                canInitializeRepository
                onInitialized={onInitialized}
            />
        );

        expect(screen.findByTestId('scm-not-repo-init')).not.toBeNull();
        await screen.pressByTestIdAsync('scm-not-repo-init');
        await act(async () => {});

        expect(modalConfirmMock).toHaveBeenCalled();
        expect(sessionScmRepositoryInitMock).toHaveBeenCalledWith('session-1', {});
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('session-1');
        expect(onInitialized).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalled();
    });
});
