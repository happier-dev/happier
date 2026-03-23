import React from 'react';
import { Stack, useRouter, useNavigation } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';

import { NewSessionServerSelectionContent } from '@/components/sessions/new/components/NewSessionServerSelectionContent';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

const serverPickerScreenOptions = {
    headerShown: false,
    presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
};

export default React.memo(function ServerPickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const { height: windowHeight } = useWindowDimensions();
    const maxHeight = Math.min(760, Math.max(420, Math.floor(windowHeight * 0.88)));

    return (
        <>
            <Stack.Screen options={serverPickerScreenOptions} />
            <NewSessionServerSelectionContent
                maxHeight={maxHeight}
                onClose={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
            />
        </>
    );
});
