import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceRefs, storage } from '@/sync/domains/state/storage';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import { openProjectSetupAuthoring, type ProjectSetupAuthoringInput } from './projectSetupAuthoring';
import { resolveCurrentProjectAuthoringReturn } from '@/components/projects/detail/projectRouteState';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

/** Both visual setup entries consume the same callback; ordinary New Session owns all options. */
export function useProjectSetupAuthoring(input: ProjectSetupAuthoringInput | null) {
    // A mounted entry owns only its pending opening; retirement cannot cancel the opened draft.
    const opening = React.useMemo(() => ({ controller: new AbortController() }), [input?.workspace.serverId, input?.workspace.workspaceId,
        input?.workspace.machineId, input?.workspace.rootPath, input?.page, input?.comparisonId]);
    React.useEffect(() => {
        // React may replay mount effects; the remounted entry receives a fresh live signal.
        if (opening.controller.signal.aborted) opening.controller = new AbortController();
        return () => opening.controller.abort();
    }, [opening]);
    const onSetUpWithAgent = React.useCallback(async (): Promise<ActionExecuteResult> => {
        if (!input) return { ok: true, result: { kind: 'unavailable', reason: 'origin_unavailable' } };
        const cancellation = mergeAbortSignals([opening.controller.signal, input.signal]);
        try {
            return await openProjectSetupAuthoring({ ...input, signal: cancellation.signal });
        } finally {
            cancellation.dispose();
        }
    }, [input, opening]);
    return React.useMemo(() => ({ onSetUpWithAgent, hasQualifiedCheckout: input !== null }), [input, onSetUpWithAgent]);
}

/** Draft and Session return affordances consume the same exact qualified destination. */
export function useProjectAuthoringReturn(origin: PluginUiNewSessionSeedOriginV1 | null | undefined) {
    const router = useRouter();
    // Subscribe only to the Account and Project rows which can change admission.
    const workspaceRefs = useWorkspaceRefs();
    const profileScope = storage(state => state.profileScope);
    const destination = React.useMemo(() => resolveCurrentProjectAuthoringReturn(origin), [origin, profileScope, workspaceRefs]);
    const onReturnToProject = React.useCallback(() => {
        const current = resolveCurrentProjectAuthoringReturn(origin);
        if (current.kind !== 'ready') return current;
        router.push(current.href as never);
        return { kind: 'opened' as const };
    }, [origin, router]);
    return { destination, onReturnToProject };
}
