import * as React from 'react';
import { Pressable, type StyleProp, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function ReviewCommentSavedDrafts(props: {
    drafts: readonly ReviewCommentDraft[];
    onEditDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft?: (commentId: string) => void;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();

    if (props.drafts.length === 0) return null;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            {props.drafts.map((draft) => (
                <View
                    key={draft.id}
                    style={[
                        styles.card,
                        {
                            borderColor: theme.colors.border.default,
                            backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
                        },
                    ]}
                >
                    <Text
                        style={[
                            styles.body,
                            { color: theme.colors.text.primary },
                        ]}
                    >
                        {draft.body}
                    </Text>
                    <View style={styles.actions}>
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => props.onEditDraft(draft)}
                            testID={`review-comment-draft-edit:${draft.id}`}
                        >
                            <Text style={[styles.actionText, { color: theme.colors.text.secondary }]}>
                                {t('common.edit')}
                            </Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => props.onDeleteDraft?.(draft.id)}
                            testID={`review-comment-draft-delete:${draft.id}`}
                        >
                            <Text
                                style={[
                                    styles.actionText,
                                    { color: theme.colors.state.danger.foreground ?? theme.colors.text.secondary },
                                ]}
                            >
                                {t('common.delete')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        gap: 6,
    },
    card: {
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
    },
    body: {
        ...Typography.default(),
        fontSize: 13,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        marginTop: 6,
        gap: 10,
    },
    actionText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
    },
}));
