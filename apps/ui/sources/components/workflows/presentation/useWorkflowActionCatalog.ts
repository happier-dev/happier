import * as React from 'react';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { listWorkflowStepActionSpecs } from './workflowActionCatalog';
import { getPreferredLanguage } from '@/text';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';

/** Borrows the selected machine's existing merged-projection lifecycle. A stale
 * or retired projection supplies no offered plugin Actions; authored ids remain in the draft. */
export function useWorkflowActionCatalog(scope?: AuthoringComposerScope) {
    const sessionId = scope?.kind === 'session' ? scope.sessionId : null;
    const serverId = scope?.serverId;
    const sessionMachineId = getStorage()(React.useCallback((state) => sessionId === null ? null
        : resolveMachineControlTargetForSessionFromState(state, serverId ? { sessionId, serverId } : sessionId)?.machineId ?? null, [sessionId, serverId]));
    const machineId = scope?.kind === 'machine' ? scope.machineId : sessionMachineId;
    // The step picker reads plugin Actions and their presentation: the plugin UI sections, never the whole catalogue.
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, retainInputsAcrossScopeChange: false, sections: PLUGIN_UI_SECTIONS });
    // The merged-projection lifecycle already subscribes this leaf to language changes.
    const language = getPreferredLanguage();
    const current = projection.phase === 'ready' ? projection.inputs?.pluginProjectionV2 ?? null : null;
    const uiProjection = projection.phase === 'ready' ? projection.inputs?.pluginUiProjection ?? null : null;
    const localize = usePluginLocalizedTextResolver({ projection: uiProjection, locale: language });
    const specs = React.useMemo(() => listWorkflowStepActionSpecs(current, uiProjection, localize), [current, uiProjection, language, localize]);
    return { specs, phase: projection.phase, machineId, sessionId, serverId: serverId ?? null };
}
