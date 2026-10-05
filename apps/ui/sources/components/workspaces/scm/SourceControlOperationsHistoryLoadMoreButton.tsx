import * as React from 'react';
import { Pressable, View } from 'react-native';


import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

type SourceControlOperationsHistoryLoadMoreButtonProps = Readonly<{
    theme: any;
    historyLoading: boolean;
    onPress: () => void;
}>;

export const SourceControlOperationsHistoryLoadMoreButton = React.memo((props: SourceControlOperationsHistoryLoadMoreButtonProps) => {
    return (
        <Pressable
            disabled={props.historyLoading}
            testID="scm-commit-load-more"
            accessibilityRole="button"
            onPress={props.onPress}
            style={(state) => ({
                marginTop: 8,
                marginLeft: 74,
                paddingVertical: 10,
                paddingHorizontal: 12,
                alignSelf: 'flex-start',
                opacity: props.historyLoading ? 0.6 : state.pressed ? motionTokens.press.opacitySubtle : 1,
            })}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: props.theme.colors.text.secondary, fontSize: 12, ...Typography.default('medium') }}>
                    {props.historyLoading ? t('common.loading') : t('files.operationsHistory.loadMore')}
                </Text>
                <Icon name="caret-down" size={14} color={props.theme.colors.text.secondary} />
            </View>
        </Pressable>
    );
});
