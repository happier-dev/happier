import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type ScmChangesSelectionHeaderRowProps = Readonly<{
    theme: any;
    selectedCount: number;
    totalCount: number;
    onSelectAll?: () => void;
    onSelectNone?: () => void;
    disableSelectAll?: boolean;
    disableSelectNone?: boolean;
}>;

export const ScmChangesSelectionHeaderRow = React.memo((props: ScmChangesSelectionHeaderRowProps) => {
    const canSelectAll = Boolean(props.onSelectAll) && !props.disableSelectAll;
    const canSelectNone = Boolean(props.onSelectNone) && !props.disableSelectNone;

    const Action = (p: {
        label: string;
        disabled: boolean;
        onPress?: () => void;
    }) => (
        <Pressable
            accessibilityRole="button"
            disabled={p.disabled}
            onPress={p.onPress}
            style={({ pressed }) => ({
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: props.theme.colors.border.default,
                backgroundColor: props.theme.colors.surface.inset,
                opacity: p.disabled ? 0.45 : pressed ? 0.78 : 1,
            })}
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text.link, ...Typography.default('semiBold') }}>
                {p.label}
            </Text>
        </Pressable>
    );

    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 8,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: props.theme.colors.border.default,
                backgroundColor: props.theme.colors.surface.inset,
            }}
        >
            <View style={{ flex: 1 }}>
                {props.selectedCount > 0 ? (
                    <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                        {t('files.sourceControlOperations.selection', { count: props.selectedCount })}
                    </Text>
                ) : null}
                <Text style={{ marginTop: props.selectedCount > 0 ? 2 : 0, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {t('files.repositoryChangedFiles', { count: props.totalCount })}
                </Text>
            </View>

            {(props.onSelectAll || props.onSelectNone) ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    {props.onSelectAll ? (
                        <Action label={t('common.all')} disabled={!canSelectAll} onPress={props.onSelectAll} />
                    ) : null}
                    {props.onSelectNone ? (
                        <Action label={t('files.sourceControlOperations.clear')} disabled={!canSelectNone} onPress={props.onSelectNone} />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});
