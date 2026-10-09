import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ProjectHideUndoNotice } from './ProjectHideUndoNotice';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('ProjectHideUndoNotice (lab p-projects HIDE)', () => {
    it('undoes the Hide it belongs to and leaves', async () => {
        const undo = vi.fn(async () => true);
        const onDismiss = vi.fn();
        const screen = await renderScreen(<ProjectHideUndoNotice testID="undo" undo={{ isCurrent: () => true, undo }} onDismiss={onDismiss} />);
        await screen.pressByTestIdAsync('undo-action');
        expect(undo).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('offers no Undo once that Hide is no longer current', async () => {
        const screen = await renderScreen(<ProjectHideUndoNotice testID="undo" undo={{ isCurrent: () => false, undo: async () => true }} onDismiss={() => {}} />);
        expect(screen.findByTestId('undo-action')).toBeFalsy();
    });

    it('leaves on its own after its lifetime, even when the host re-renders with a new dismiss callback', async () => {
        vi.useFakeTimers();
        try {
            const dismissed = vi.fn();
            const receipt = { isCurrent: () => true, undo: async () => true };
            const screen = await renderScreen(<ProjectHideUndoNotice undo={receipt} onDismiss={() => dismissed()} />);
            vi.advanceTimersByTime(3_000);
            screen.tree.update(<ProjectHideUndoNotice undo={receipt} onDismiss={() => dismissed()} />);
            vi.advanceTimersByTime(2_500);
            expect(dismissed).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
