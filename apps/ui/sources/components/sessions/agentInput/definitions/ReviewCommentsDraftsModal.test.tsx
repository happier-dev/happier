import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';

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

const routerPushSpy = vi.fn();
const resolveReviewCommentDraftAnchorsForPromptSpy = vi.fn(async (input: {
    drafts: readonly ReviewCommentDraft[];
}) => [...input.drafts]);

vi.mock('expo-router', () => ({
    useRouter: () => ({
        push: routerPushSpy,
    }),
    usePathname: () => '/session/session-1',
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

vi.mock('@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt', () => ({
    resolveReviewCommentDraftAnchorsForPrompt: resolveReviewCommentDraftAnchorsForPromptSpy,
}));

afterEach(() => {
    routerPushSpy.mockReset();
    resolveReviewCommentDraftAnchorsForPromptSpy.mockReset();
    resolveReviewCommentDraftAnchorsForPromptSpy.mockImplementation(async (input: {
        drafts: readonly ReviewCommentDraft[];
    }) => [...input.drafts]);
});

describe('ReviewCommentsDraftsModal', () => {
    it('jumps to the anchored file line from the draft card', async () => {
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
                lineHash: 'lh1:868452fa92233a56',
            },
            snapshot: {
                beforeContext: [],
                selectedLines: ["+process.env.JWT_SECRET = 'test-secret-with-at-least-thirty-two-chars';"],
                afterContext: [],
            },
            body: 'change this',
            createdAt: 1,
        } satisfies ReviewCommentDraft;

        const screen = await renderScreen(
            <ReviewCommentsDraftsModal
                onClose={() => {}}
                sessionId="session-1"
                reviewCommentDrafts={[draft]}
                onUpdateDraft={() => {}}
                onDeleteDraft={() => {}}
            />,
        );

        screen.findByTestId('review-comment-draft-jump:draft-1')!.props.onPress();

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/file?path=src%2Fmiddleware%2FrequestId.test.ts&source=diff&anchor=diffLine&startLine=8&side=after&newLine=8&lineHash=lh1%3A868452fa92233a56');
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
                sessionId="session-1"
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

    it('refreshes the preview from daemon anchor resolution when a review scope is available', async () => {
        const { ReviewCommentsDraftsModal } = await import('./ReviewCommentsDraftsModal');

        const draft = {
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: {
                beforeContext: [],
                selectedLines: ['const stale = true;'],
                afterContext: [],
            },
            body: 'check resolved line',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        resolveReviewCommentDraftAnchorsForPromptSpy.mockResolvedValueOnce([{
            ...draft,
            anchorResolution: {
                id: 'draft-1',
                filePath: 'src/a.ts',
                originalAnchor: draft.anchor,
                resolvedAnchor: { kind: 'line', filePath: 'src/a.ts', line: 3 },
                status: 'hash',
                confidence: 0.85,
                preview: {
                    beforeContext: ['const before = true;'],
                    selectedLines: ['const resolved = true;'],
                    afterContext: ['const after = true;'],
                },
            },
        } satisfies ReviewCommentDraft]);

        const screen = await renderScreen(
            <ReviewCommentsDraftsModal
                onClose={() => {}}
                sessionId="session-1"
                reviewScope={{ serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' }}
                reviewCommentDrafts={[draft]}
                onUpdateDraft={() => {}}
                onDeleteDraft={() => {}}
            />,
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(resolveReviewCommentDraftAnchorsForPromptSpy).toHaveBeenCalledWith(expect.objectContaining({
            reviewScope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
        }));
        expect(serialized).toContain('const resolved = true;');
        expect(serialized).not.toContain('const stale = true;');
    });
});
