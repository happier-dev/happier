import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import type { SessionListMoveSheetTarget } from './buildSessionListMoveSheetTargets';
import { SessionListMoveSheet } from './SessionListMoveSheet';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const enabledTarget: SessionListMoveSheetTarget = {
    id: 'root:workspace-a',
    kind: 'root',
    label: 'Workspace root',
    disabled: false,
    result: {
        instruction: {
            kind: 'move-to-root',
            containerId: 'workspace-a',
            rootId: 'workspace-a',
            depth: 0,
        },
        visual: { kind: 'outline', targetId: 'workspace-a' },
    },
};

const disabledTarget: SessionListMoveSheetTarget = {
    id: 'folder:child-a',
    kind: 'folder',
    label: 'Child folder',
    disabled: true,
    disabledReason: 'descendant-cycle',
    result: {
        instruction: { kind: 'blocked', reason: 'descendant-cycle' },
        visual: { kind: 'none' },
    },
};

describe('SessionListMoveSheet', () => {
    it('renders enabled and disabled move targets', async () => {
        const screen = await renderScreen(
            <SessionListMoveSheet
                sourceLabel="Planning"
                targets={[enabledTarget, disabledTarget]}
                onSelectTarget={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        expect(screen.findByTestId('session-list-move-sheet:root:option:root:workspace-a')).toBeTruthy();
        const disabledRow = screen.findByTestId('session-list-move-sheet:root:option:folder:child-a');
        expect(disabledRow?.props.disabled).toBe(true);
    });

    it('commits only enabled target presses', async () => {
        const onSelectTarget = vi.fn();
        const screen = await renderScreen(
            <SessionListMoveSheet
                sourceLabel="Planning"
                targets={[enabledTarget, disabledTarget]}
                onSelectTarget={onSelectTarget}
                onCancel={vi.fn()}
            />,
        );

        invokeTestInstanceHandler(
            screen.findByTestId('session-list-move-sheet:root:option:folder:child-a'),
            'onPress',
        );
        invokeTestInstanceHandler(
            screen.findByTestId('session-list-move-sheet:root:option:root:workspace-a'),
            'onPress',
        );

        expect(onSelectTarget).toHaveBeenCalledTimes(1);
        expect(onSelectTarget).toHaveBeenCalledWith(enabledTarget);
    });
});
