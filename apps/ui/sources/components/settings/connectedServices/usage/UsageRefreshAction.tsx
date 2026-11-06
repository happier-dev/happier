import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { t } from '@/text';

/**
 * A usage section's header action: when its figures were read ("As of 14:02") and Refresh. Every usage
 * section (a Connected Account's and a Provider connection's) uses this one so they read the same.
 */
export const UsageRefreshAction = React.memo(function UsageRefreshAction(props: Readonly<{
    testID: string;
    fetchedAt: number | null;
    refresh: (() => void) | null;
    refreshing: boolean;
}>) {
    if (props.fetchedAt === null && !props.refresh) return null;
    return (
        <View style={stylesheet.row}>
            {props.fetchedAt !== null ? <SurfaceAsOfLabel at={props.fetchedAt} testID={`${props.testID}:as-of`} /> : null}
            {props.refresh ? <RoundButton
                testID={`${props.testID}:refresh`}
                size="small"
                display="inverted"
                title={t('common.refresh')}
                leading={<Icon name="arrow-clockwise" size={14} />}
                loading={props.refreshing}
                disabled={props.refreshing}
                onPress={props.refresh}
            /> : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
}));
