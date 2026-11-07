import * as React from 'react';

import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Modal } from '@/modal';

/** Collection rows retain the exact Home and Machine even when a Run has no Session. */
export function useOpenExecutionRunDetails() {
    const router = useRouter();
    return React.useCallback(async (target: Readonly<{
        sessionId: string | null;
        serverId: string;
        machineId: string;
        runId: string;
    }>) => {
        if (target.sessionId !== null) {
            const href = buildSessionExecutionRunRouteHref({ ...target, sessionId: target.sessionId });
            if (href) router.push(href as Href);
            return;
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
                presentation: 'panel',
                onRequestClose: () => Modal.hide(modalId),
            },
            chrome: { kind: 'card', header: 'none', scrollHost: 'body', bodyScroll: 'none',
                dimensions: { size: 'lg' }, phonePresentation: 'sheet' },
        });
    }, [router]);
}
