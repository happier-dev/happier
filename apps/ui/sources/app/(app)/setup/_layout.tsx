import * as React from 'react';
import { Stack } from 'expo-router';

const setupIndexScreenOptions = { headerShown: false } as const;
const setupWizardScreenOptions = { headerShown: false } as const;

export default function SetupLayout() {
    return (
        <Stack>
            <Stack.Screen
                name="index"
                options={setupIndexScreenOptions}
            />
            <Stack.Screen
                name="wizard"
                options={setupWizardScreenOptions}
            />
        </Stack>
    );
}
