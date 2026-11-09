import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { LocalServicePreviewLanding } from '@/components/sessions/localServices/LocalServicePreviewLanding';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** The link a people share of one running Service hands out (`/preview-link/:exposureId`). */
export function WorkspaceRouteBody() {
    const { exposureId } = useLocalSearchParams<{ exposureId?: string }>();
    if (typeof exposureId !== 'string' || !exposureId) {
        return <SurfaceStateCard kind="unavailable" title={t('localServices.publicPreview.landing.title')}
            reason={t('localServices.publicPreview.landing.ended')} />;
    }
    return <LocalServicePreviewLanding key={exposureId} exposureId={exposureId} />;
}

export default function LocalServicePreviewLinkRoute() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
