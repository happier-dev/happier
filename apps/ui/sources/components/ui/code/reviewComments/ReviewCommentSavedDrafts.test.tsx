import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { buildReviewCommentDraftFromCodeLine } from './buildReviewCommentDraftFromCodeLine';
import { useCodeLinesReviewComments } from './useCodeLinesReviewComments';
import { ReviewCommentInlineComposer } from './ReviewCommentInlineComposer';
import { ReviewCommentSavedDrafts } from './ReviewCommentSavedDrafts';

const lines = buildCodeLinesFromFile({ text: 'const key = route.key;' });
const initialDraft = buildReviewCommentDraftFromCodeLine({
    filePath: 'SettingsModal.tsx', source: 'file', lines, targetLine: lines[0]!,
    body: 'Use `route.key` here.', contextRadius: 2,
});

describe('saved inline review drafts', () => {
    afterEach(() => vi.useRealTimers());
    it('keeps a saved comment while toggling whether it goes with the next message', async () => {
        let current: readonly ReviewCommentDraft[] = [];
        function Harness() {
            const [drafts, setDrafts] = React.useState([initialDraft]);
            current = drafts;
            const controls = useCodeLinesReviewComments({
                enabled: true, filePath: initialDraft.filePath, source: 'file', lines, drafts,
                onUpsertDraft: (next) => setDrafts((saved) => saved.map((draft) => draft.id === next.id ? next : draft)),
            });
            return controls!.renderAfterLine(lines[0]!);
        }
        const screen = await renderScreen(<Harness />);
        const selector = `review-comment-draft-include:${initialDraft.id}`;
        expect(screen.findByTestId(selector)?.props.accessibilityState?.checked).toBe(true);
        await screen.pressByTestIdAsync(selector);
        expect(current).toEqual([{ ...initialDraft, includeInPrompt: false }]);
        expect(filterReviewCommentDraftsIncludedInPrompt(current)).toEqual([]);
        expect(screen.findByTestId(selector)?.props.accessibilityState?.checked).toBe(false);
        await screen.pressByTestIdAsync(selector);
        expect(filterReviewCommentDraftsIncludedInPrompt(current)).toEqual([{ ...initialDraft, includeInPrompt: true }]);
    });

    it('offers edit and delete from the draft menu and edits without changing attachment selection', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onUpsertDraft = vi.fn();
        const onDeleteDraft = vi.fn();
        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true, filePath: initialDraft.filePath, source: 'file', lines,
                drafts: [{ ...initialDraft, includeInPrompt: false }], onUpsertDraft, onDeleteDraft,
            });
            return controls!.renderAfterLine(lines[0]!);
        }
        const screen = await renderScreen(<Harness />);
        expect(screen.findHostByTestId(`review-comment-draft-edit:${initialDraft.id}`) === null).toBe(true);
        expect(screen.findHostByTestId(`review-comment-draft-delete:${initialDraft.id}`) === null).toBe(true);
        await screen.pressByTestIdAsync(`review-comment-draft-menu:${initialDraft.id}`);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const menu = screen.findByType(DropdownMenu);
        expect(menu.props.open).toBe(true);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['edit', 'delete']);
        // Deliver the public menu selection event; portal geometry belongs to DropdownMenu's live gate.
        await act(async () => menu.props.onSelect('edit'));
        const input = screen.findAll((node) => typeof node.type === 'string' && node.props.value === initialDraft.body)[0]!;
        expect(input).toBeTruthy();
        await act(async () => screen.findByType(ReviewCommentInlineComposer).props.onSave());
        expect(onUpsertDraft).toHaveBeenCalledWith(expect.objectContaining({ id: initialDraft.id, includeInPrompt: false }));
    });

    it('deletes a saved draft from the menu, without rendering unsupported attachment controls', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let current: readonly ReviewCommentDraft[] = [initialDraft];
        function Harness() {
            const [drafts, setDrafts] = React.useState([initialDraft]);
            current = drafts;
            return <ReviewCommentSavedDrafts drafts={drafts} onEditDraft={() => {}}
                onDeleteDraft={(id) => setDrafts((saved) => saved.filter((draft) => draft.id !== id))} />;
        }
        const screen = await renderScreen(<Harness />);
        expect(screen.findHostByTestId(`review-comment-draft-include:${initialDraft.id}`) === null).toBe(true);
        await screen.pressByTestIdAsync(`review-comment-draft-menu:${initialDraft.id}`);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => screen.findByType(DropdownMenu).props.onSelect('delete'));
        expect(current).toEqual([]);
        expect(screen.findHostByTestId(`review-comment-draft:${initialDraft.id}`) === null).toBe(true);
    });
});
