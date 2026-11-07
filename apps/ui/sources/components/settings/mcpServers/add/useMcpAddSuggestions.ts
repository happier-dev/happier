import * as React from 'react';
import { getActionSpec, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { mcpAddSuggestionRows, type McpAddSuggestionRow } from './mcpAddModalConfig';

/** The Add sheet reads the create Action's choices only while its catalog is presented. */
export function useMcpAddSuggestions(execution: ReturnType<typeof useMountedActionExecution>, enabled: boolean) {
    const { execute, isCurrent, ready } = execution;
    const [attempt, retry] = React.useReducer((current: number) => current + 1, 0);
    const [state, setState] = React.useState<Readonly<{
        rows: readonly McpAddSuggestionRow[];
        loading: boolean;
        error: string | null;
    }>>({ rows: [], loading: true, error: null });
    React.useEffect(() => {
        if (!enabled || !ready) return;
        const controller = new AbortController();
        setState(previous => previous.loading && previous.error === null ? previous : { ...previous, loading: true, error: null });
        void execute('action.options.resolve', { actionId: 'mcp.servers.create', fieldPath: 'suggestionId' }, { signal: controller.signal }).then(result => {
            if (controller.signal.aborted || !isCurrent()) return;
            if (!result.ok) throw new Error(result.errorCode ?? result.error);
            // The exact Action owns its response schema and the static option projection.
            const resolved = getActionSpec('action.options.resolve').outputSchema!.parse(result.result) as PublicActionResultById['action.options.resolve'];
            setState({ rows: mcpAddSuggestionRows(resolved.options), loading: false, error: null });
        }).catch((failure: unknown) => {
            if (!controller.signal.aborted && isCurrent()) setState(previous => ({ ...previous, loading: false,
                error: failure instanceof Error ? failure.message : 'action_failed' }));
        });
        return () => controller.abort();
    }, [enabled, execute, isCurrent, ready, attempt]);
    return { ...state, retry };
}
