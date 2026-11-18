import * as React from 'react';
import { View } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { t } from '@/text';
import type { ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import {
    buildReviewCommentDraftFromCodeLine,
    buildReviewCommentDraftFromCodeLineRange,
    resolveReviewCommentRangeSide,
} from './buildReviewCommentDraftFromCodeLine';
import { resolveCodeLineAnchor } from './resolveCodeLineAnchor';
import { ReviewCommentInlineComposer } from './ReviewCommentInlineComposer';
import { ReviewCommentSavedDrafts } from './ReviewCommentSavedDrafts';

function buildDraftsByResolvedLineId(params: Readonly<{
    filePath: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    drafts: readonly ReviewCommentDraft[];
}>): Map<string, ReviewCommentDraft[]> {
    const map = new Map<string, ReviewCommentDraft[]>();
    for (const draft of params.drafts) {
        if (draft.filePath !== params.filePath || draft.source !== params.source) continue;
        const resolution = resolveCodeLineAnchor({ filePath: params.filePath, source: params.source, lines: params.lines, anchor: draft.anchor });
        const lineId = resolution.lines[resolution.lines.length - 1]?.id;
        if (!lineId) continue;

        const existing = map.get(lineId);
        if (existing) existing.push(draft);
        else map.set(lineId, [draft]);
    }

    return map;
}

export function useCodeLinesReviewComments(params: {
    enabled: boolean;
    filePath: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    drafts: readonly ReviewCommentDraft[];
    contextRadius?: number;
    onUpsertDraft?: (draft: ReviewCommentDraft) => void | Promise<void>;
    onDeleteDraft?: (commentId: string) => void;
    onError?: (message: string) => void;
}): {
    onPressAddComment: (line: CodeLine) => void;
    onPressAddCommentRange: (rangeLines: readonly CodeLine[]) => void;
    renderAfterLine: (line: CodeLine) => React.ReactNode;
    isCommentActive: (line: CodeLine) => boolean;
} | null {
    const enabled = params.enabled;
    const filePath = params.filePath;
    const source = params.source;
    const lines = params.lines;
    const drafts = params.drafts;
    const contextRadius = params.contextRadius ?? 2;
    const onUpsertDraft = params.onUpsertDraft;
    const onDeleteDraft = params.onDeleteDraft;
    const onError = params.onError;

    const [activeCommentLineId, setActiveCommentLineId] = React.useState<string | null>(null);
    const [activeCommentRangeLines, setActiveCommentRangeLines] = React.useState<readonly CodeLine[] | null>(null);
    const [activeEditingDraftId, setActiveEditingDraftId] = React.useState<string | null>(null);
    const [commentBody, setCommentBody] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const attemptedDraft = React.useRef<ReviewCommentDraft | null>(null);

    const closeComposer = React.useCallback(() => {
        attemptedDraft.current = null;
        setActiveCommentLineId(null);
        setActiveCommentRangeLines(null);
        setActiveEditingDraftId(null);
        setCommentBody('');
    }, []);

    const draftsByLineId = React.useMemo(() => buildDraftsByResolvedLineId({
        filePath,
        source,
        lines,
        drafts,
    }), [drafts, filePath, lines, source]);

    const isCommentActive = React.useCallback((line: CodeLine): boolean => {
        if (!enabled) return false;
        if (line.renderIsHeaderLine) return false;
        if (activeCommentRangeLines?.some((rangeLine) => rangeLine.id === line.id) === true) return true;
        return activeCommentLineId === line.id;
    }, [activeCommentLineId, activeCommentRangeLines, enabled]);

    const onPressAddComment = React.useCallback((line: CodeLine) => {
        if (!enabled || saving) return;
        if (line.renderIsHeaderLine) return;

        attemptedDraft.current = null;
        const existingDraft = (draftsByLineId.get(line.id) ?? [])[0] ?? null;
        setActiveCommentLineId((prev) => (prev === line.id ? null : line.id));
        setActiveCommentRangeLines(null);
        setActiveEditingDraftId(existingDraft?.id ?? null);
        setCommentBody(existingDraft?.body ?? '');
    }, [draftsByLineId, enabled, saving]);

    const onPressAddCommentRange = React.useCallback((rangeLines: readonly CodeLine[]) => {
        if (!enabled || saving) return;
        const filtered = rangeLines.filter((line) => !line.renderIsHeaderLine);
        if (resolveReviewCommentRangeSide(source, filtered) === null) {
            onError?.(t('files.selectionFailed'));
            return;
        }
        const endLine = filtered[filtered.length - 1];
        if (!endLine) return;

        attemptedDraft.current = null;
        const existingDraft = (draftsByLineId.get(endLine.id) ?? [])[0] ?? null;
        setActiveCommentLineId(endLine.id);
        setActiveCommentRangeLines(filtered);
        setActiveEditingDraftId(existingDraft?.id ?? null);
        setCommentBody(existingDraft?.body ?? '');
    }, [draftsByLineId, enabled, onError, saving, source]);

    const startEditingDraft = React.useCallback((line: CodeLine, draft: ReviewCommentDraft) => {
        if (!enabled || saving) return;
        if (line.renderIsHeaderLine) return;
        attemptedDraft.current = null;
        setActiveCommentLineId(line.id);
        setActiveCommentRangeLines(null);
        setActiveEditingDraftId(draft.id);
        setCommentBody(draft.body);
    }, [enabled, saving]);

    const renderAfterLine = React.useCallback((line: CodeLine) => {
        if (!enabled) return null;
        if (line.renderIsHeaderLine) return null;

        const drafts = draftsByLineId.get(line.id) ?? [];

        const isActive = activeCommentLineId === line.id;
        if (!isActive && drafts.length === 0) return null;

        const existing = activeEditingDraftId
            ? drafts.find((d) => d.id === activeEditingDraftId) ?? null
            : null;

        // One placement for both states, so saving a comment swaps the card in place.
        return (
            <View style={{ marginTop: 6, marginRight: 8 }}>
                {drafts.length > 0 && !isActive ? (
                    <ReviewCommentSavedDrafts
                        drafts={drafts}
                        onEditDraft={(draft) => startEditingDraft(line, draft)}
                        onDeleteDraft={onDeleteDraft}
                        onUpdateDraft={onUpsertDraft}
                        style={{ gap: 6 }}
                        testID={`review-comment-saved-drafts:${line.id}`}
                    />
                ) : null}

                {isActive ? (
                    <ReviewCommentInlineComposer
                        value={commentBody}
                        onChange={setCommentBody}
                        saving={saving}
                        onCancel={closeComposer}
                        onDelete={existing ? () => {
                            onDeleteDraft?.(existing.id);
                            closeComposer();
                        } : undefined}
                        onSave={() => {
                            if (saving) return;
                            const body = commentBody.trim();
                            if (!body) {
                                onError?.(t('files.reviewComments.errors.empty'));
                                return;
                            }

                            const previous = attemptedDraft.current;
                            const draft = previous?.body === body ? previous : activeCommentRangeLines && activeCommentRangeLines.length > 1
                                ? buildReviewCommentDraftFromCodeLineRange({
                                    filePath,
                                    source,
                                    lines,
                                    rangeLines: activeCommentRangeLines,
                                    body,
                                    contextRadius,
                                    existing: existing ? { id: existing.id, createdAt: existing.createdAt } : null,
                                })
                                : buildReviewCommentDraftFromCodeLine({
                                    filePath,
                                    source,
                                    lines,
                                    targetLine: line,
                                    body,
                                    contextRadius,
                                    existing: existing ? { id: existing.id, createdAt: existing.createdAt } : null,
                                });
                            const submittedDraft = {
                                ...draft,
                                ...(existing?.includeInPrompt !== undefined ? { includeInPrompt: existing.includeInPrompt } : {}),
                            };
                            attemptedDraft.current = submittedDraft;
                            const fail = (error: unknown) => {
                                setSaving(false);
                                onError?.(error instanceof Error ? error.message : t('common.error'));
                            };
                            try {
                                const write = onUpsertDraft?.(submittedDraft);
                                if (write) {
                                    setSaving(true);
                                    void write.then(() => {
                                        closeComposer();
                                        setSaving(false);
                                    }, fail);
                                } else {
                                    closeComposer();
                                }
                            } catch (error) {
                                fail(error);
                            }
                        }}
                    />
                ) : null}
            </View>
        );
    }, [
        activeCommentLineId,
        activeCommentRangeLines,
        activeEditingDraftId,
        closeComposer,
        commentBody,
        contextRadius,
        draftsByLineId,
        enabled,
        filePath,
        lines,
        onDeleteDraft,
        onError,
        onUpsertDraft,
        saving,
        source,
        startEditingDraft,
    ]);

    if (!enabled) return null;
    return { onPressAddComment, onPressAddCommentRange, renderAfterLine, isCommentActive };
}
