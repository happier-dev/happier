import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type ScmCommitSelectionSummaryRowProps = Readonly<{
    theme: any;
    count: number;
    onClear?: () => void;
    density?: 'comfortable' | 'compact';
}>;

export const ScmCommitSelectionSummaryRow = React.memo((props: ScmCommitSelectionSummaryRowProps) => {
    const density = props.density ?? 'comfortable';
    if (props.count <= 0) return null;

    const padX = density === 'compact' ? 12 : 16;
    const padY = density === 'compact' ? 10 : 10;

    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: density === 'compact' ? 0 : 10,
                paddingHorizontal: padX,
                paddingVertical: padY,
                borderBottomWidth: density === 'compact' ? Platform.select({ ios: 0.33, default: 1 }) : 0,
                borderBottomColor: props.theme.colors.border.default,
                borderRadius: density === 'compact' ? 0 : 12,
                borderWidth: density === 'compact' ? 0 : 1,
                borderColor: props.theme.colors.border.default,
                backgroundColor: density === 'compact'
                    ? props.theme.colors.surface.base
                    : (props.theme.colors.surface.inset ?? props.theme.colors.input.background),
            }}
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                {t('files.sourceControlOperations.selection', { count: props.count })}
            </Text>
            {props.onClear ? (
                <Pressable onPress={props.onClear} accessibilityRole="button">
                    <Text style={{ fontSize: 12, color: props.theme.colors.text.link, ...Typography.default('semiBold') }}>
                        {t('files.sourceControlOperations.clear')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});
