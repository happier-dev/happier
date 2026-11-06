import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function findAncestor(instance: any, predicate: (node: any) => boolean) {
    let current = instance?.parent ?? null;
    while (current) {
        if (predicate(current)) return current;
        current = current.parent ?? null;
    }
    return null;
}

installMessageViewCommonModuleMocks({ storage: async (importOriginal) => importOriginal() });

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

describe('MessageView (copy button hitSlop, web)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps selectable message actions visible across rows while selection mode is active on web', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState((state) => ({ settings: { ...state.settings, transcriptMessageSelectionEnabled: true } }));
        const { MessageView } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

        const firstMessage: any = {
            kind: 'user-text',
            localId: 'local-1',
            id: 'm1',
            text: 'hello',
        };
        const secondMessage: any = {
            kind: 'user-text',
            localId: 'local-2',
            id: 'm2',
            text: 'second',
        };

        const screen = await renderScreen(
            <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1', 'm2']}>
                <MessageView message={firstMessage} metadata={null} sessionId="s1" />
                <MessageView message={secondMessage} metadata={null} sessionId="s1" />
            </TranscriptMessageSelectionProvider>,
        );

        const firstActions = screen.findByTestId('transcript-message-actions:m1');
        const firstHoverableRow = findAncestor(
            firstActions,
            (node: any) => node.type === 'View' && typeof node.props.onPointerEnter === 'function',
        );
        expect(firstHoverableRow).not.toBeNull();
        await act(async () => {
            firstHoverableRow!.props.onPointerEnter();
        });
        await act(async () => {
            screen.findByTestId('transcript-message-select:m1')!.props.onPress();
        });

        const secondSelect = screen.findByTestId('transcript-message-select:m2');
        expect(secondSelect).not.toBeNull();
        expect(secondSelect!.props.accessibilityRole).toBe('checkbox');
        expect(secondSelect!.props.accessibilityState).toEqual({ checked: false });
        const secondActionsOpacity = (screen.findByTestId('transcript-message-actions:m2')?.props.style as unknown[])
            .flat(Infinity)
            .map((entry) => (entry as { opacity?: unknown } | null)?.opacity)
            .find((opacity) => typeof opacity === 'number');
        expect(secondActionsOpacity).toBe(1);
    });

    it('does not use hitSlop on web (avoids overlapping hit targets for sibling actions)', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState((state) => ({ settings: { ...state.settings, transcriptMessageSelectionEnabled: true } }));
        const { MessageView } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: 'hello',
        };

        const screen = await renderScreen(
            <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['local-1']}>
                <MessageView message={message} metadata={null} sessionId="s1" />
            </TranscriptMessageSelectionProvider>,
        );

        const copyButton = screen.findByTestId('transcript-message-copy:local-1');
        expect(copyButton).toBeTruthy();

        const copyPressables = screen.findAll(
            (node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === 'common.copy',
        );
        expect(copyPressables).toHaveLength(1);
        expect(copyPressables[0].props.hitSlop).toBeUndefined();

        const selectButton = screen.findByTestId('transcript-message-select:local-1');
        expect(selectButton).not.toBeNull();
        expect(selectButton!.props.hitSlop).toBeUndefined();
    });
});
