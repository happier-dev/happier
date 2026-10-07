import * as React from 'react';
import { Stack } from 'expo-router';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { t } from '@/text';

export default function DevRouteLayout(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <Stack>
        <Stack.Screen name="index" options={{ headerTitle: t('navigation.developerTools') }} />
        <Stack.Screen name="list-demo" options={{ headerTitle: t('navigation.listComponentsDemo') }} />
        <Stack.Screen name="typography" options={{ headerTitle: t('navigation.typography') }} />
        <Stack.Screen name="colors" options={{ headerTitle: t('navigation.colors') }} />
        <Stack.Screen name="tools2" options={{ headerTitle: t('navigation.toolViewsDemo') }} />
        <Stack.Screen name="shimmer-demo" options={{ headerTitle: t('navigation.shimmerViewDemo') }} />
        <Stack.Screen name="multi-text-input" options={{ headerTitle: t('navigation.multiTextInput') }} />
    </Stack>;
}
