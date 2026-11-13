import React from 'react';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useWindowDimensions } from 'react-native';

import { NewSessionServerSelectionContent } from '@/components/sessions/new/components/NewSessionServerSelectionContent';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { t } from '@/text';
import { buildNewSessionPickerFallbackHref } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { NewSessionPickerRouteScreen } from '@/components/sessions/new/navigation/NewSessionPickerRouteScreen';

export default React.memo(function ServerPickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams();
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const { height: windowHeight } = useWindowDimensions();
    const maxHeight = Math.min(760, Math.max(420, Math.floor(windowHeight * 0.88)));
    const close = React.useCallback(
        () => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref }),
        [navigation, pickerFallbackHref, router],
    );
    // K2 picker route chrome: the native title plus Cancel, and no second title band in the content.
    const headerLeft = React.useCallback(() => (
        <AppHeaderCloseButton testID="new-session-server-picker-cancel" appearance="text" onPress={close} />
    ), [close]);
    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        title: t('common.homeProductName'),
        headerTitle: t('common.homeProductName'),
        headerLeft,
    }), [headerLeft]);

    return (
        <NewSessionPickerRouteScreen options={screenOptions}>
            <NewSessionServerSelectionContent
                maxHeight={maxHeight}
                ownsScrollViewport={true}
                onClose={close}
            />
        </NewSessionPickerRouteScreen>
    );
});
