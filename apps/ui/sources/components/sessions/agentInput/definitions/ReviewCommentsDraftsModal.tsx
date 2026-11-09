import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import {
    isReviewCommentDraftIncludedInPrompt,
} from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { formatReviewCommentAnchorLabel } from '@/sync/domains/input/reviewComments/reviewCommentPresentation';
import { t } from '@/text';
import type { WorkspaceFileOpen } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

function renderSnippetLines(params: {
    draftId: string;
    lines: readonly string[];
    style: React.ComponentProps<typeof Text>['style'];
    testIDPrefix: string;
}) {
    return params.lines.map((line, index) => (
        <Text
            key={`${params.draftId}:${params.testIDPrefix}:${index}`}
            numberOfLines={1}
            style={params.style}
            testID={`review-comment-draft-${params.testIDPrefix}:${params.draftId}:${index}`}
        >
            {line}
        </Text>
    ));
}

export function ReviewCommentsDraftsModal(props: CustomModalInjectedProps & Readonly<{
    sessionId?: string;
    openFile?: WorkspaceFileOpen;
    reviewScope?: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpdateDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft: (draftId: string) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const {
        onClose,
        onDeleteDraft,
        onUpdateDraft,
        reviewCommentDrafts,
    } = props;
    const sessionId = typeof props.sessionId === 'string' && props.sessionId.trim().length > 0
        ? props.sessionId
        : null;
    const [drafts, setDrafts] = React.useState(() => [...reviewCommentDrafts]);

    React.useEffect(() => {
        const controller = new AbortController();
        setDrafts([...reviewCommentDrafts]);
        if (!props.reviewScope || reviewCommentDrafts.length === 0) {
            return () => {
                controller.abort();
            };
        }

        void resolveReviewCommentDraftAnchorsForPrompt({
            drafts: reviewCommentDrafts,
            reviewScope: props.reviewScope,
            signal: controller.signal,
        }).then((resolvedDrafts) => {
            if (!controller.signal.aborted) {
                setDrafts(resolvedDrafts);
            }
        }, () => { /* Cancelled resolution keeps the draft's last known anchor. */ });
        return () => {
            controller.abort();
        };
    }, [props.reviewScope, reviewCommentDrafts]);

    const updateDraft = React.useCallback((draftId: string, updater: (draft: ReviewCommentDraft) => ReviewCommentDraft) => {
        setDrafts((current) => current.map((draft) => {
            if (draft.id !== draftId) return draft;
            const next = updater(draft);
            onUpdateDraft(next);
            return next;
        }));
    }, [onUpdateDraft]);

    const deleteDraft = React.useCallback((draftId: string) => {
        onDeleteDraft(draftId);
        setDrafts((current) => current.filter((draft) => draft.id !== draftId));
    }, [onDeleteDraft]);

    const jumpToDraft = React.useCallback((draft: ReviewCommentDraft) => {
        if (!sessionId || !props.openFile) return;
        onClose();
        fireAndForget(props.openFile({ kind: 'session', sessionId, path: draft.filePath,
            ...(props.reviewScope?.serverId ? { serverId: props.reviewScope.serverId } : {}) },
        { view: draft.source === 'diff' ? 'changes' : 'view', anchor: draft.anchor, anchorSource: draft.source }), { tag: 'ReviewCommentsDraftsModal.jumpToDraft' });
    }, [onClose, props.openFile, props.reviewScope?.serverId, sessionId]);

    const includedCount = drafts.filter(isReviewCommentDraftIncludedInPrompt).length;

    return (
        <View style={styles.container} testID="review-comments-drafts-modal">
            <View style={styles.summaryRow}>
                <Text style={styles.summaryText}>
                    {t('files.reviewComments.modalSummary', { included: includedCount, count: drafts.length })}
                </Text>
            </View>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                {drafts.map((draft) => {
                    const included = isReviewCommentDraftIncludedInPrompt(draft);
                    return (
                        <View key={draft.id} style={styles.card} testID={`review-comment-draft:${draft.id}`}>
                            <View style={styles.cardHeader}>
                                <Pressable
                                    accessibilityRole="checkbox"
                                    accessibilityState={{ checked: included }}
                                    onPress={() => {
                                        updateDraft(draft.id, (current) => ({
                                            ...current,
                                            includeInPrompt: !included,
                                        }));
                                    }}
                                    style={[styles.includeToggle, included ? styles.includeToggleOn : styles.includeToggleOff]}
                                    testID={`review-comment-draft-include:${draft.id}`}
                                >
                                    {included ? (
                                        <Icon name="check" size={14} color={theme.colors.button.primary.tint} />
                                    ) : null}
                                </Pressable>
                                <View style={styles.titleColumn}>
                                    <Text numberOfLines={1} style={styles.filePathText}>{draft.filePath}</Text>
                                    <Text numberOfLines={1} style={styles.anchorText}>
                                        {formatReviewCommentAnchorLabel(draft)}
                                    </Text>
                                </View>
                                {sessionId && props.openFile ? (
                                    <HappierPressable
                                        accessibilityLabel={t('files.reviewComments.jump')}
                                        accessibilityRole="button"
                                        onPress={() => jumpToDraft(draft)}
                                        style={styles.jumpButton}
                                        testID={`review-comment-draft-jump:${draft.id}`}
                                    >
                                        <Text style={styles.jumpButtonText}>{t('files.reviewComments.jump')}</Text>
                                    </HappierPressable>
                                ) : null}
                                <HappierPressable
                                    accessibilityLabel={t('common.delete')}
                                    accessibilityRole="button"
                                    onPress={() => deleteDraft(draft.id)}
                                    testID={`review-comment-draft-delete:${draft.id}`}
                                >
                                    <Icon name="trash" size={16} color={theme.colors.state.danger.foreground ?? theme.colors.text.secondary} />
                                </HappierPressable>
                            </View>

                            <View style={styles.snippet} testID={`review-comment-draft-context-preview:${draft.id}`}>
                                {renderSnippetLines({
                                    draftId: draft.id,
                                    lines: draft.anchorResolution?.preview?.beforeContext ?? draft.snapshot.beforeContext,
                                    style: styles.snippetText,
                                    testIDPrefix: 'before-line',
                                })}
                                {renderSnippetLines({
                                    draftId: draft.id,
                                    lines: draft.anchorResolution?.preview?.selectedLines ?? draft.snapshot.selectedLines,
                                    style: styles.snippetSelectedText,
                                    testIDPrefix: 'selected-line',
                                })}
                                <TextInput
                                    multiline
                                    value={draft.body}
                                    onChangeText={(body) => updateDraft(draft.id, (current) => ({ ...current, body }))}
                                    placeholder={t('files.reviewComments.placeholder')}
                                    placeholderTextColor={theme.colors.text.secondary}
                                    style={styles.commentInput}
                                    testID={`review-comment-draft-body:${draft.id}`}
                                />
                                {renderSnippetLines({
                                    draftId: draft.id,
                                    lines: draft.anchorResolution?.preview?.afterContext ?? draft.snapshot.afterContext,
                                    style: styles.snippetText,
                                    testIDPrefix: 'after-line',
                                })}
                            </View>
                        </View>
                    );
                })}
            </ScrollView>
            <View style={styles.footer}>
                <Pressable onPress={onClose} style={styles.doneButton} testID="review-comments-drafts-modal-done">
                    <Text style={styles.doneButtonText}>{t('common.done')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minHeight: 0,
        flex: 1,
    },
    summaryRow: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s16,
        paddingBottom: theme.space.s10,
    },
    summaryText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s16,
    },
    card: {
        gap: theme.space.s10,
        padding: theme.space.s12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    includeToggle: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
    includeToggleOn: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    includeToggleOff: {
        backgroundColor: theme.colors.surface.base,
        borderColor: theme.colors.border.default,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
    },
    filePathText: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
    },
    anchorText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('micro'),
    },
    snippet: {
        gap: 3,
        padding: theme.space.s10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
    },
    snippetText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.mono(),
    },
    snippetSelectedText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.mono(),
    },
    commentInput: {
        minHeight: 54,
        maxHeight: 140,
        padding: theme.space.s10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
        ...Typography.variant('body'),
    },
    jumpButton: {
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
        borderRadius: 8,
    },
    jumpButtonText: {
        color: theme.colors.text.link ?? theme.colors.text.primary,
        ...Typography.variant('meta', 'semiBold'),
    },
    footer: {
        padding: theme.space.s12,
        alignItems: 'flex-end',
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    doneButton: {
        paddingHorizontal: 14,
        paddingVertical: theme.space.s8,
        borderRadius: 8,
        backgroundColor: theme.colors.button.primary.background,
    },
    doneButtonText: {
        color: theme.colors.button.primary.tint,
        ...Typography.variant('body', 'semiBold'),
    },
}));
