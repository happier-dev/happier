import * as React from 'react';
import { Stack } from 'expo-router';
import { NavigatorSafeAreaBleed } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { renderAppStackScreen } from '@/components/navigation/appStackScreenLayout';

const setupIndexScreenOptions = { headerShown: false } as const;
const setupWizardScreenOptions = { headerShown: false } as const;

export default function SetupLayout() {
    return (
        <NavigatorSafeAreaBleed><Stack screenLayout={renderAppStackScreen}>
            <Stack.Screen
                name="index"
                options={setupIndexScreenOptions}
            />
            <Stack.Screen
                name="wizard"
                options={setupWizardScreenOptions}
            />
        </Stack></NavigatorSafeAreaBleed>
    );
}
