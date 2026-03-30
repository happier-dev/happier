import * as React from 'react';
import { Stack } from 'expo-router';

import { t } from '@/text';

export default function SetupLayout() {
    return (
        <Stack>
            <Stack.Screen
                name="index"
                options={{
                    title: t('setupOnboarding.screenTitle'),
                }}
            />
        </Stack>
    );
}
