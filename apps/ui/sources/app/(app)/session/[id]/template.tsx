import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { BotTemplateEditor } from '@/components/sessions/bots/templates/BotTemplateEditor';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export function WorkspaceRouteBody() {
    const { artifactId, serverId } = useLocalSearchParams<{ artifactId?: string; serverId?: string }>();
    return artifactId && serverId ? <BotTemplateEditor artifactId={artifactId} serverId={serverId} presentation="page" />
        : <SurfaceStateCard testID="bot-template-invalid-route" kind="error" title={t('botTemplates.unavailable')} />;
}

export default function BotTemplateEditorRoute() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
