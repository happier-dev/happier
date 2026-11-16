import * as React from 'react';
import { Stack } from 'expo-router';

import { Home } from '@/app/(app)/index';
import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { VoiceSurfaceFixtureHost } from '@/dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition';

function VoiceSurfaceFixtureScreen() {
    if (!isDevRouteEnabled()) return null;
    return <>
        <Stack.Screen options={{ headerShown: false }} />
        <VoiceSurfaceFixtureHost />
        <Home />
    </>;
}

export default function VoiceSurfaceFixtureRoute() {
    return <WorkspaceRouteEntry Body={VoiceSurfaceFixtureScreen} />;
}
