import * as React from 'react';

import { DetailsStartSheetHost } from '@/components/appShell/panes/panePresentation';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { ToolDetailsPageHeader } from '@/components/tools/shell/presentation/ToolDetailsPageHeader';
import { DEMO_SUBAGENTS_SESSION_ID } from '@/demoMode/world/featureSessions';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useMessage, useResolvedSessionMessageRouteId, useSession } from '@/sync/domains/state/storage';

import type { StageDevice } from '../DeviceFrame';
import { StageAppShell } from '../StageAppShell';

/** The existing tool-message detail conversation, including its real worker recipient picker. */
export function DelegatedToolDetailStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement | null {
    const session = useSession(DEMO_SUBAGENTS_SESSION_ID);
    const messageId = useResolvedSessionMessageRouteId(DEMO_SUBAGENTS_SESSION_ID, 'tool:demo-auth-codex-delegate');
    const message = useMessage(DEMO_SUBAGENTS_SESSION_ID, messageId ?? 'tool:demo-auth-codex-delegate');
    if (!session || message?.kind !== 'tool-call') return null;

    return <StageAppShell device={props.device} surface="session-view" detail={
        <DetailsStartSheetHost>
            <SessionMessageDetailsView
                sessionId={session.id}
                session={session}
                message={message}
                header={<ToolDetailsPageHeader tool={message.tool} metadata={readSessionOwnerMetadataView(session)} />}
            />
        </DetailsStartSheetHost>
    } />;
}
