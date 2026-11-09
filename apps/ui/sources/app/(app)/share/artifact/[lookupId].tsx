import * as React from 'react';
import { Platform } from 'react-native';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { ArtifactSignedInLinkScreen } from '@/components/sharing/documents/ArtifactSignedInLinkScreen';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { RootLayoutRedirectGate, WebServerOverrideGate } from '@/components/navigation/root/RootLayoutRedirectGate';

export function WorkspaceRouteBody() {
    const { lookupId, server } = useLocalSearchParams<{ lookupId?: string; server?: string }>();
    if (typeof lookupId !== 'string' || !lookupId) return <SurfaceStateCard kind="error" title={t('botTemplates.unavailable')} />;
    const screen = <ArtifactSignedInLinkScreen key={lookupId} lookupId={lookupId} />;
    // Web admits the Home above the shell. Native intents supply the same URL
    // through route params and reuse that admission before mounting the reader.
    return Platform.OS !== 'web' && typeof server === 'string' && server
        ? <WebServerOverrideGate key={`${lookupId}:${server}`} serverUrlOverride={server}>
            <RootLayoutRedirectGate>{screen}</RootLayoutRedirectGate>
        </WebServerOverrideGate>
        : screen;
}

export default function ArtifactSignedInLinkRoute() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
