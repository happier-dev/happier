import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { computeLineContentHash, findLineIndexByContentHash } from '@/utils/text/lineContentHash';

import {
    buildReviewCommentDraftFromCodeLine,
    formatReviewCommentCodeLineContent,
} from './buildReviewCommentDraftFromCodeLine';
import { ReviewCommentInlineComposer } from './ReviewCommentInlineComposer';

function anchorKeyForDraft(draft: ReviewCommentDraft): string {
    if (draft.anchor.kind === 'fileLine') {
        return `file:${draft.filePath}:L${draft.anchor.startLine}`;
    }
    return `diff:${draft.filePath}:${draft.anchor.side}:${draft.anchor.startLine}:${draft.anchor.oldLine ?? 'n'}:${draft.anchor.newLine ?? 'n'}`;
}

function anchorKeyForLine(params: { filePath: string; source: ReviewCommentSource; line: CodeLine }): string {
    if (params.source === 'file') {
        const startLine = typeof params.line.newLine === 'number' && params.line.newLine > 0 ? params.line.newLine : (params.line.sourceIndex + 1);
        return `file:${params.filePath}:L${startLine}`;
    }
    const side = params.line.kind === 'remove' ? 'before' : 'after';
    return `diff:${params.filePath}:${side}:${params.line.sourceIndex + 1}:${params.line.oldLine ?? 'n'}:${params.line.newLine ?? 'n'}`;
}

function isLineCandidateForDraft(params: { source: ReviewCommentSource; draft: ReviewCommentDraft; line: CodeLine }): boolean {
    if (params.draft.source !== params.source) return false;
    if (params.source !== 'diff' || params.draft.anchor.kind !== 'diffLine') return true;
    const side = params.line.kind === 'remove' ? 'before' : 'after';
    return side === params.draft.anchor.side;
}

function buildDraftsByResolvedLineId(params: Readonly<{
    filePath: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    drafts: readonly ReviewCommentDraft[];
}>): Map<string, ReviewCommentDraft[]> {
    const lineIdByAnchorKey = new Map<string, string>();
    const lineById = new Map<string, CodeLine>();
    for (const line of params.lines) {
        lineIdByAnchorKey.set(anchorKeyForLine({
            filePath: params.filePath,
            source: params.source,
            line,
        }), line.id);
        lineById.set(line.id, line);
    }

    const map = new Map<string, ReviewCommentDraft[]>();
    for (const draft of params.drafts) {
        if (draft.filePath !== params.filePath || draft.source !== params.source) continue;

        let lineId: string | null = null;
        const exactLineId = lineIdByAnchorKey.get(anchorKeyForDraft(draft)) ?? null;
        if (exactLineId) {
            const exactLine = lineById.get(exactLineId);
            const exactLineMatchesHash = !draft.anchor.lineHash || (
                exactLine
                && computeLineContentHash(formatReviewCommentCodeLineContent({
                    source: params.source,
                    line: exactLine,
                })) === draft.anchor.lineHash
            );
            if (exactLineMatchesHash) {
                lineId = exactLineId;
            }
        }
        if (!lineId && draft.anchor.lineHash) {
            const index = findLineIndexByContentHash({
                lines: params.lines,
                lineHash: draft.anchor.lineHash,
                isCandidate: (line) => isLineCandidateForDraft({
                    source: params.source,
                    draft,
                    line,
                }),
                getLineContent: (line) => formatReviewCommentCodeLineContent({
                    source: params.source,
                    line,
                }),
            });
            lineId = index >= 0 ? params.lines[index]?.id ?? null : null;
        }
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
    renderAfterLine: (line: CodeLine) => React.ReactNode;
    isCommentActive: (line: CodeLine) => boolean;
} | null {
    const { theme } = useUnistyles();

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
        return activeCommentLineId === line.id;
    }, [activeCommentLineId, enabled]);

    const onPressAddComment = React.useCallback((line: CodeLine) => {
        if (!enabled) return;
        if (line.renderIsHeaderLine) return;

        const existingDraft = (draftsByLineId.get(line.id) ?? [])[0] ?? null;
        setActiveCommentLineId((prev) => (prev === line.id ? null : line.id));
        setActiveEditingDraftId(existingDraft?.id ?? null);
        setCommentBody(existingDraft?.body ?? '');
    }, [draftsByLineId, enabled]);

    const startEditingDraft = React.useCallback((line: CodeLine, draft: ReviewCommentDraft) => {
        if (!enabled) return;
        if (line.renderIsHeaderLine) return;
        setActiveCommentLineId(line.id);
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
                    <View
                        style={{ marginLeft: 0, marginRight: 8, marginTop: 6, gap: 6 }}
                        testID={`review-comment-saved-drafts:${line.id}`}
                    >
                        {drafts.map((d) => (
                            <View
                                key={d.id}
                                style={{
                                    padding: 10,
                                    borderRadius: 10,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider ?? '#ddd',
                                    backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surface ?? '#fff',
                                }}
                            >
                                <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.text }}>
                                    {d.body}
                                </Text>
                                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6, gap: 10 }}>
                                    <Pressable
                                        accessibilityRole="button"
                                        onPress={() => startEditingDraft(line, d)}
                                        testID={`review-comment-draft-edit:${d.id}`}
                                    >
                                        <Text
                                            style={{
                                                ...Typography.default('semiBold'),
                                                fontSize: 12,
                                                color: theme.colors.textSecondary,
                                            }}
                                        >
                                            {t('common.edit')}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        accessibilityRole="button"
                                        onPress={() => onDeleteDraft?.(d.id)}
                                        testID={`review-comment-draft-delete:${d.id}`}
                                    >
                                        <Text
                                            style={{
                                                ...Typography.default('semiBold'),
                                                fontSize: 12,
                                                color: theme.colors.textDestructive ?? theme.colors.textSecondary,
                                            }}
                                        >
                                            {t('common.delete')}
                                        </Text>
                                    </Pressable>
                                </View>
                            </View>
                        ))}
                    </View>
                ) : null}

                {isActive ? (
                    <ReviewCommentInlineComposer
                        value={commentBody}
                        onChange={setCommentBody}
                        onCancel={() => {
                            setActiveCommentLineId(null);
                            setActiveEditingDraftId(null);
                            setCommentBody('');
                        }}
                        onDelete={existing ? () => {
                            onDeleteDraft?.(existing.id);
                            setActiveCommentLineId(null);
                            setActiveEditingDraftId(null);
                            setCommentBody('');
                        } : undefined}
                        onSave={() => {
                            const body = commentBody.trim();
                            if (!body) {
                                onError?.(t('files.reviewComments.errors.empty'));
                                return;
                            }

                            const draft = buildReviewCommentDraftFromCodeLine({
                                filePath,
                                source,
                                lines,
                                targetLine: line,
                                body,
                                contextRadius,
                                existing: existing ? { id: existing.id, createdAt: existing.createdAt } : null,
                            });
                            onUpsertDraft?.(draft);
                            setActiveCommentLineId(null);
                            setActiveEditingDraftId(null);
                            setCommentBody('');
                        }}
                    />
                ) : null}
            </View>
        );
    }, [
        activeCommentLineId,
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
        theme.colors.divider,
        theme.colors.surface,
        theme.colors.surfaceHighest,
        theme.colors.text,
        theme.colors.textDestructive,
        theme.colors.textSecondary,
    ]);

    if (!enabled) return null;
    return { onPressAddComment, renderAfterLine, isCommentActive };
}
