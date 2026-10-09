import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

/**
 * Opens the ordinary New Session composer on the exact selected administration
 * target and a daemon-canonicalized Session working directory.
 *
 * There is no Agent-specific session path here and no daemon-owned authoring
 * launcher: the seed goes into the one New Session draft repository and the
 * push goes to the one `/new` route, exactly like every other in-app seeding
 * caller, so the composer stays editable and the launch still ends at the
 * canonical `session.spawn_new` Action. The placement names the exact selected
 * administration target — never an inferred active or first machine — so if
 * that target has no resolvable identity, nothing opens.
 */
export function usePluginAuthoringSession(params: Readonly<{
    serverId: string | null;
    machineId: string | null;
}>): (request: Readonly<{ sessionDirectory: string; promptText: string }>) => void {
    const router = useRouter();
    const activeAccountScope = useActiveServerAccountScope();
    const { serverId, machineId } = params;
    const currentRef = React.useRef({ scope: activeAccountScope, serverId, machineId });
    currentRef.current = { scope: activeAccountScope, serverId, machineId };
    return React.useCallback((request: Readonly<{ sessionDirectory: string; promptText: string }>) => {
        if (!activeAccountScope || !serverId || !machineId) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, activeAccountScope)) return;
        seedAndOpenNewSession({
            seed: {
                prompt: request.promptText,
                placement: {
                    kind: 'exactTarget',
                    serverId,
                    machineId,
                    directory: request.sessionDirectory,
                },
            },
            scope: activeAccountScope,
            isCurrent: () => lifetime.isCurrent()
                && areServerAccountScopesEqual(currentRef.current.scope, activeAccountScope)
                && currentRef.current.serverId === serverId
                && currentRef.current.machineId === machineId,
            navigateToNewSession: ({ draftId }) => {
                router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) });
            },
        });
    }, [activeAccountScope, machineId, router, serverId]);
}
