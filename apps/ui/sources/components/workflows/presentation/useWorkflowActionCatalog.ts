import * as React from 'react';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { listWorkflowStepActionSpecs } from './workflowActionCatalog';
import { getPreferredLanguage } from '@/text';

/** Borrows the selected machine's existing merged-projection lifecycle. A stale
 * or retired projection supplies no offered plugin Actions; authored ids remain in the draft. */
export function useWorkflowActionCatalog(scope?: AuthoringComposerScope) {
    const sessionId = scope?.kind === 'session' ? scope.sessionId : null;
    const serverId = scope?.serverId;
    const sessionMachineId = getStorage()(React.useCallback((state) => sessionId === null ? null
        : resolveMachineControlTargetForSessionFromState(state, serverId ? { sessionId, serverId } : sessionId)?.machineId ?? null, [sessionId, serverId]));
    const machineId = scope?.kind === 'machine' ? scope.machineId : sessionMachineId;
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, retainInputsAcrossScopeChange: false });
    // The merged-projection lifecycle already subscribes this leaf to language changes.
    const language = getPreferredLanguage();
    const current = projection.phase === 'ready' ? projection.inputs?.pluginProjectionV2 ?? null : null;
    const specs = React.useMemo(() => listWorkflowStepActionSpecs(current, current ? normalizePluginUiProjection(current) : null), [current, language]);
    return { specs, phase: projection.phase, machineId, serverId: serverId ?? null };
}
