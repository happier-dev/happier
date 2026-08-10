import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { UserTextMessage } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toggleMessagePinSpy = vi.fn<(pin: PersistedSessionMessagePinV1) => void>();

installMessageViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const { createReducer } = await import('@/sync/reducer/reducer');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'transcriptMessageTimestampDisplayMode') return 'hover_web_hidden_mobile';
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'toolViewTimelineChromeMode') return 'cards';
                    return null;
                },
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('MarkdownView', props, props.children),
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

const userMessage: UserTextMessage = {
    kind: 'user-text',
    id: 'u1',
    localId: 'local-u1',
    createdAt: 1,
    text: 'hello',
    seq: 7,
    transcriptBlockIndex: 0,
};

let restoreWindow: (() => void) | null = null;

describe('MessageView row action reveal on a coarse-primary-pointer web host', () => {
    // The shared vitest setup restores DOM globals before every test, so the
    // fake host has to be installed after that hook, not once for the file.
    beforeEach(() => {
        const previousWindow = (globalThis as { window?: unknown }).window;
        (globalThis as { window?: unknown }).window = {
            matchMedia: (query: string) => ({
                matches: query === '(pointer: coarse)' || query === '(hover: none)',
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
            }),
        };
        restoreWindow = () => {
            (globalThis as { window?: unknown }).window = previousWindow;
        };
    });

    afterEach(() => {
        standardCleanup();
        restoreWindow?.();
        restoreWindow = null;
    });

    it('keeps the row actions and the pin visible without hover', async () => {
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={userMessage}
                messagePins={[]}
                onToggleMessagePin={toggleMessagePinSpy}
            />,
        );

        // A phone/tablet browser has no hover, so hiding the actions behind hover
        // would make them unreachable.
        expect(readOpacity(screen.findByTestId('transcript-message-actions:u1')?.props.style)).toBe(1);
        expect(readOpacity(screen.findByTestId('transcript-message-pin-slot:u1')?.props.style)).toBe(1);
    });
});
