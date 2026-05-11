import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type SourceControlRemoteAction = Readonly<{
    key: 'fetch' | 'pull' | 'push' | 'publish';
    iconName: 'sync' | 'arrow-down' | 'arrow-up' | 'upload';
    label: string;
    disabled: boolean;
    onPress: () => void;
    testID?: string;
}>;

export type SourceControlRemoteActionsRailProps = Readonly<{
    theme: any;
    actions: readonly SourceControlRemoteAction[];
    hint?: string | null;
}>;

export const SourceControlRemoteActionsRail = React.memo((props: SourceControlRemoteActionsRailProps) => {
    if (props.actions.length === 0) return null;

    const IconButton = (p: SourceControlRemoteAction) => (
        <Pressable
            key={p.key}
            testID={p.testID}
            accessibilityRole="button"
            accessibilityLabel={p.label}
            disabled={p.disabled}
            onPress={p.onPress}
            hitSlop={10}
            style={({ pressed }) => ({
                width: 34,
                height: 34,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: props.theme.colors.border.default,
                backgroundColor: props.theme.colors.surface.inset,
                opacity: p.disabled ? 0.45 : pressed ? 0.78 : 1,
            })}
        >
            <Octicons name={p.iconName} size={16} color={props.theme.colors.text.secondary} />
        </Pressable>
    );

    return (
        <View
            style={{
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 10,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: props.theme.colors.border.default,
                backgroundColor: props.theme.colors.surface.base,
                gap: 8,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                    {t('files.sourceControlOperations.title')}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {props.actions.map(IconButton)}
                </View>
            </View>
            {props.hint ? (
                <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.hint}
                </Text>
            ) : null}
        </View>
    );
});
