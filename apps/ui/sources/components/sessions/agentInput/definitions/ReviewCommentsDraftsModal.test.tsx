import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { clearPendingMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
        TextInput: (props: any) => React.createElement('TextInput', props),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit');
    return await createUnistylesMock({
        theme: {
            colors: {
                button: {
                    primary: { background: '#fff', tint: '#000' },
                },
                divider: '#333',
                surface: '#111',
                surfaceHigh: '#1a1a1a',
                text: '#eee',
                textSecondary: '#aaa',
                textDestructive: '#f00',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
    usePathname: () => '/session/s1',
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            upsertSessionReviewCommentDraft: vi.fn(),
            deleteSessionReviewCommentDraft: vi.fn(),
        }),
    },
}));

describe('ReviewCommentsDraftsModal', () => {
    afterEach(() => {
        clearPendingMobileSurfaceTransition();
        routerPushSpy.mockReset();
    });

    it('places the editable comment at the anchored line inside the context preview', async () => {
        const { ReviewCommentsDraftsModal } = await import('./ReviewCommentsDraftsModal');

        const draft = {
            id: 'draft-1',
            filePath: 'src/middleware/requestId.test.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                side: 'after',
                startLine: 8,
                newLine: 8,
                oldLine: null,
                lineHash: 'lh1:test',
            },
            snapshot: {
                beforeContext: [
                    "+import { handleAppError } from '../lib/errors.js';",
                    '+',
                ],
                selectedLines: [
                    "+process.env.JWT_SECRET = 'test-secret-with-at-least-thirty-two-chars';",
                ],
                afterContext: [
                    '+',
                    "+let requestId: typeof import('./requestId.js').requestId;",
                ],
            },
            body: 'change this',
            createdAt: 1,
        } satisfies ReviewCommentDraft;

        const screen = await renderScreen(
            <ReviewCommentsDraftsModal
                onClose={() => {}}
                sessionId="s1"
                reviewCommentDrafts={[draft]}
                onUpdateDraft={() => {}}
                onDeleteDraft={() => {}}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        const selectedLineIndex = serialized.indexOf("JWT_SECRET = 'test-secret");
        const commentIndex = serialized.indexOf('change this');
        const followingContextIndex = serialized.indexOf('requestId.js');

        expect(selectedLineIndex).toBeGreaterThanOrEqual(0);
        expect(commentIndex).toBeGreaterThan(selectedLineIndex);
        expect(followingContextIndex).toBeGreaterThan(commentIndex);
    });

    it('does not persist blank comment bodies and deletes blank drafts on close', async () => {
        const { ReviewCommentsDraftsModal } = await import('./ReviewCommentsDraftsModal');
        const onUpdateDraft = vi.fn();
        const onDeleteDraft = vi.fn();
        const draft = {
            id: 'draft-1',
            filePath: 'src/middleware/requestId.test.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                side: 'after',
                startLine: 8,
                newLine: 8,
                oldLine: null,
                lineHash: 'lh1:test',
            },
            snapshot: {
                beforeContext: ['+before'],
                selectedLines: ['+selected'],
                afterContext: ['+after'],
            },
            body: 'keep me',
            createdAt: 1,
        } satisfies ReviewCommentDraft;

        const screen = await renderScreen(
            <ReviewCommentsDraftsModal
                onClose={() => {}}
                sessionId="s1"
                reviewCommentDrafts={[draft]}
                onUpdateDraft={onUpdateDraft}
                onDeleteDraft={onDeleteDraft}
            />,
        );

        const input = screen.findByTestId('review-comment-draft-body:draft-1');
        await act(async () => {
            input?.props.onChangeText('   ');
        });
        await screen.pressByTestIdAsync('review-comments-drafts-modal-done');

        expect(onUpdateDraft).not.toHaveBeenCalled();
        expect(onDeleteDraft).toHaveBeenCalledWith('draft-1');
    });

    it('prepares a details transition when jumping to a review comment file', async () => {
        const { ReviewCommentsDraftsModal } = await import('./ReviewCommentsDraftsModal');
        const draft = {
            id: 'draft-1',
            filePath: 'src/middleware/requestId.test.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                side: 'after',
                startLine: 8,
                newLine: 8,
                oldLine: null,
                lineHash: 'lh1:test',
            },
            snapshot: {
                beforeContext: ['+before'],
                selectedLines: ['+selected'],
                afterContext: ['+after'],
            },
            body: 'change this',
            createdAt: 1,
        } satisfies ReviewCommentDraft;

        const screen = await renderScreen(
            <ReviewCommentsDraftsModal
                onClose={() => {}}
                sessionId="s1"
                reviewCommentDrafts={[draft]}
                onUpdateDraft={() => {}}
                onDeleteDraft={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('review-comment-draft-jump:draft-1');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/file?path=src%2Fmiddleware%2FrequestId.test.ts&source=diff&anchor=diffLine&startLine=8&side=after&newLine=8&lineHash=lh1%3Atest');
        const {
            resolvePendingMobileSurfaceTransitionStackOptions,
        } = await import('@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent');
        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'session/[id]/file',
        })).toEqual({
            animation: 'slide_from_right',
        });
    });
});
