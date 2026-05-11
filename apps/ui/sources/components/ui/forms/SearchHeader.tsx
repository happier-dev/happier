import * as React from 'react';
import { View, Platform, Pressable, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { TextInput } from '@/components/ui/text/Text';


export interface SearchHeaderProps {
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
    },
    textInput: {
        flex: 1,
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        paddingVertical: 0,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
    clearIcon: {
        marginLeft: 8,
    },
}));

export function SearchHeader({
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
    const maxWidth = useLayoutMaxWidth();
    const styles = stylesheet;

    return (
        <View style={[styles.container, containerStyle]}>
            <View style={[styles.content, { maxWidth }]}>
                <View style={styles.inputWrapper}>
                    {normalizeNodeForView(
                        <Ionicons
                            name="search-outline"
                            size={20}
                            color={theme.colors.text.secondary}
                            style={{ marginRight: 8 }}
                        />,
                    )}
                    <TextInput
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
                                <Ionicons
                                    name="close-circle"
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
