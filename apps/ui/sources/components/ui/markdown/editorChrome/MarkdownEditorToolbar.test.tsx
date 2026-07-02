import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type {
    MarkdownEditorCommand,
    MarkdownEditorController,
    MarkdownSelectionState,
} from '@/components/ui/markdown/editor/markdownEditorTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const hapticsLight = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight,
    hapticsError: vi.fn(),
}));

import { MarkdownEditorToolbar } from './MarkdownEditorToolbar';

const TEST_ID = 'md-toolbar';

const BASE_SELECTION: MarkdownSelectionState = {
    marks: { bold: false, italic: false, strike: false, code: false },
    blockType: 'paragraph',
    isLinkActive: false,
    canUndo: false,
    canRedo: false,
};

/**
 * A fake controller that drives the toolbar exactly like the real surface
 * controller would: it captures dispatched commands and lets the test push a
 * new selection state to the subscriber.
 */
function createFakeController(initial: MarkdownSelectionState = BASE_SELECTION) {
    const commands: MarkdownEditorCommand[] = [];
    let subscriber: ((state: MarkdownSelectionState) => void) | null = null;

    const controller: MarkdownEditorController = {
        runCommand: (command) => {
            commands.push(command);
        },
        subscribeSelection: (callback) => {
            subscriber = callback;
            callback(initial);
            return () => {
                subscriber = null;
            };
        },
    };

    return {
        controller,
        commands,
        push: (state: MarkdownSelectionState) => {
            subscriber?.(state);
        },
    };
}

describe('MarkdownEditorToolbar', () => {
    it('renders the Phase-1 formatting chips', async () => {
        const fake = createFakeController();
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        for (const id of [
            'heading1', 'heading2', 'heading3',
            'bold', 'italic', 'strike', 'code',
            'bulletList', 'orderedList', 'taskList',
            'blockquote', 'codeBlock', 'horizontalRule',
        ]) {
            expect(screen.findByTestId(`${TEST_ID}:${id}`)).not.toBeNull();
        }
    });

    it('dispatches the matching command and fires light haptics on chip press', async () => {
        hapticsLight.mockClear();
        const fake = createFakeController();
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        screen.pressByTestId(`${TEST_ID}:bold`);
        screen.pressByTestId(`${TEST_ID}:heading2`);
        screen.pressByTestId(`${TEST_ID}:taskList`);

        expect(fake.commands).toEqual([
            { kind: 'toggleBold' },
            { kind: 'setHeading', level: 2 },
            { kind: 'toggleTaskList' },
        ]);
        expect(hapticsLight).toHaveBeenCalledTimes(3);
    });

    it('reflects active marks from the selection state', async () => {
        const fake = createFakeController({
            ...BASE_SELECTION,
            marks: { bold: true, italic: false, strike: false, code: false },
            blockType: 'heading1',
        });
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        expect(screen.findByTestId(`${TEST_ID}:bold`)?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId(`${TEST_ID}:heading1`)?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId(`${TEST_ID}:italic`)?.props.accessibilityState?.selected).toBe(false);
        expect(screen.findByTestId(`${TEST_ID}:heading2`)?.props.accessibilityState?.selected).toBe(false);
    });

    it('updates active state when the selection changes', async () => {
        const fake = createFakeController();
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        expect(screen.findByTestId(`${TEST_ID}:italic`)?.props.accessibilityState?.selected).toBe(false);

        // Push a new selection through the live subscription (as the surface would
        // when the cursor enters italic text). Wrapped in act so React commits it.
        await act(async () => {
            fake.push({
                ...BASE_SELECTION,
                marks: { bold: false, italic: true, strike: false, code: false },
            });
        });

        expect(screen.findByTestId(`${TEST_ID}:italic`)?.props.accessibilityState?.selected).toBe(true);
    });

    it('hides the link actions when no link is selected', async () => {
        const fake = createFakeController();
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        expect(screen.findByTestId(`${TEST_ID}:openLink`)).toBeNull();
        expect(screen.findByTestId(`${TEST_ID}:unlink`)).toBeNull();
    });

    it('shows open + unlink (and no insert-link chip) when a link is active', async () => {
        const fake = createFakeController({
            ...BASE_SELECTION,
            isLinkActive: true,
            linkHref: 'https://example.com',
        });
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        expect(screen.findByTestId(`${TEST_ID}:openLink`)).not.toBeNull();
        expect(screen.findByTestId(`${TEST_ID}:unlink`)).not.toBeNull();
        // Phase 1 has no insert-link chip (R-A13).
        expect(screen.findByTestId(`${TEST_ID}:insertLink`)).toBeNull();
    });

    it('dispatches the unlink command when the unlink action is pressed', async () => {
        const fake = createFakeController({
            ...BASE_SELECTION,
            isLinkActive: true,
            linkHref: 'https://example.com',
        });
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        screen.pressByTestId(`${TEST_ID}:unlink`);

        expect(fake.commands).toContainEqual({ kind: 'unlink' });
    });

    it('dispatches the openLink command (via the controller, not a direct surface call) when open is pressed', async () => {
        const fake = createFakeController({
            ...BASE_SELECTION,
            isLinkActive: true,
            linkHref: 'https://example.com',
        });
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} />,
        );

        screen.pressByTestId(`${TEST_ID}:openLink`);

        expect(fake.commands).toContainEqual({ kind: 'openLink' });
    });

    it('renders all formatting chips in the inline variant (no footer bar)', async () => {
        // The inline variant strips the panel-bar wrapper + the keyboard-sticky
        // wrap on native, but the chips themselves stay identical — the host's
        // own header chrome surrounds it. Verifying the chips render with the
        // same testIDs guarantees press/active behavior is unchanged.
        const fake = createFakeController();
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={fake.controller} testID={TEST_ID} variant="inline" />,
        );

        for (const id of [
            'heading1', 'heading2', 'heading3',
            'bold', 'italic', 'strike', 'code',
            'bulletList', 'orderedList', 'taskList',
            'blockquote', 'codeBlock', 'horizontalRule',
        ]) {
            expect(screen.findByTestId(`${TEST_ID}:${id}`)).not.toBeNull();
        }
    });

    it('unsubscribes from selection updates on unmount', async () => {
        const unsubscribe = vi.fn();
        const controller: MarkdownEditorController = {
            runCommand: () => {},
            subscribeSelection: (callback) => {
                callback(BASE_SELECTION);
                return unsubscribe;
            },
        };
        const screen = await renderScreen(
            <MarkdownEditorToolbar controller={controller} testID={TEST_ID} />,
        );

        await screen.unmount();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
