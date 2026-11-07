import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { BoardUndeterminedLine } from './BoardUndeterminedLine';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('BoardUndeterminedLine', () => {
    it('shows incomplete task discovery without an invented count and offers recovery until complete', async () => {
        const retry = vi.fn();
        const undetermined = { count: 0, reasons: [] };
        const screen = await renderScreen(<BoardUndeterminedLine undetermined={undetermined} taskItemsComplete={false} onRetryTasks={retry} />);
        expect(screen.getTextContent()).toContain('Some task sources could not be read');
        expect(screen.findByTestId('board-undetermined-action')).toBeTruthy();
        screen.findByTestId('board-undetermined-action')?.props.onPress();
        expect(retry).toHaveBeenCalledOnce();
        await screen.update(<BoardUndeterminedLine undetermined={undetermined} taskItemsComplete />);
        expect(screen.findByTestId('board-undetermined')).toBeNull();
    });
    it('says what could not be checked and why, once, and nothing when everything was checked', async () => {
        const screen = await renderScreen(<BoardUndeterminedLine undetermined={{
            count: 2, reasons: [{ kind: 'session', reason: 'project_association_unavailable', count: 2 }],
        }} />);
        expect(screen.findByTestId('board-undetermined')).toBeTruthy();
        expect(screen.getTextContent()).toContain("2 sessions couldn't be checked");
        expect(screen.getTextContent()).toContain('Project association');
        await screen.update(<BoardUndeterminedLine undetermined={{ count: 0, reasons: [] }} />);
        expect(screen.findByTestId('board-undetermined')).toBeNull();
    });
});
