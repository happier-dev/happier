import { Stack } from 'expo-router';
import * as React from 'react';

import { TabBarSpecimen } from '@/components/dev/TabBarSpecimen';

/** Dev-only: the shared tab bar in every presentation, fitting with More at full and narrow widths. */
export default function TabBarDevScreen() {
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <TabBarSpecimen />
        </>
    );
}
