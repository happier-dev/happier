import React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { ReviewCommentDraftFrame, reviewCommentDraftText } from './ReviewCommentDraftFrame';

/**
 * A draft comment being written: the saved card's own frame (author line, edge, radius) with the text
 * as a field and one compact action line under it. Delete (an existing draft) leads; Cancel and Save
 * end the line, Save the one filled action.
 */
export function ReviewCommentInlineComposer(props: {
    value: string;
    onChange: (next: string) => void;
    onSave: () => void;
    onCancel: () => void;
    onDelete?: () => void;
    /** Take the keyboard on open: a host whose Comment came from a toolbar, not a typed line. */
    autoFocus?: boolean;
}) {
    const { theme } = useUnistyles();

    return (
        <ReviewCommentDraftFrame>
            <TextInput
                value={props.value}
                onChangeText={props.onChange}
                placeholder={t('files.reviewComments.placeholder')}
                placeholderTextColor={theme.colors.text.secondary}
                multiline
                autoFocus={props.autoFocus}
                style={[reviewCommentDraftText.body, styles.input]}
            />
            <View style={styles.actions}>
                {props.onDelete ? (
                    <RoundButton testID="review-comment-composer-delete" size="small" display="destructive" title={t('common.delete')} accessibilityLabel={t('common.delete')} onPress={props.onDelete} />
                ) : null}
                <View style={styles.grow} />
                <RoundButton testID="review-comment-composer-cancel" size="small" display="secondary" title={t('common.cancel')} accessibilityLabel={t('common.cancel')} onPress={props.onCancel} />
                <RoundButton testID="review-comment-composer-save" size="small" title={t('common.save')} accessibilityLabel={t('common.save')} onPress={props.onSave} />
            </View>
        </ReviewCommentDraftFrame>
    );
}

const styles = StyleSheet.create((theme) => ({

    // Two lines of the comment's own text before it grows; a long comment scrolls inside the card.
    input: {
        minHeight: 36,
        maxHeight: 160,
        padding: 0,
        ...(Platform.select({
            web: {
                outlineStyle: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingTop: theme.space.s2,
    },
    grow: { flex: 1 },
}));
