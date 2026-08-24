import React from 'react';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useUnistyles } from 'react-native-unistyles';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildNewSessionPickerFallbackHref, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { Icon } from '@/components/ui/icons/Icon';

export default React.memo(function SecretPickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string; draftId?: string }>();
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';

    const [secrets, setSecrets] = useSettingMutable('secrets');

    const setSecretParamAndClose = React.useCallback((secretId: string) => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: { secretId },
            currentParams: { draftId: params.draftId },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [navigation, params.draftId, pickerFallbackHref, router]);

    const handleBackPress = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [navigation, pickerFallbackHref, router]);

    const headerTitle = t('settings.secrets');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleBackPress}
                hitSlop={10}
                style={({ pressed }) => ({ marginLeft: 10, padding: 4, opacity: pressed ? 0.7 : 1 })}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
            >
                <Icon name="caret-left" size={20} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [handleBackPress, theme.colors.chrome.header.foreground]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
            // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
            // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
            presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
            headerLeft,
        } as const;
    }, [headerBackTitle, headerLeft, headerTitle]);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />

            <SecretsList
                secrets={secrets}
                onChangeSecrets={setSecrets}
                selectedId={selectedId}
                onSelectId={setSecretParamAndClose}
                includeNoneRow
                allowAdd
                allowEdit
                onAfterAddSelectId={setSecretParamAndClose}
            />
        </>
    );
});
