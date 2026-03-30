import * as React from 'react';
import { Stack } from 'expo-router';

import { t } from '@/text';

export default function SetupLayout() {
    return (
        <Stack>
            <Stack.Screen
                name="index"
                options={{
                    headerShown: false,
                    title: t('setupOnboarding.screenTitle'),
                }}
            />
            <Stack.Screen
                name="wizard"
                options={{
                    headerShown: false,
                }}
            />
        </Stack>
    );
}
