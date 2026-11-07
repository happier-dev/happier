import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { BotTemplateRecipientScreen } from '@/components/sessions/bots/templates/BotTemplateRecipientScreen';
import { readBotTemplateRecipientRoute } from '@/components/sessions/bots/templates/botTemplateRecipientDestination';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export function WorkspaceRouteBody() {
    const params = useLocalSearchParams<{ source?: string; serverId?: string; sessionRef?: string }>();
    const destination = readBotTemplateRecipientRoute(params);
    return destination ? <BotTemplateRecipientScreen {...destination} />
        : <SurfaceStateCard kind="error" title={t('botTemplates.unavailable')} />;
}

export default function BotTemplateRecipientRoute() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
