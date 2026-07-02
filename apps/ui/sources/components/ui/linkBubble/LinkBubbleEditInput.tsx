import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

type LinkBubbleEditInputProps = Readonly<{
    initialHref: string;
    onSave: (href: string) => void;
    onCancel: () => void;
    testID?: string;
}>;

/**
 * Inline URL editor for the LinkBubble's "edit" state.
 *
 * Shows a TextInput pre-filled with the current href and Cancel/Save buttons.
 * All labels use `t(...)` for i18n. Theme tokens for all colors.
 */
export const LinkBubbleEditInput = React.memo(function LinkBubbleEditInput(
    props: LinkBubbleEditInputProps,
) {
    const { initialHref, onSave, onCancel, testID } = props;
    const { theme } = useUnistyles();
    const [value, setValue] = React.useState(initialHref);

    const handleSave = React.useCallback(() => {
        onSave(value.trim());
    }, [onSave, value]);

    return (
        <View style={styles.container} testID={testID}>
            <TextInput
                testID={testID ? `${testID}:input` : undefined}
                value={value}
                onChangeText={setValue}
                placeholder={t('markdown.linkBubble.inputPlaceholder')}
                placeholderTextColor={theme.colors.text.tertiary}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { color: theme.colors.text.primary, borderColor: theme.colors.border.default, backgroundColor: theme.colors.surface.inset }]}
            />
            <View style={styles.buttonRow}>
                <Pressable
                    testID={testID ? `${testID}:cancel` : undefined}
                    onPress={onCancel}
                    style={styles.button}
                    accessibilityRole="button"
                    accessibilityLabel={t('markdown.linkBubble.cancel')}
                >
                    <Text style={[styles.buttonText, { color: theme.colors.text.secondary }]}>
                        {t('markdown.linkBubble.cancel')}
                    </Text>
                </Pressable>
                <Pressable
                    testID={testID ? `${testID}:save` : undefined}
                    onPress={handleSave}
                    style={[styles.button, { backgroundColor: theme.colors.state.active.background }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('markdown.linkBubble.save')}
                >
                    <Text style={[styles.buttonText, { color: theme.colors.state.active.foreground }]}>
                        {t('markdown.linkBubble.save')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        padding: 8,
        gap: 6,
    },
    input: {
        fontSize: 13,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    buttonRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 6,
    },
    button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 4,
    },
    buttonText: {
        fontSize: 12,
    },
});
