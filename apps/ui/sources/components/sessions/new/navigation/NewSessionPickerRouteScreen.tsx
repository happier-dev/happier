import * as React from 'react';
import { Platform, View } from 'react-native';
import { Stack, useNavigation } from 'expo-router';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { StackOptionsHeader } from '@/components/navigation/Header';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { ContainedPageScopeProvider } from '@/components/ui/lists/listPresentation';
import { useSetting } from '@/sync/store/hooks';
import { resolveNewSessionPickerRoutePresentation } from './newSessionPresentation';

const styles = StyleSheet.create({
    // Expo Router's web drawer lays its screen in a row: the frame takes the card's (or sheet's) full width.
    frame: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        alignSelf: 'stretch',
    },
    headerContent: {
        maxWidth: '100%',
    },
    body: {
        flex: 1,
        minHeight: 0,
    },
});

/**
 * One New Session picker route. It declares the route's stack options and, where the host drops them,
 * draws them: Expo Router's web route drawer paints no navigator header and sizes its screen to content,
 * so on the web a modal picker draws its declared bar (title, Cancel, actions) itself and fills the card
 * or the phone sheet on the page surface. Native stacks and forced screens draw the header themselves.
 */
export function NewSessionPickerRouteScreen(props: Readonly<{
    options: NativeStackNavigationOptions;
    children: React.ReactNode;
}>): React.ReactElement {
    const mode = useSetting('newSessionPresentationModeV1');
    const drawsOwnChrome = Platform.OS === 'web'
        && resolveNewSessionPickerRoutePresentation({ mode, platformOs: 'web' }) === 'modal'
        && props.options.headerShown !== false;
    return (
        <>
            <Stack.Screen options={props.options} />
            {drawsOwnChrome
                ? <WebDrawerPickerFrame options={props.options}>{props.children}</WebDrawerPickerFrame>
                : props.children}
        </>
    );
}

function WebDrawerPickerFrame(props: Readonly<{
    options: NativeStackNavigationOptions;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const navigation = useNavigation();
    const goBack = React.useCallback(() => navigation.goBack(), [navigation]);
    // The navigator's defaults (tint, title style, no shadow) under the route's own options, as the stack merges them.
    const options = React.useMemo<NativeStackNavigationOptions>(() => ({
        ...createAppStackScreenOptions({ theme, headerBackTitle: '', shouldUseCustomHeader: true }),
        ...props.options,
    }), [props.options, theme]);
    const title = typeof options.title === 'string' ? options.title : '';
    return (
        // The drawer is a contained surface: its bar and page lists span the card, not the window's column (R-APP-7).
        <ContainedPageScopeProvider>
            <View
                testID="new-session-picker-route-frame"
                style={[styles.frame, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }]}
            >
                <StackOptionsHeader
                    options={options}
                    routeName={title}
                    // The drawer is presented over a page: going back dismisses it, as the drawer's own Escape does.
                    canGoBack
                    onBack={goBack}
                    contentStyle={styles.headerContent}
                />
                <View style={styles.body}>{props.children}</View>
            </View>
        </ContainedPageScopeProvider>
    );
}
