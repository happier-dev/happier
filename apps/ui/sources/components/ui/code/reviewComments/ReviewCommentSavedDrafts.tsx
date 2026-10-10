import * as React from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { useProfile } from '@/sync/domains/state/storage';
import { isReviewCommentDraftIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { t } from '@/text';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function ReviewCommentSavedDrafts(props: {
    drafts: readonly ReviewCommentDraft[];
    onEditDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft?: (commentId: string) => void;
    onUpdateDraft?: (draft: ReviewCommentDraft) => void;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}) {
    if (props.drafts.length === 0) return null;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            {props.drafts.map((draft) => (
                <ReviewCommentSavedDraftCard
                    key={draft.id}
                    draft={draft}
                    onEditDraft={props.onEditDraft}
                    onDeleteDraft={props.onDeleteDraft}
                    onUpdateDraft={props.onUpdateDraft}
                />
            ))}
        </View>
    );
}

function ReviewCommentSavedDraftCard(props: Readonly<{
    draft: ReviewCommentDraft;
    onEditDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft?: (commentId: string) => void;
    onUpdateDraft?: (draft: ReviewCommentDraft) => void;
}>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const profile = useProfile();
    const touchTargetFloor = resolveTouchTargetFloorPx();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const { draft } = props;
    const included = isReviewCommentDraftIncludedInPrompt(draft);
    const items: DropdownMenuItem[] = [
        { id: 'edit', title: t('common.edit'), testID: `review-comment-draft-edit:${draft.id}` },
        ...(props.onDeleteDraft ? [{ id: 'delete', title: t('common.delete'), destructive: true, testID: `review-comment-draft-delete:${draft.id}` }] : []),
    ];
    return (
        <View style={[styles.card, { backgroundColor: paintColor(theme.colors.surface.base) }]} testID={`review-comment-draft:${draft.id}`}>
            <View style={styles.header}>
                <Avatar id={profile.id} imageUrl={getAvatarUrl(profile)} thumbhash={profile.avatar?.thumbhash} size={18} />
                <Text style={styles.author}>{t('detailsSurface.review.draftAuthor')}</Text>
                <Text style={styles.meta}>{`· ${t('detailsSurface.review.draftStatus')}`}</Text>
                <View style={styles.grow} />
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={items}
                    matchTriggerWidth={false}
                    placement="bottom"
                    popoverAnchorAlign="end"
                    onSelect={(id) => {
                        if (id === 'edit') props.onEditDraft(draft);
                        if (id === 'delete') props.onDeleteDraft?.(draft.id);
                    }}
                    trigger={({ toggle }) => (
                        <IconButton
                            testID={`review-comment-draft-menu:${draft.id}`}
                            variant="plain"
                            iconName="dots-three"
                            minimumInteractiveTargetSize={touchTargetFloor ?? undefined}
                            interactiveTargetGapPx={6}
                            accessibilityLabel={t('common.moreActions')}
                            expanded={menuOpen}
                            hasPopup="menu"
                            onPress={toggle}
                        />
                    )}
                />
            </View>
            <MarkdownView markdown={draft.body} textStyle={styles.body} />
            {props.onUpdateDraft ? (
                <HappierPressable
                    testID={`review-comment-draft-include:${draft.id}`}
                    accessibilityRole="checkbox"
                    checked={included}
                    accessibilityLabel={t('detailsSurface.review.includeComment')}
                    onPress={() => props.onUpdateDraft?.({ ...draft, includeInPrompt: !included })}
                    style={(state) => [
                        styles.includeRow,
                        touchTargetFloor ? { minHeight: touchTargetFloor } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    <SelectionCheckGlyph state={included ? 'checked' : 'unchecked'} size="compact" />
                    <Text style={styles.meta}>{t('detailsSurface.review.includeComment')}</Text>
                </HappierPressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 6,
    },
    card: {
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    author: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.primary },
    meta: { ...Typography.default(), fontSize: 12, color: theme.colors.text.secondary, flexShrink: 1 },
    grow: { flex: 1 },
    body: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    includeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 28,
        borderWidth: 1,
        borderColor: 'transparent',
    },
}));
