import * as React from 'react';
import { View, Platform, Pressable, StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { TextInput } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';


export interface SearchHeaderProps {
    testID?: string;
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    containerStyle?: StyleProp<ViewStyle>;
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
    inputRef?: React.Ref<React.ElementRef<typeof TextInput>>;
    onFocus?: () => void;
    onBlur?: () => void;
}

const INPUT_BORDER_RADIUS = 10;
const SEARCH_HEADER_PADDING_BOTTOM = 12;

/**
 * The search field is a touch target, so it carries the platform minimum from
 * the canonical owner rather than whatever its padding and line height happen to
 * add up to. Padding alone left it at roughly 38pt on iOS and 40dp on Android,
 * under the 44/48 the accessibility contract requires. This is a floor, not a
 * fixed height: larger text still grows the field.
 */
const SEARCH_INPUT_MIN_HEIGHT = resolveMinimumInteractiveTargetSize(Platform.OS);

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface.base,
        paddingTop: 0,
        paddingBottom: SEARCH_HEADER_PADDING_BOTTOM,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    content: {
        width: '100%',
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        alignSelf: 'center',
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderRadius: INPUT_BORDER_RADIUS,
        paddingHorizontal: 12,
        paddingVertical: 8,
        minHeight: SEARCH_INPUT_MIN_HEIGHT,
    },
    textInput: {
        flex: 1,
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        paddingVertical: 0,
    },
    clearIcon: {
        marginLeft: 8,
    },
}));

export function SearchHeader({
    testID,
    value,
    onChangeText,
    placeholder,
    containerStyle,
    autoCapitalize = 'none',
    autoCorrect = false,
    inputRef,
    onFocus,
    onBlur,
}: SearchHeaderProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const maxWidth = useLayoutMaxWidth();
    const styles = stylesheet;

    return (
        <View testID={testID} style={[styles.container, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }, containerStyle]}>
            <View style={[styles.content, { maxWidth }]}>
                <View style={[styles.inputWrapper, { backgroundColor: paintColor(theme.colors.input.background) }]}>
                    {normalizeNodeForView(
                        <Icon
                            name="magnifying-glass"
                            size={20}
                            color={theme.colors.text.secondary}
                            style={{ marginRight: 8 }}
                        />,
                    )}
                    <TextInput
                        testID={testID ? `${testID}:input` : undefined}
                        ref={inputRef}
                        value={value}
                        onChangeText={onChangeText}
                        placeholder={placeholder}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize={autoCapitalize}
                        autoCorrect={autoCorrect}
                        onFocus={onFocus}
                        onBlur={onBlur}
                        style={styles.textInput}
                    />
                    {value.length > 0 && (
                        <Pressable
                            onPress={() => onChangeText('')}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.clearSearch')}
                        >
                            {normalizeNodeForView(
                                <Icon
                                    name="x-circle"
                                    size={20}
                                    color={theme.colors.text.secondary}
                                    style={styles.clearIcon}
                                />,
                            )}
                        </Pressable>
                    )}
                </View>
            </View>
        </View>
    );
}
