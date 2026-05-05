import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type SourceControlUpdateTheme = Readonly<{
    colors: Readonly<{
        divider: string;
        text: string;
        textSecondary: string;
        textDestructive?: string;
        deleteAction?: string;
        warningCritical?: string;
        surface: string;
        surfaceHigh?: string;
        success?: string;
        button?: Readonly<{
            primary?: Readonly<{
                background?: string;
                tint?: string;
            }>;
        }>;
        input?: Readonly<{
            background?: string;
            border?: string;
            placeholder?: string;
        }>;
    }>;
}>;

export function SourceControlUpdateSection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    title: string;
    testID?: string;
    children: React.ReactNode;
}>) {
    return (
        <View
            testID={props.testID}
            style={{
                paddingHorizontal: 12,
                paddingTop: 12,
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: props.theme.colors.divider,
                gap: 10,
            }}
        >
            <Text
                style={{
                    fontSize: 12,
                    color: props.theme.colors.textSecondary,
                    ...Typography.default('semiBold'),
                }}
            >
                {props.title}
            </Text>
            {props.children}
        </View>
    );
}

export function SourceControlUpdateInput(props: Readonly<{
    theme: SourceControlUpdateTheme;
    testID: string;
    value: string;
    placeholder: string;
    accessibilityLabel: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
}>) {
    return (
        <TextInput
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            value={props.value}
            placeholder={props.placeholder}
            placeholderTextColor={props.theme.colors.textSecondary}
            editable={props.editable !== false}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
                minHeight: 34,
                borderWidth: 1,
                borderColor: props.theme.colors.input?.border ?? props.theme.colors.divider,
                backgroundColor: props.theme.colors.input?.background ?? props.theme.colors.surfaceHigh,
                color: props.theme.colors.text,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                fontSize: 12,
                opacity: props.editable === false ? 0.6 : 1,
            }}
            onChangeText={props.onChangeText}
        />
    );
}

export function SourceControlUpdateButton(props: Readonly<{
    theme: SourceControlUpdateTheme;
    label: string;
    testID: string;
    onPress: () => void;
    disabled?: boolean;
    kind?: 'primary' | 'secondary' | 'danger';
}>) {
    const kind = props.kind ?? 'secondary';
    const primaryBackground =
        props.theme.colors.button?.primary?.background
        ?? props.theme.colors.success
        ?? props.theme.colors.surfaceHigh
        ?? props.theme.colors.surface;
    const foreground =
        kind === 'primary'
            ? props.theme.colors.button?.primary?.tint ?? props.theme.colors.surface
            : kind === 'danger'
                ? props.theme.colors.textDestructive
                    ?? props.theme.colors.deleteAction
                    ?? props.theme.colors.warningCritical
                    ?? props.theme.colors.text
                : props.theme.colors.text;
    const background =
        kind === 'primary'
            ? primaryBackground
            : props.theme.colors.surfaceHigh ?? props.theme.colors.surface;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            disabled={props.disabled}
            onPress={props.onPress}
            hitSlop={8}
            style={({ pressed }) => ({
                minHeight: 34,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: props.theme.colors.divider,
                backgroundColor: background,
                paddingHorizontal: 10,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: props.disabled ? 0.45 : pressed ? 0.78 : 1,
            })}
        >
            <Text
                style={{
                    fontSize: 12,
                    color: foreground,
                    ...Typography.default('semiBold'),
                }}
            >
                {props.label}
            </Text>
        </Pressable>
    );
}
