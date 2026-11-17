import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { ConfiguredSshHostsV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { buildConfiguredSshHostsSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildConfiguredSshHostsSystemTaskSpec';
import { getErrorMessage } from '@/utils/errors/getErrorMessage';

import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';

export type ConfiguredSshHostSuggestionsState = Readonly<{
    suggestions: readonly SshConfiguredHostSuggestion[];
    loading: boolean;
    refreshing: boolean;
    unsupported: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
}>;

export function useConfiguredSshHostSuggestions(params: Readonly<{
    runner?: SystemTaskRunner;
    enabled?: boolean;
}> = {}): ConfiguredSshHostSuggestionsState {
    const runner = params.runner ?? getDefaultSystemTaskRunner();
    const enabled = params.enabled ?? true;
    const unsupported = !enabled || runner.mode === 'unavailable';
    const [suggestions, setSuggestions] = React.useState<readonly SshConfiguredHostSuggestion[]>([]);
    const [taskId, setTaskId] = React.useState<string | null>(null);
    const [error, setError] = React.useState<Error | null>(null);
    const startedRef = React.useRef(false);
    const processedResultRef = React.useRef<SystemTaskResult | null>(null);
    const taskSnapshot = useSystemTaskSnapshot(runner, taskId);

    const refresh = React.useCallback(async () => {
        if (unsupported) return;
        setError(null);
        processedResultRef.current = null;
        // Clearing the settled selection publishes startup before the next native task id exists.
        setTaskId(null);
        try {
            const nextTaskId = await runner.start(buildConfiguredSshHostsSystemTaskSpec());
            setTaskId(nextTaskId);
        } catch (error) {
            setError(error instanceof Error ? error : new Error(getErrorMessage(error)));
        }
    }, [runner, unsupported]);

    React.useEffect(() => {
        if (startedRef.current || unsupported) return;
        startedRef.current = true;
        void refresh();
    }, [refresh, unsupported]);

    React.useEffect(() => {
        const result = taskSnapshot?.result ?? null;
        if (!result || processedResultRef.current === result) return;
        processedResultRef.current = result;
        if (result.ok) {
            const parsed = ConfiguredSshHostsV1Schema.safeParse(result.data);
            if (parsed.success) {
                setSuggestions(parsed.data);
                setError(null);
            } else setError(parsed.error);
        } else {
            setError(new Error(result.error.message));
        }
    }, [taskSnapshot?.result]);

    const active = !unsupported && processedResultRef.current === null && error === null;
    return {
        suggestions,
        loading: active && suggestions.length === 0,
        refreshing: active && suggestions.length > 0,
        unsupported,
        error,
        refresh,
    };
}
