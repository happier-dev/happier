import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

import type { PluginReadOnlySnapshotReason } from './model/pluginMarketplaceModel';

function resolveNoticeSubtitle(reason: PluginReadOnlySnapshotReason): string {
    if (reason === 'projectionUnavailable') {
        return t('settingsPlugins.readOnlyProjectionUnavailable');
    }
    if (reason === 'accountRecovery') {
        return t('settingsPlugins.readOnlyAccountRecovery');
    }
    return t('settingsPlugins.readOnlySnapshot');
}

export const PluginReadOnlySnapshotNotice = React.memo(function PluginReadOnlySnapshotNotice(props: Readonly<{
    testID: string;
    reason: PluginReadOnlySnapshotReason;
    onRetry?: () => void;
}>) {
    const { theme } = useUnistyles();
    const subtitle = resolveNoticeSubtitle(props.reason);
    // Only a reachable machine projection can be retried; Account recovery has no machine action.
    const onRetry = props.reason === 'projectionUnavailable' ? props.onRetry : undefined;

    return (
        <View
            testID={props.testID}
            accessible={!onRetry}
            accessibilityLiveRegion="polite"
            {...(onRetry ? {} : { accessibilityLabel: subtitle })}
        >
            <Item
                testID={onRetry ? `${props.testID}-retry` : undefined}
                title={t('common.unavailable')}
                subtitle={subtitle}
                icon={<Icon name="cloud-slash" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
                mode={onRetry ? 'interactive' : 'info'}
                {...(onRetry ? { detail: t('common.retry'), onPress: onRetry, accessibilityLabel: `${subtitle} ${t('common.retry')}` } : {})}
            />
        </View>
    );
});
