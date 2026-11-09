import * as React from 'react';
import { View } from 'react-native';
import { NavigationContainer, NavigationIndependentTree } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaInsetsContext, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { Typography } from '@/constants/Typography';
import type { StageSurfaceId } from './stageSurfaces';

// Titles of the real pushed destinations, absent when a surface owns its navigation band.
const PHONE_ROUTE_TITLES: Partial<Record<StageSurfaceId, string>> = {
    deployments: 'Deployments', 'workflow-run': 'Workflow run',
    providers: 'Providers', skills: 'Library', store: 'Store',
    'session-share': 'Session access', accounts: 'Connected accounts', team: 'Team',
    'store-listing': 'Skill', 'store-install-result': 'Skill',
    'machine-share': 'Machine access', 'team-credential-usage': 'Credential usage',
    computer: 'Computer', 'delegated-tool-detail': 'Delegate Agent', review: 'Review',
};
const Stack = createNativeStackNavigator();
const CONTAINMENT = { flex: 1, minHeight: 0, minWidth: 0 } as const;
const BOTTOM_EDGE = { top: 'off', bottom: 'additive', left: 'off', right: 'off' } as const;
const TOP_BOTTOM_EDGES = { ...BOTTOM_EDGE, top: 'additive' } as const;
function PreviousRoute(): null { return null; }

/** Dev-only composition of the app's pushed navigation host; no device chrome is drawn here. */
export function StagePhoneNavigationHost(props: Readonly<{
    surface: StageSurfaceId;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const title = PHONE_ROUTE_TITLES[props.surface];
    // The Bot editor is a More destination: its real page already owns Back and title.
    const ownsPageHeader = props.surface === 'bots';
    const bodyInsets = React.useMemo(() => ({ ...insets, top: title || ownsPageHeader ? 0 : insets.top, bottom: 0 }), [insets, title, ownsPageHeader]);
    const backgroundColor = theme.colors.surface.base;
    return <View testID="demo-stage-phone-navigation-host" style={[CONTAINMENT, { backgroundColor }]}>
        <NavigationIndependentTree>
            <NavigationContainer initialState={{ index: 1, routes: [{ name: 'previous' }, { name: 'capture' }] }}>
                <Stack.Navigator screenOptions={{
                    ...createAppStackScreenOptions({ theme, headerBackTitle: '', shouldUseCustomHeader: false }),
                    headerShown: Boolean(title), animation: 'none',
                    headerStyle: { backgroundColor }, contentStyle: { backgroundColor },
                    headerTitleAlign: 'center', headerTitleStyle: Typography.variant('heading'),
                    // Native-stack's web fallback uses a desktop arrow. Render the same canonical
                    // glyph that the app's DefaultBackButton selects on iOS for this iPhone specimen.
                    headerLeft: () => <HappierPressable accessibilityRole="button" accessibilityLabel="Back" testID="demo-stage-phone-back">
                        <Icon name="caret-left" size={24} color={theme.colors.chrome.header.foreground} />
                    </HappierPressable>,
                }}>
                    <Stack.Screen name="previous" component={PreviousRoute} />
                    <Stack.Screen name="capture" options={{ title }}>
                        {() => <SafeAreaView edges={ownsPageHeader ? TOP_BOTTOM_EDGES : BOTTOM_EDGE} style={CONTAINMENT}>
                            <SafeAreaInsetsContext.Provider value={bodyInsets}>{props.children}</SafeAreaInsetsContext.Provider>
                        </SafeAreaView>}
                    </Stack.Screen>
                </Stack.Navigator>
            </NavigationContainer>
        </NavigationIndependentTree>
    </View>;
}
