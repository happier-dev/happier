import * as React from 'react';
import { Platform, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { Header } from '@/components/navigation/Header';
import { useScreenSafeAreaBackdrop } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { isNewSessionFloatingComposerPresentation } from '@/components/sessions/new/navigation/newSessionPresentation';
import { Text } from '@/components/ui/text/Text';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

function NativeGuidanceSurface() {
    const router = useRouter();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    useScreenSafeAreaBackdrop(theme.colors.surface.base);

    const close = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: '/' });
    }, [navigation, router]);
    const renderClose = React.useCallback(() => (
        <AppHeaderCloseButton testID="new-session-cancel" onPress={close} />
    ), [close]);

    // The transparent route normally delegates its backdrop and dismissal to the
    // composer. Blocking guidance replaces that composer and must own both too.
    return (
        <View style={styles.surface} accessibilityViewIsModal>
            <Header title={<Text style={styles.title}>{t('newSession.title')}</Text>} headerRight={renderClose} />
            <View style={[styles.content, { paddingBottom: insets.bottom }]}>
                <SessionGettingStartedGuidance variant="newSessionBlocking" />
            </View>
        </View>
    );
}

export function NewSessionBlockingGuidance() {
    const enhancedWizard = useSetting('useEnhancedSessionWizard');
    const isFloating = isNewSessionFloatingComposerPresentation({
        variant: enhancedWizard ? 'wizard' : 'simple',
        platformOs: Platform.OS,
    });
    return isFloating
        ? <NativeGuidanceSurface />
        : <SessionGettingStartedGuidance variant="newSessionBlocking" />;
}

const styles = StyleSheet.create((theme) => ({
    surface: { flex: 1, backgroundColor: theme.colors.surface.base },
    content: { flex: 1 },
    title: { ...Typography.header(), color: theme.colors.chrome.header.foreground },
}));
