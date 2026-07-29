import * as React from 'react';
import { Stack } from 'expo-router';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';

export default function DevRouteLayout(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <Stack />;
}
