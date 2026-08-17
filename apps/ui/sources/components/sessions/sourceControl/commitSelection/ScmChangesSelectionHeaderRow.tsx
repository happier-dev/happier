import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';

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
        <ToolbarButton
            label={p.label}
            disabled={p.disabled}
            onPress={p.onPress}
            labelColor={props.theme.colors.text.link}
        />
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
