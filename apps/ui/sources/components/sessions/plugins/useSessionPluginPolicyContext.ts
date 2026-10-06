import { usePluginUiSessionPolicyEvaluationContext } from '@/components/sessions/model/usePluginUiSessionPolicyEvaluationContext';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';

import type { SessionPluginRuntimeState } from './useSessionPluginRuntime';

/**
 * The ONE mounted-Session plugin policy context.
 *
 * Every Session-scoped plugin mount — an Agent inline surface, an installed
 * Session widget, a registered pane — must evaluate availability against the
 * SAME facts: this Session's agent and lifecycle state, the exact Home's feature
 * snapshot, this device's local policy settings and the runtime's machine. A
 * second assembly of that record is how one placement quietly widens or narrows
 * capability relative to another, so this hook is the only place it is built.
 *
 * It resolves no authority itself: `usePluginUiSessionPolicyEvaluationContext`
 * remains the projection owner and the incumbent `PluginSurfaceHost` still makes
 * every currentness, grant and method decision beneath it.
 */
export function useSessionPluginPolicyContext(input: Readonly<{
    session: Session;
    runtime: SessionPluginRuntimeState;
    /** A route-scoped Agent id, used only when the Session record has none. */
    agentId?: string | null;
}>): PluginUiPolicyEvaluationContext {
    const sessionStatus = useSessionStatus(input.session, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const settings = useFeatureLocalPolicySettings();
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(input.runtime.serverId, {
        enabled: Boolean(input.runtime.serverId),
    });
    return usePluginUiSessionPolicyEvaluationContext({
        platform: input.runtime.platform,
        serverId: input.runtime.serverId,
        settings,
        serverFeaturesSnapshot,
        facts: {
            // Installation/enablement is the incumbent plugin owner's fact; a
            // projected contribution only reaches a mount while its package is
            // enabled, so this record never re-decides it.
            pluginEnabled: true,
            sessionAgentId: readSessionPresentationAgentId(input.session) ?? input.agentId ?? null,
            sessionState: sessionStatus.state,
            machineId: input.runtime.machineId,
            projectId: null,
            browserExists: false,
        },
    });
}
