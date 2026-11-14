import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectPluginActionControlExecutionV1 } from '@happier-dev/plugin-ui/hostApi';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';
import { createTriageBulkEntrySessionsController, type TriageBulkHostV1, type TriageBulkSessionsOptionsV1, type TriageBulkSessionsControllerV1 } from '../../sessions/bulkEntrySessionsController.js';
export * from '../../sessions/bulkEntrySessionsController.js';

export type TriageBulkSessionsUiControllerV1 = Omit<TriageBulkSessionsControllerV1, 'settleAction'> & Readonly<{ settleAction: PluginUiActionControlController['onSettled'] }>;

export function useTriageBulkEntrySessions(options?: TriageBulkSessionsOptionsV1): TriageBulkSessionsUiControllerV1 {
    const host = usePluginHostApi();
    const text = usePluginTranslation();
    const owner = React.useMemo(() => createTriageBulkEntrySessionsController(host as unknown as TriageBulkHostV1, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const failure = snapshot.phase.kind === 'unavailable' || snapshot.phase.kind === 'settled' ? snapshot.phase.failure : undefined;
    React.useEffect(() => {
        if (failure === undefined) return;
        void presentTriageMountedUiActionFailure(host, new PluginError({
            code: failure.codes[0] ?? 'unavailable',
            diagnostics: failure.codes.slice(1).map(code => ({ code, severity: 'error' })),
            ...(failure.requestId === undefined ? {} : { details: { requestId: failure.requestId } }),
        }), text);
    }, [failure, host, text]);
    React.useEffect(() => {
        if (snapshot.phase.kind !== 'settled') return;
        for (const result of snapshot.phase.results) {
            if (result.status !== 'settled') continue;
            const start = result.outcome.start;
            if (start.type !== 'creationFailed' || start.failureCode === undefined) continue;
            void presentTriageMountedUiActionFailure(host, new PluginError({
                code: start.failureCode,
                ...(start.failureCause === undefined ? {} : { failureCause: start.failureCause }),
            }), text);
        }
    }, [snapshot.phase, host, text]);
    const cancel = React.useCallback(async () => {
        try { await owner.getSnapshot().cancel(); }
        catch (error) { await presentTriageMountedUiActionFailure(host, error, text); }
    }, [owner, host, text]);
    const reset = React.useCallback(async () => {
        try { await owner.getSnapshot().reset(); }
        catch (error) { await presentTriageMountedUiActionFailure(host, error, text); }
    }, [owner, host, text]);
    const settleAction = React.useCallback<PluginUiActionControlController['onSettled']>(execution => {
        owner.getSnapshot().settleAction(projectPluginActionControlExecutionV1(execution, text));
    }, [owner, text]);
    return React.useMemo(() => ({ ...snapshot, settleAction, cancel, reset }), [snapshot, settleAction, cancel, reset]);
}
