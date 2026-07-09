import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => (
                typeof params?.label === 'string' ? `${key}:${params.label}` : key
            ),
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'kind' | 'seq' | 'promptPreview'>): TranscriptNavigationEntry {
    const pinned = overrides.pinned ?? overrides.kind.startsWith('pinned-');
    return {
        id: overrides.id,
        sessionId: 's1',
        seq: overrides.seq,
        routeMessageId: overrides.routeMessageId ?? `server:${overrides.id}`,
        transcriptBlockIndex: overrides.transcriptBlockIndex ?? null,
        kind: overrides.kind,
        role: overrides.role ?? (overrides.kind === 'pinned-assistant' ? 'assistant' : overrides.kind === 'pinned-tool' ? 'tool' : 'user'),
        label: overrides.label ?? overrides.promptPreview ?? 'Entry',
        promptPreview: overrides.promptPreview,
        responsePreview: overrides.responsePreview ?? null,
        createdAtMs: overrides.createdAtMs ?? Number(overrides.seq ?? 0) * 100,
        pinned,
        pinnedAtMs: overrides.pinnedAtMs ?? (pinned ? 1000 : null),
        loaded: overrides.loaded ?? true,
    };
}

const ENTRIES: readonly TranscriptNavigationEntry[] = [
    entry({
        id: 'turn-1',
        kind: 'user-turn',
        seq: 1,
        promptPreview: 'Set up the project',
        responsePreview: 'Project is ready',
        pinned: false,
        pinnedAtMs: null,
    }),
    entry({
        id: 'answer-1',
        kind: 'pinned-assistant',
        seq: 1,
        promptPreview: 'Set up the project',
        responsePreview: 'Important answer',
    }),
];

describe('TranscriptNavigationPanel', () => {
    it('switches between All and Pinned modes with the segmented control', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        );

        expect(screen.findByTestId('nav-entry:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:answer-1')).toBeTruthy();

        await screen.pressByTestIdAsync('nav-mode:pinned');

        expect(screen.findByTestId('nav-entry:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry:answer-1')).toBeTruthy();

        await screen.pressByTestIdAsync('nav-mode:all');
        expect(screen.findByTestId('nav-entry:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:answer-1')).toBeTruthy();
    });

    it('renders a compact empty pinned state when no entries are pinned', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={[
                    entry({
                        id: 'turn-1',
                        kind: 'user-turn',
                        seq: 1,
                        promptPreview: 'Only prompt',
                        pinned: false,
                        pinnedAtMs: null,
                    }),
                ]}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        );

        await screen.pressByTestIdAsync('nav-mode:pinned');

        expect(screen.findByTestId('nav-empty-pinned')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:turn-1')).toBeNull();

        // Actionable: explains how to pin and states the local-first privacy caveat.
        const textContent = screen.getTextContent();
        expect(textContent).toContain('session.transcriptNavigation.emptyPinnedHint');
        expect(textContent).toContain('session.transcriptNavigation.emptyPinnedPrivacy');
    });

    it('calls the entry click callback with the selected entry', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const onEntryPress = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={onEntryPress}
                testIDPrefix="nav"
            />,
        );

        screen.pressByTestId('nav-entry:answer-1');

        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(onEntryPress).toHaveBeenCalledWith(ENTRIES[1]);
    });

    it('renders localized fallback text for unloaded pinned entries without derivation labels', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const fallbackEntry = {
            ...entry({
                id: 'answer-unloaded',
                kind: 'pinned-assistant',
                seq: 4,
                promptPreview: null,
                responsePreview: null,
                label: '',
                loaded: false,
            }),
            fallbackLabelKind: 'pinned-assistant' as const,
        };
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={[fallbackEntry]}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        );

        expect(screen.getTextContent()).toContain('session.transcriptNavigation.fallbackPinnedAssistant');
        expect(screen.findByTestId('nav-entry:answer-unloaded')?.props.accessibilityLabel).toContain(
            'session.transcriptNavigation.fallbackPinnedAssistant',
        );
    });

    it('supports basic keyboard movement and activation when the harness exposes key handlers', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const onEntryPress = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={onEntryPress}
                testIDPrefix="nav"
            />,
        );

        const preventDefault = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
                nativeEvent: { key: 'ArrowDown' },
                preventDefault,
            });
        });
        invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
            nativeEvent: { key: 'Enter' },
            preventDefault,
        });

        expect(preventDefault).toHaveBeenCalled();
        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(onEntryPress).toHaveBeenCalledWith(ENTRIES[1]);
    });

    it('closes on Escape when the panel provides a close request handler', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const onRequestClose = vi.fn();
        const preventDefault = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={() => {}}
                onRequestClose={onRequestClose}
                testIDPrefix="nav"
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
            nativeEvent: { key: 'Escape' },
            preventDefault,
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('ignores Escape when no close request handler is provided', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const preventDefault = vi.fn();
        const onEntryPress = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={onEntryPress}
                testIDPrefix="nav"
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
            nativeEvent: { key: 'Escape' },
            preventDefault,
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(onEntryPress).not.toHaveBeenCalled();
    });
});
