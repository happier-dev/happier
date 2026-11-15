import type { Router } from 'expo-router';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { useCurrentProjectedAgentCapabilities } from '@/agents/hooks/useCurrentProjectedAgentCapabilities';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { SessionForkSupportSource } from '@/sync/domains/sessionFork/forkUiSupport';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { storage } from '@/sync/domains/state/storage';

/**
 * Opens the existing fork strategy modal on this Session's latest state and lets it submit Replay
 * itself, so the modal stays the one progress, approval, failure and unknown-outcome surface. Every
 * fact it passes is the same one the other fork entry points resolve (header menu, transcript rows).
 */
export function useExternalSessionReplayForkLauncher(params: Readonly<{
    sessionId: string;
    session: SessionForkSupportSource | null;
    serverId: string | null;
    machineId: string | null;
    /** Only an external Session's footer launches it; others skip the capability read. */
    enabled: boolean;
    executionRunsEnabled: boolean;
    router: Pick<Router, 'push'>;
}>): () => void {
    const ownerMetadata = params.session ? readSessionOwnerMetadataView(params.session) : null;
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    const currentAgentCapabilities = useCurrentProjectedAgentCapabilities({
        agentId,
        machineId: params.machineId,
        serverId: params.serverId,
        enabled: params.enabled,
    });
    // Scoped to THIS Session's server, like every other fork launcher.
    const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: params.serverId,
    });
    return useEventCallback(() => {
        const settings = storage.getState().settings;
        openSessionForkStrategyFlow({
            navigation: params.router,
            sessionId: params.sessionId,
            forkSupportSource: params.session,
            serverId: params.serverId,
            machineId: params.machineId,
            forkPoint: { type: 'latest' },
            settings,
            replayEnabled: settings.sessionReplayEnabled,
            currentAgentCapabilities,
            executionRunsEnabled: params.executionRunsEnabled,
            agentSwitchingEnabled,
            autoSubmitRoute: 'replay',
            navigateToSession: (childSessionId, options) => {
                params.router.push(buildScopedSessionRouteHref({
                    sessionId: childSessionId,
                    serverId: options?.serverId ?? params.serverId,
                }) as never);
            },
            navigateToNewSession: (route) => {
                params.router.push(route as never);
            },
        });
    });
}
