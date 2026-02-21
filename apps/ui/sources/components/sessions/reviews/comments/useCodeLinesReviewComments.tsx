import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import { buildReviewCommentDraftFromCodeLine } from './buildReviewCommentDraftFromCodeLine';
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

    const draftsByAnchorKey = React.useMemo(() => {
        const map = new Map<string, ReviewCommentDraft[]>();
        for (const d of drafts) {
            const key = anchorKeyForDraft(d);
            const existing = map.get(key);
            if (existing) existing.push(d);
            else map.set(key, [d]);
        }
        return map;
    }, [drafts]);

    const isCommentActive = React.useCallback((line: CodeLine): boolean => {
        if (!enabled) return false;
        if (line.renderIsHeaderLine) return false;
        return activeCommentLineId === line.id;
    }, [activeCommentLineId, enabled]);

    const onPressAddComment = React.useCallback((line: CodeLine) => {
        if (!enabled) return;
        if (line.renderIsHeaderLine) return;

        const key = anchorKeyForLine({ filePath, source, line });
        const existingDraft = (draftsByAnchorKey.get(key) ?? [])[0] ?? null;
        setActiveCommentLineId((prev) => (prev === line.id ? null : line.id));
        setActiveEditingDraftId(existingDraft?.id ?? null);
        setCommentBody(existingDraft?.body ?? '');
    }, [draftsByAnchorKey, enabled, filePath, source]);

    const renderAfterLine = React.useCallback((line: CodeLine) => {
        if (!enabled) return null;
        if (line.renderIsHeaderLine) return null;

        const key = anchorKeyForLine({ filePath, source, line });
        const drafts = draftsByAnchorKey.get(key) ?? [];

        const isActive = activeCommentLineId === line.id;
        if (!isActive && drafts.length === 0) return null;

        const existing = activeEditingDraftId
            ? drafts.find((d) => d.id === activeEditingDraftId) ?? null
            : null;

        return (
            <View>
                {drafts.length > 0 && !isActive ? (
                    <View style={{ marginLeft: 46, marginRight: 8, marginTop: 6, gap: 6 }}>
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
                                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 }}>
                                    <Text
                                        onPress={() => onDeleteDraft?.(d.id)}
                                        style={{
                                            ...Typography.default('semiBold'),
                                            fontSize: 12,
                                            color: theme.colors.textDestructive ?? theme.colors.textSecondary,
                                        }}
                                    >
                                        Delete
                                    </Text>
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
                                onError?.('Comment cannot be empty');
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
        draftsByAnchorKey,
        enabled,
        filePath,
        lines,
        onDeleteDraft,
        onError,
        onUpsertDraft,
        source,
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
