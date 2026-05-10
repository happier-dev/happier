import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createThemeFixture, renderScreen } from '@/dev/testkit';

import { installSourceControlStateCommonModuleMocks } from './sourceControlStateTestHelpers';

const modalState = vi.hoisted(() => ({
    confirm: vi.fn(),
    alert: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: modalState.confirm,
            alert: modalState.alert,
        },
    }).module;
});

installSourceControlStateCommonModuleMocks();

describe('NotSourceControlRepositoryState', () => {
    beforeEach(() => {
        modalState.confirm.mockReset();
        modalState.alert.mockReset();
    });

    it('confirms before running repository initialization', async () => {
        modalState.confirm.mockResolvedValue(true);
        const onInitializeRepository = vi.fn(async () => ({ success: true }));
        const onRefresh = vi.fn(async () => {});
        const { NotSourceControlRepositoryState } = await import('./NotSourceControlRepositoryState');

        const screen = await renderScreen(React.createElement(NotSourceControlRepositoryState as React.ComponentType<any>, {
            canInitializeRepository: true,
            initializeRepositoryBusy: false,
            onInitializeRepository,
            onRefresh,
        }));

        await screen.pressByTestIdAsync('scm-repository-init');

        expect(modalState.confirm).toHaveBeenCalledTimes(1);
        expect(onInitializeRepository).toHaveBeenCalledTimes(1);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('keeps initialization hidden when repository init is not available', async () => {
        const { NotSourceControlRepositoryState } = await import('./NotSourceControlRepositoryState');
        const screen = await renderScreen(React.createElement(NotSourceControlRepositoryState as React.ComponentType<any>, {
            canInitializeRepository: false,
            onInitializeRepository: vi.fn(),
            onRefresh: vi.fn(),
        }));

        expect(screen.findByTestId('scm-repository-init')).toBeNull();
    });
});
