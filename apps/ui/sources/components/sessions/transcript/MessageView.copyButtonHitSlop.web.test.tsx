import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { renderWithSessionTranscriptSource as renderScreen } from '@/dev/testkit/sessionTranscriptSource';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({ storage: async (importOriginal) => importOriginal() });

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

// Compile the real message graph during collection, after installing its boundaries.
await import('./MessageView');

function findAncestor(instance: any, predicate: (node: any) => boolean) {
    let current = instance?.parent ?? null;
    while (current) {
        if (predicate(current)) return current;
        current = current.parent ?? null;
    }
    return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function readRevealOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

describe('MessageView (copy button target, web)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps selectable message actions visible across rows while selection mode is active on web', async () => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({ transcriptMessageSelectionEnabled: true });
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
        expect(readRevealOpacity(screen.findByTestId('transcript-message-actions:m1')?.props.style)).toBe(1);
        await act(async () => {
            screen.findByTestId('transcript-message-select:m1')!.props.onPress();
        });

        const secondSelect = screen.findByTestId('transcript-message-select:m2');
        expect(secondSelect).not.toBeNull();
        expect(secondSelect!.props.accessibilityRole).toBe('checkbox');
        expect(secondSelect!.props.accessibilityState).toEqual({ checked: false });
        // Selection mode reveals every eligible row's actions, not just the hovered one.
        expect(readRevealOpacity(screen.findByTestId('transcript-message-actions:m2')?.props.style)).toBe(1);
    });

    it('does not use hitSlop on web (avoids overlapping hit targets for sibling actions)', async () => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({ transcriptMessageSelectionEnabled: true });
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            id: 'local-1',
            text: 'hello',
        };

        const screen = await renderScreen(
            <MessageView message={message} metadata={null} sessionId="s1" />,
        );

        const copyButton = screen.findByTestId('transcript-message-copy:local-1');
        expect(copyButton).toBeTruthy();

        const copyPressables = screen.findAll(
            (node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === 'common.copy',
        );
        expect(copyPressables).toHaveLength(1);
        const copyStyle = typeof copyPressables[0].props.style === 'function'
            ? copyPressables[0].props.style({ pressed: false })
            : copyPressables[0].props.style;
        const minimumSize = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
        expect(flattenStyle(copyStyle).width).toBeGreaterThanOrEqual(minimumSize);
        expect(flattenStyle(copyStyle).height).toBeGreaterThanOrEqual(minimumSize);
        expect(copyPressables[0].props.hitSlop ?? 0).toBe(0);
    });
});
