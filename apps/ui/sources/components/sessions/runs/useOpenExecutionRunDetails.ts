import * as React from 'react';

import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';

/** Collection rows retain the exact Home and Machine even when a Run has no Session, or its Session is gone. */
export function useOpenExecutionRunDetails() {
    const router = useRouter();
    return React.useCallback(async (target: Readonly<{
        sessionId: string | null;
        serverId: string;
        machineId: string;
        runId: string;
    }>) => {
        let sessionRemoved = false;
        if (target.sessionId !== null) {
            // A Run can outlive its Session on this Home; such a row opens the Machine details below.
            const session = await sync.ensureSessionVisibleForMessageRoute(target.sessionId, {
                serverId: target.serverId,
                hydrateMessages: false,
            });
            if (session.kind !== 'missing') {
                const href = buildSessionExecutionRunRouteHref({ ...target, sessionId: target.sessionId });
                if (href) router.push(href as Href);
                return;
            }
            sessionRemoved = true;
        }
        // Load the existing details surface on demand; collection rendering never loads its composer.
        const { SessionExecutionRunDetailsView } = await import('./details/SessionExecutionRunDetailsView');
        let modalId = '';
        modalId = Modal.show({
            component: SessionExecutionRunDetailsView,
            props: {
                sessionId: null,
                serverId: target.serverId,
                workspace: { machineId: target.machineId },
                runId: target.runId,
                sessionRemoved,
                presentation: 'panel',
                onRequestClose: () => Modal.hide(modalId),
            },
            // A Run whose Session was removed lost its details with it: the dialog holds one short settled
            // message, so it sizes to its content instead of taking the full details height.
            chrome: { kind: 'card', header: 'none', scrollHost: sessionRemoved ? 'bounded' : 'body', bodyScroll: 'none',
                dimensions: { size: sessionRemoved ? 'md' : 'lg' }, phonePresentation: 'sheet' },
        });
    }, [router]);
}
