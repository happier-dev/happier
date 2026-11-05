import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectHostText, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { DesktopActivityOverlayCollapsed, type DesktopActivityOverlayStatusSlots } from './DesktopActivityOverlayCollapsed';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => { standardCleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function island(slots: DesktopActivityOverlayStatusSlots, onPress = vi.fn(), onRender = vi.fn()) {
    return <React.Profiler id="island-word" onRender={onRender}>
        <DesktopActivityOverlayCollapsed orientation="row" cameraGap={null} slots={slots}
            accessibilityLabel={slots.word?.text} onPress={onPress} onLayout={() => {}} />
    </React.Profiler>;
}

describe('collapsed shared activity word', () => {
    it('has zero idle commits and interval registrations, and displays a pushed word once', async () => {
        vi.useFakeTimers();
        const intervals = vi.spyOn(globalThis, 'setInterval');
        const commits = vi.fn();
        const screen = await renderScreen(island({ faces: null, word: { text: '2 working', needsYou: false } }, vi.fn(), commits));
        const baseline = commits.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(commits.mock.calls.length - baseline).toBe(0);
        expect(intervals).not.toHaveBeenCalled();
        expect(collectHostText(screen.tree)).toContain('2 working');
        await screen.update(island({ faces: null, word: { text: 'Needs you', needsYou: true } }, vi.fn(), commits));
        expect(commits.mock.calls.length - baseline).toBe(1);
        expect(collectHostText(screen.tree)).toContain('Needs you');
        expect(collectHostText(screen.tree)).not.toContain('2 working');
    });

    it('keeps a quiet completion word empty', async () => {
        const screen = await renderScreen(island({ faces: null, word: null }));
        expect(screen.findByTestId('desktop-activity-overlay-status-word')).toBeNull();
    });

    it('preserves keyboard-origin activation for the presentation owner', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(island({ faces: null, word: { text: 'Needs you', needsYou: true } }, onPress));
        const target = screen.root.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            invokeTestInstanceHandler(target, 'onKeyDownCapture', { key: 'Enter' });
            invokeTestInstanceHandler(target, 'onPress');
        });
        expect(onPress).toHaveBeenCalledWith('keyboard');
    });

    it('carries the word inside the island on a side dock with no faces, so no empty strip stands on the edge', async () => {
        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed orientation="column" cameraGap={null}
                slots={{ faces: null, word: { text: 'Needs you', needsYou: true } }}
                accessibilityLabel="Needs you" onPress={vi.fn()} onLayout={() => {}} />,
        );
        expect(screen.findByTestId('desktop-activity-overlay-collapsed-row')).not.toBeNull();
        expect(collectHostText(screen.tree)).toContain('Needs you');
    });
});
