import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { t } from '@/text';

/**
 * The route chrome of a Machine picker route (K2): the title with Refresh, plus Cancel, nothing else
 * above the list. Every route that picks a Machine takes it, so they read as one surface.
 */
export function useMachinePickerRouteOptions(params: Readonly<{
    title: string;
    cancelTestID: string;
    onBack: () => void;
    onRefresh: () => void;
    isRefreshing: boolean;
}>) {
    const { theme } = useUnistyles();
    const { title, cancelTestID, onBack, onRefresh, isRefreshing } = params;
    const headerLeft = React.useCallback(() => (
        <AppHeaderCloseButton testID={cancelTestID} appearance="text" onPress={onBack} />
    ), [cancelTestID, onBack]);
    const foreground = theme.colors.chrome.header.foreground;
    const secondary = theme.colors.text.secondary;
    const headerTitle = React.useCallback(({ tintColor }: { children: string; tintColor?: string }) => (
        <HeaderTitleWithAction
            title={title}
            tintColor={tintColor ?? foreground}
            actionLabel={t('common.refresh')}
            actionIconName="arrow-clockwise"
            actionColor={secondary}
            actionDisabled={isRefreshing}
            actionLoading={isRefreshing}
            onActionPress={onRefresh}
        />
    ), [foreground, isRefreshing, onRefresh, secondary, title]);
    return React.useMemo(() => ({
        headerShown: true,
        title,
        headerTitle,
        headerBackTitle: t('common.back'),
        headerLeft,
    }), [headerLeft, headerTitle, title]);
}
