import * as React from 'react';
import { Slot, Stack } from 'expo-router';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { getSettingsStackScreenDefinitions, type SettingsNestedNavigator } from './settingsRouteRegistry';
import { t } from '@/text';
import { NavigatorSafeAreaBleed } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { renderAppStackScreen } from '@/components/navigation/appStackScreenLayout';

/** Keep Expo's route state/serialization without mounting the hosted layout's domain owners twice. */
export function createSettingsLayoutRoute(Body: React.ComponentType, navigator?: SettingsNestedNavigator | 'prompts') {
    function SettingsLayoutUrlMirror() {
        // Prompts is a Slot layout; its child collections each retain their own navigator.
        if (navigator === 'prompts') return <Slot />;
        const screens = getSettingsStackScreenDefinitions(t, { navigator, isModalPresentation: true });
        return <NavigatorSafeAreaBleed><Stack screenOptions={{ headerShown: false }} screenLayout={renderAppStackScreen}>
            {screens.map(screen => <Stack.Screen key={screen.name} name={screen.name} options={screen.options} />)}
        </Stack></NavigatorSafeAreaBleed>;
    }
    return React.memo(function SettingsLayoutRouteEntry() {
        return <WorkspaceRouteEntry Body={Body} mirror={<SettingsLayoutUrlMirror />} />;
    });
}
