import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { installSessionAttachmentCommonModuleMocks } from '../attachments/sessionAttachmentTestHelpers';

const state = vi.hoisted(() => ({
    messages: [] as unknown[],
    isLoaded: true,
    navigate: vi.fn(),
    loadStatus: 'no_more' as 'no_more' | 'in_flight',
    switchSurface: vi.fn(),
}));

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock(),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
    text: () => createTextModuleMock({ translate: (key) => key }),
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));
vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: () => ({ status: 'loaded', uri: 'blob:preview', svgXml: null, error: null }),
}));
// Genuine boundaries: the sync store and the router-backed navigation entry.
vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/store/hooks')>()),
    useSessionMessages: () => ({ messages: state.messages, isLoaded: state.isLoaded }),
}));
vi.mock('@/sync/sync', () => ({
    sync: { loadOlderMessages: async () => ({ loaded: 0, hasMore: state.loadStatus === 'in_flight', status: state.loadStatus }) },
}));
vi.mock('@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation', () => ({
    useSessionCockpitSurfaceNavigation: () => ({ switchSurface: state.switchSurface, returnToPreviousSurface: vi.fn() }),
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => state.navigate,
}));
vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => {
    const React = await import('react');
    return {
        useMappingHelper: () => ({ getMappingKey: (_key: unknown, index: number) => index }),
        FlashList: (props: {
            data: readonly unknown[];
            renderItem: (info: { item: unknown }) => React.ReactNode;
            ListFooterComponent?: React.ReactNode;
        }) =>
            React.createElement('FlashList', null,
                props.data.map((item, index) =>
                    React.createElement(React.Fragment, { key: index }, props.renderItem({ item }))),
                props.ListFooterComponent),
    };
});

function imageMessage(id: string, seq: number, path: string): Message {
    return {
        kind: 'agent-text', id, seq, localId: null, createdAt: seq * 1000, text: '',
        meta: {
            happier: {
                kind: 'session_media.v1',
                payload: {
                    media: [{
                        id: `media-${id}`, role: 'output', category: 'generated', mediaKind: 'image',
                        name: path.split('/').pop(), path, mimeType: 'image/png', sizeBytes: 10,
                        origin: { source: 'provider-generated' },
                    }],
                },
            },
        },
    } as unknown as Message;
}

async function renderGrid() {
    const { SessionMediaGrid } = await import('./SessionMediaGrid');
    const screen = await renderScreen(<SessionMediaGrid sessionId="s1" onOpenFile={() => {}} />);
    await act(async () => {
        invokeTestInstanceHandler(
            screen.findByTestId('session-media-grid'),
            'onLayout',
            { nativeEvent: { layout: { width: 400, height: 600 } } },
        );
    });
    return screen;
}

describe('SessionMediaGrid', () => {
    beforeEach(() => {
        state.messages = [];
        state.isLoaded = true;
        state.navigate.mockClear();
        state.switchSurface.mockClear();
        state.loadStatus = 'no_more';
    });

    it('shows an empty state when the session has no media', async () => {
        const { SessionMediaGrid } = await import('./SessionMediaGrid');
        const screen = await renderScreen(<SessionMediaGrid sessionId="s1" onOpenFile={() => {}} />);

        expect(screen.findByTestId('session-media-grid-empty')).not.toBeNull();
    });

    it('jumps to the source message of a tile through the session route', async () => {
        state.messages = [
            imageMessage('m1', 4, '.happier/uploads/generated/m1/a.png'),
            imageMessage('m2', 9, '.happier/uploads/generated/m2/b.png'),
        ];
        const screen = await renderGrid();

        invokeTestInstanceHandler(screen.findByTestId('session-media-grid-jump:m2'), 'onPress');

        expect(state.navigate).toHaveBeenCalledWith('s1', { query: { jumpSeq: 9 } });
        // On the mobile cockpit the route alone would leave the user on Files; chat has to be revealed.
        expect(state.switchSurface).toHaveBeenCalledWith('chat');
        expect(screen.findByTestId('session-media-grid-image:.happier/uploads/generated/m1/a.png')).not.toBeNull();
    });

    it('shows the newest 8 first and reveals the rest with Show all', async () => {
        state.messages = Array.from({ length: 10 }, (_, index) =>
            imageMessage(`m${index + 1}`, index + 1, `.happier/uploads/generated/m${index + 1}/img.png`));
        const screen = await renderGrid();
        const tileCount = () => screen.root
            .findAll((node) => String(node.props?.testID ?? '').startsWith('session-media-grid-jump:')).length;

        expect(tileCount()).toBe(8);
        expect(screen.findByTestId('session-media-grid-jump:m10')).not.toBeNull();
        expect(screen.findByTestId('session-media-grid-jump:m2')).toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('session-media-grid-show-all'), 'onPress');
        });

        expect(tileCount()).toBe(10);
        expect(screen.findByTestId('session-media-grid-show-all')).toBeNull();
        expect(screen.findByTestId('session-media-grid-unknown')).toBeNull();
    });

    it('ends the grid with a question-mark tile while older history is still unknown', async () => {
        state.loadStatus = 'in_flight';
        state.messages = [imageMessage('m1', 1, '.happier/uploads/generated/m1/img.png')];
        const screen = await renderGrid();

        expect(screen.findByTestId('session-media-grid-unknown')).not.toBeNull();
        expect(screen.findByTestId('session-media-grid-jump:m1')).not.toBeNull();
    });
});
