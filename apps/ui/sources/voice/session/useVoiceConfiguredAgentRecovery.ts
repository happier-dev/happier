import * as React from 'react';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionSummary } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { projectVoiceConfiguredAgentTarget } from '@/voice/agent/projectVoiceConfiguredAgentTarget';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { useVoiceSessionStore } from './voiceSessionStore';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';

/** Repair a terminal selection refusal from the same current catalog decision as Settings. */
export function useVoiceConfiguredAgentRecovery(
    controller: React.RefObject<VoiceSessionLifecycleController | null>,
): void {
    const needsSetup = useVoiceSessionStore(state => state.errorCode === 'provider_setup_required');
    const voice = useSetting('voice');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const scope = useActiveServerAccountScope();
    const machineId = useVoiceExecutionMachineId();
    const projection = useDaemonMergedProjectionSummary({
        machineId: needsSetup ? machineId : null, serverId: scope?.serverId,
    });
    const readCatalog = React.useCallback(() => needsSetup ? getAcpCatalogSnapshot(scope) : null, [needsSetup, scope]);
    const catalog = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readCatalog, readCatalog);

    React.useEffect(() => {
        if (!needsSetup) return;
        const config = readLocalConversationVoiceSettings(voice);
        if (config.conversationMode !== 'agent' || config.agent.agentSource !== 'agent') return;
        // Pure projection over pushed facts: recovery never refreshes catalogs or admits capture.
        const configuredAgentTarget = projectVoiceConfiguredAgentTarget({
            selection: config.agent, backendEnabledByTargetKey,
            entries: getResolvedBackendCatalogEntries({
                enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
                backendEnabledByTargetKey,
                acpCatalogSnapshot: catalog && !catalog.stale ? catalog.catalog : undefined,
                mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById,
                mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById,
            }),
            mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById,
        });
        controller.current?.rearmAfterCredentialAuthorityChange({
            configuredAgentTarget, providerCredentialAuthorityChanged: false,
        });
    }, [needsSetup, voice, backendEnabledByTargetKey, catalog, projection.inputs, controller]);
}
