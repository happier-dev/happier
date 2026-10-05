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
    onUpsertDraft?: (draft: ReviewCommentDraft) => void;
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
        if (!enabled) return;
        if (line.renderIsHeaderLine) return;

        const existingDraft = (draftsByLineId.get(line.id) ?? [])[0] ?? null;
        setActiveCommentLineId((prev) => (prev === line.id ? null : line.id));
        setActiveCommentRangeLines(null);
        setActiveEditingDraftId(existingDraft?.id ?? null);
        setCommentBody(existingDraft?.body ?? '');
    }, [draftsByLineId, enabled]);

    const onPressAddCommentRange = React.useCallback((rangeLines: readonly CodeLine[]) => {
        if (!enabled) return;
        const filtered = rangeLines.filter((line) => !line.renderIsHeaderLine);
        if (resolveReviewCommentRangeSide(source, filtered) === null) {
            onError?.(t('files.selectionFailed'));
            return;
        }
        const endLine = filtered[filtered.length - 1];
        if (!endLine) return;

        const existingDraft = (draftsByLineId.get(endLine.id) ?? [])[0] ?? null;
        setActiveCommentLineId(endLine.id);
        setActiveCommentRangeLines(filtered);
        setActiveEditingDraftId(existingDraft?.id ?? null);
        setCommentBody(existingDraft?.body ?? '');
    }, [draftsByLineId, enabled, onError, source]);

    const startEditingDraft = React.useCallback((line: CodeLine, draft: ReviewCommentDraft) => {
        if (!enabled) return;
        if (line.renderIsHeaderLine) return;
        setActiveCommentLineId(line.id);
        setActiveCommentRangeLines(null);
        setActiveEditingDraftId(draft.id);
        setCommentBody(draft.body);
    }, [enabled]);

    const renderAfterLine = React.useCallback((line: CodeLine) => {
        if (!enabled) return null;
        if (line.renderIsHeaderLine) return null;

        const drafts = draftsByLineId.get(line.id) ?? [];

        const isActive = activeCommentLineId === line.id;
        if (!isActive && drafts.length === 0) return null;

        const existing = activeEditingDraftId
            ? drafts.find((d) => d.id === activeEditingDraftId) ?? null
            : null;

        return (
            <View>
                {drafts.length > 0 && !isActive ? (
                    <ReviewCommentSavedDrafts
                        drafts={drafts}
                        onEditDraft={(draft) => startEditingDraft(line, draft)}
                        onDeleteDraft={onDeleteDraft}
                        onUpdateDraft={onUpsertDraft}
                        style={{ marginLeft: 0, marginRight: 8, marginTop: 6, gap: 6 }}
                        testID={`review-comment-saved-drafts:${line.id}`}
                    />
                ) : null}

                {isActive ? (
                    <ReviewCommentInlineComposer
                        value={commentBody}
                        onChange={setCommentBody}
                        onCancel={() => {
                            setActiveCommentLineId(null);
                            setActiveCommentRangeLines(null);
                            setActiveEditingDraftId(null);
                            setCommentBody('');
                        }}
                        onDelete={existing ? () => {
                            onDeleteDraft?.(existing.id);
                            setActiveCommentLineId(null);
                            setActiveCommentRangeLines(null);
                            setActiveEditingDraftId(null);
                            setCommentBody('');
                        } : undefined}
                        onSave={() => {
                            const body = commentBody.trim();
                            if (!body) {
                                onError?.(t('files.reviewComments.errors.empty'));
                                return;
                            }

                            const draft = activeCommentRangeLines && activeCommentRangeLines.length > 1
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
                            onUpsertDraft?.({
                                ...draft,
                                ...(existing?.includeInPrompt !== undefined ? { includeInPrompt: existing.includeInPrompt } : {}),
                            });
                            setActiveCommentLineId(null);
                            setActiveCommentRangeLines(null);
                            setActiveEditingDraftId(null);
                            setCommentBody('');
                        }}
                    />
                ) : null}
            </View>
        );
    }, [
        activeCommentLineId,
        activeCommentRangeLines,
        activeEditingDraftId,
        commentBody,
        contextRadius,
        draftsByLineId,
        enabled,
        filePath,
        lines,
        onDeleteDraft,
        onError,
        onUpsertDraft,
        source,
        startEditingDraft,
    ]);

    if (!enabled) return null;
    return { onPressAddComment, onPressAddCommentRange, renderAfterLine, isCommentActive };
}
