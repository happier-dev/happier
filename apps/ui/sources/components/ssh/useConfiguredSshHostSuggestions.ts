import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';

const DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND = 'local.ssh.discoverConfiguredHosts.v1';

export type ConfiguredSshHostSuggestionsState = Readonly<{
    suggestions: readonly SshConfiguredHostSuggestion[];
    loading: boolean;
    refreshing: boolean;
    unsupported: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
}>;

function buildDiscoverConfiguredSshHostsSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND,
        params: {},
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readSuggestion(value: unknown): SshConfiguredHostSuggestion | null {
    const record = asRecord(value);
    if (!record) return null;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const alias = typeof record.alias === 'string' ? record.alias.trim() : '';
    const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : '';
    const source = record.source === 'ssh-config' || record.source === 'known-hosts' ? record.source : null;
    if (!id || !alias || !hostname || !source) return null;

    const port = typeof record.port === 'number' && Number.isInteger(record.port) && record.port > 0
        ? record.port
        : null;
    const username = typeof record.username === 'string' && record.username.trim()
        ? record.username.trim()
        : null;
    const sourcePath = typeof record.sourcePath === 'string' && record.sourcePath.trim()
        ? record.sourcePath.trim()
        : null;

    return {
        id,
        alias,
        hostname,
        port,
        username,
        source,
        ...(sourcePath ? { sourcePath } : {}),
    };
}

function readSuggestionsResult(result: SystemTaskResult): readonly SshConfiguredHostSuggestion[] {
    if (!result.ok) return [];
    const data = result.data;
    const dataRecord = asRecord(data);
    const list: readonly unknown[] = Array.isArray(data)
        ? data
        : (Array.isArray(dataRecord?.hosts) ? dataRecord.hosts : []);
    return list.map(readSuggestion).filter((entry): entry is SshConfiguredHostSuggestion => entry != null);
}

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
        const nextTaskId = await runner.start(buildDiscoverConfiguredSshHostsSpec());
        setTaskId(nextTaskId);
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
            setSuggestions(readSuggestionsResult(result));
            setError(null);
        } else {
            setError(new Error(result.error.message));
        }
        setTaskId(null);
    }, [taskSnapshot?.result]);

    const active = taskId != null;
    return {
        suggestions,
        loading: active && suggestions.length === 0,
        refreshing: active && suggestions.length > 0,
        unsupported,
        error,
        refresh,
    };
}
