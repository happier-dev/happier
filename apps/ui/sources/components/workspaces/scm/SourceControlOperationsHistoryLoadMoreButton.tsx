import * as React from 'react';
import { Pressable, View } from 'react-native';


import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type SourceControlOperationsHistoryLoadMoreButtonProps = Readonly<{
    theme: any;
    historyLoading: boolean;
    onPress: () => void;
}>;

export const SourceControlOperationsHistoryLoadMoreButton = React.memo((props: SourceControlOperationsHistoryLoadMoreButtonProps) => {
    const backgroundColor = props.theme.colors.surface.inset ?? props.theme.colors.input.background;

    return (
        <Pressable
            disabled={props.historyLoading}
            testID="scm-commit-load-more"
            onPress={props.onPress}
            style={(state) => ({
                marginTop: 8,
                marginLeft: 40,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: props.theme.colors.border.default,
                backgroundColor,
                opacity: props.historyLoading ? 0.6 : state.pressed ? 0.85 : 1,
            })}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: props.theme.colors.text.link, fontSize: 12, ...Typography.default('semiBold') }}>
                    {props.historyLoading ? t('common.loading') : t('files.operationsHistory.loadMore')}
                </Text>
                <Icon name="caret-down" size={14} color={props.theme.colors.text.secondary} />
            </View>
        </Pressable>
    );
});
