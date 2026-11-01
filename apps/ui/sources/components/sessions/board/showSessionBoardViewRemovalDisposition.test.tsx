import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SessionBoardViewRemovalDisposition } from './useSessionBoardController';

type ShownConfig = Readonly<{
    component: React.ComponentType<Record<string, unknown>>;
    props?: Record<string, unknown>;
    focusReturnRef?: Readonly<{ current: unknown }>;
    onRequestClose?: () => void;
    onHostUnmount?: () => void;
}>;

const modalShowMock = vi.hoisted(() => vi.fn((_config: ShownConfig) => 'view-removal-modal'));
const modalHideMock = vi.hoisted(() => vi.fn());
vi.mock('@/modal', () => ({
    Modal: {
        show: modalShowMock,
        hide: modalHideMock,
    },
}));
vi.mock('@/components/ui/selectionList', async () => {
    const ReactModule = await import('react');
    return {
        SelectionList: (props: Record<string, unknown>) => ReactModule.createElement('SelectionList', props),
        resolvePopoverSelectionListHeightBehavior: () => ({ kind: 'bounded' }),
    };
});

import { showSessionBoardViewRemovalDisposition } from './showSessionBoardViewRemovalDisposition';

function shownConfig(): ShownConfig {
    const config = modalShowMock.mock.calls.at(-1)?.[0];
    if (!config) throw new Error('view-removal chooser was not presented');
    return config;
}

async function renderShownChooser() {
    const config = shownConfig();
    return await renderScreen(React.createElement(config.component, {
        ...(config.props ?? {}),
        onClose: () => undefined,
    }));
}

const REQUEST = {
    source: { viewId: 'research', title: 'Research' },
};

describe('showSessionBoardViewRemovalDisposition', () => {
    beforeEach(() => {
        modalShowMock.mockClear();
        modalHideMock.mockClear();
    });

    it('offers each exact destination and explicit unpin as mutually exclusive choices', async () => {
        const pending = showSessionBoardViewRemovalDisposition({
            source: REQUEST.source,
            eligibleDestinations: [
                { viewId: 'overview', title: 'Overview' },
                { viewId: 'ship', title: 'Ship' },
            ],
        });
        const screen = await renderShownChooser();

        const list = screen.findByTestId('session-board-view-removal-choices');
        expect(list?.props.rootStep.sections[0].options.map((option: { id: string }) => option.id)).toEqual([
            'move:overview',
            'move:ship',
            'unpin',
        ]);

        list?.props.onSelect('move:ship');
        await expect(pending).resolves.toEqual({ kind: 'move', viewId: 'ship' } satisfies SessionBoardViewRemovalDisposition);
    });

    it('settles shared dismissal and host removal as cancellation without a write choice', async () => {
        const dismissed = showSessionBoardViewRemovalDisposition({
            source: REQUEST.source,
            eligibleDestinations: [{ viewId: 'overview', title: 'Overview' }],
        });
        shownConfig().onRequestClose?.();
        await expect(dismissed).resolves.toBeNull();

        const unmounted = showSessionBoardViewRemovalDisposition({
            source: REQUEST.source,
            eligibleDestinations: [{ viewId: 'overview', title: 'Overview' }],
        });
        shownConfig().onHostUnmount?.();
        await expect(unmounted).resolves.toBeNull();
    });

});
