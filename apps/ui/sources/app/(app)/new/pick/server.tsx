import React from 'react';
import { Stack, useRouter, useNavigation } from 'expo-router';
import { useWindowDimensions } from 'react-native';

import { NewSessionServerSelectionContent } from '@/components/sessions/new/components/NewSessionServerSelectionContent';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';

export default React.memo(function ServerPickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const { height: windowHeight } = useWindowDimensions();
    const maxHeight = Math.min(760, Math.max(420, Math.floor(windowHeight * 0.88)));
    const presentation = useNewSessionPickerRoutePresentation();
    const screenOptions = React.useMemo(() => ({
        headerShown: false,
        presentation,
    }), [presentation]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <NewSessionServerSelectionContent
                maxHeight={maxHeight}
                onClose={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
            />
        </>
    );
});
