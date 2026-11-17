import * as React from 'react';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { listWorkflowStepActionSpecs, type WorkflowActionCatalogPurpose } from './workflowActionCatalog';
import { getPreferredLanguage } from '@/text';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import type { ActionDiscoveryDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { acquireDaemonMergedWorkflowActionCatalog, acquireWorkflowAccountActionCatalog, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';

const EMPTY_ACTIONS: readonly ActionDiscoveryDefinitionSummaryV1[] = Object.freeze([]);

/** Borrows the selected machine's existing merged-projection lifecycle. A stale
 * or retired projection supplies no offered plugin Actions; authored ids remain in the draft. */
export function useWorkflowActionCatalog(scope?: AuthoringComposerScope, purpose: WorkflowActionCatalogPurpose = 'workflowStep') {
    const sessionId = scope?.kind === 'session' ? scope.sessionId : null;
    const serverId = scope?.serverId;
    const sessionMachineId = getStorage()(React.useCallback((state) => sessionId === null ? null
        : resolveMachineControlTargetForSessionFromState(state, serverId ? { sessionId, serverId } : sessionId)?.machineId ?? null, [sessionId, serverId]));
    const machineId = scope?.kind === 'machine' ? scope.machineId : sessionMachineId;
    // The step picker reads plugin Actions and their presentation: the plugin UI sections, never the whole catalogue.
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, retainInputsAcrossScopeChange: false, sections: PLUGIN_UI_SECTIONS });
    const entry = React.useMemo(() => projection.phase === 'ready'
        ? readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId, sections: PLUGIN_UI_SECTIONS }) : null,
    [machineId, serverId, projection.phase, projection.inputs]);
    const activeAccount = useActiveServerAccountScopeLifetime();
    const accountServerId = serverId ?? activeAccount?.scope.serverId;
    const accountStates = useServerCredentialAccountScopeStates(!machineId && accountServerId ? [accountServerId] : []);
    const accountBinding = accountStates.values().next().value?.binding ?? null;
    const account = accountBinding ? readServerAccountScopeOwnerLifetime(accountBinding) : null;
    const target = machineId ? entry?.kind === 'ready' ? entry : null : account;
    const [discovery, setDiscovery] = React.useState<Readonly<{
        target: typeof target;
        phase: 'ready' | 'error';
        specs: readonly ActionDiscoveryDefinitionSummaryV1[];
    }> | null>(null);
    React.useEffect(() => {
        if (!target) return;
        const read = 'kind' in target ? acquireDaemonMergedWorkflowActionCatalog(target)
            : acquireWorkflowAccountActionCatalog(target);
        let mounted = true;
        void read.promise.then(specs => {
            if (mounted) setDiscovery({ target, phase: 'ready', specs });
        }, () => {
            if (mounted) setDiscovery({ target, phase: 'error', specs: EMPTY_ACTIONS });
        });
        return () => { mounted = false; read.release(); };
    }, [target]);
    const currentDiscovery = discovery?.target === target ? discovery : null;
    const offered = currentDiscovery?.phase === 'ready' ? currentDiscovery.specs : EMPTY_ACTIONS;
    // The merged-projection lifecycle already subscribes this leaf to language changes.
    const language = getPreferredLanguage();
    const current = projection.phase === 'ready' ? projection.inputs?.pluginProjectionV2 ?? null : null;
    const uiProjection = projection.phase === 'ready' ? projection.inputs?.pluginUiProjection ?? null : null;
    const localize = usePluginLocalizedTextResolver({ projection: uiProjection, locale: language });
    const specs = React.useMemo(() => listWorkflowStepActionSpecs(current, uiProjection, localize, offered, purpose), [current, uiProjection, language, localize, offered, purpose]);
    const phase = !machineId || projection.phase === 'ready' ? currentDiscovery?.phase ?? 'loading' : projection.phase;
    return { specs, phase, machineId, sessionId, serverId: serverId ?? null };
}
