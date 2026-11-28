import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LocalHistoryRpcRequest, LocalHistoryRpcResponse } from '@happier-dev/protocol';

import { listLocalHistoryProviders } from '@/agents/registry/registryCore';
import { useRuntimeActive } from '@/hooks/runtime/useRuntimeActive';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage } from '@/sync/domains/state/storage';
import { machineDirectSessionTranscriptPage, machineLocalHistory } from '@/sync/ops/machineDirectSessions';
import { normalizeDirectTranscriptMessages } from '@/sync/runtime/directSessions/normalizeDirectTranscriptMessages';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { StorageState } from '@/sync/store/types';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';

type LocalHistoryTarget = Pick<LocalHistoryRpcRequest, 'providerId' | 'source'> & Readonly<{
    machineId: string;
    serverId: string;
    machineName: string;
}>;

export type LocalHistoryKeepItem = NonNullable<Extract<LocalHistoryRpcResponse, { ok: true }>['due']>[number]
    & Readonly<{ id: string; target: LocalHistoryTarget; retentionDays: number }>;

const EMPTY_KEYS: readonly string[] = [];
const EMPTY_ITEMS: readonly LocalHistoryKeepItem[] = [];
const LOCAL_HISTORY_PROVIDERS = listLocalHistoryProviders();

function localHistoryKeepItemId(target: LocalHistoryTarget, item: { projectId: string; remoteSessionId: string }): string {
    return JSON.stringify([target.machineId, target.providerId, item.projectId, item.remoteSessionId]);
}

export function useLocalHistoryKeepSource(opts: Readonly<{ enabled: boolean; machineId?: string; providerId?: LocalHistoryTarget['providerId'] }>) {
    const { serverId } = useActiveServerSnapshot();
    const { enabled, machineId, providerId } = opts;
    const active = useRuntimeActive();
    const selectDue = React.useCallback((state: StorageState): readonly string[] => {
        if (!enabled || !active) return EMPTY_KEYS;
        const now = Date.now();
        return resolveVisibleMachinesForActiveServerFromState(state).flatMap((machine) => {
            const dueAt: unknown = machine.daemonState?.keptDueAtMs;
            return (machineId === undefined || machine.id === machineId) && isMachineOnline(machine, now)
                && typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt <= now
                ? [JSON.stringify([machine.id, dueAt])] : [];
        });
    }, [active, enabled, machineId]);
    const keys = storage(useShallow(selectDue));
    const [results, setResults] = React.useState<Readonly<Record<string, readonly LocalHistoryKeepItem[] | 'error'>>>({});
    const [retryCount, retry] = React.useReducer((count: number) => count + 1, 0);
    const groups = React.useMemo(() => keys.map((machineKey) => {
        const [machineId, dueAtMs] = JSON.parse(machineKey) as [string, number];
        return { machineId, key: JSON.stringify([serverId, providerId, retryCount, machineId, dueAtMs]) };
    }), [keys, providerId, retryCount, serverId]);

    const requests = React.useRef(new Map<string, object>());
    React.useEffect(() => {
        const current = new Set(groups.map((group) => group.key));
        for (const key of requests.current.keys()) if (!current.has(key)) requests.current.delete(key);
        for (const { key, machineId: originId } of groups) {
            if (requests.current.has(key)) continue;
            const request = {};
            requests.current.set(key, request);
            const machineName = getMachineDisplayName(storage.getState().machines[originId]) ?? originId;
            void Promise.all(LOCAL_HISTORY_PROVIDERS.filter((provider) => providerId === undefined || provider.localHistory.providerId === providerId).map(async (provider) => {
                const { providerId, source } = provider.localHistory;
                const target = { providerId, source, machineId: originId, serverId, machineName };
                const result = await machineLocalHistory(originId, { providerId, source, operation: 'due.list' }, { serverId });
                if (!result.ok) {
                    if (result.errorCode === 'provider_unavailable') return EMPTY_ITEMS;
                    throw new Error(result.errorCode);
                }
                const retentionDays = result.retentionDays;
                if (retentionDays == null) return EMPTY_ITEMS;
                return (result.due ?? []).map((row) => ({ ...row, id: localHistoryKeepItemId(target, row), target, retentionDays }));
            })).then((results) => results.flat(), () => 'error' as const).then((items) => {
                if (requests.current.get(key) === request) setResults((currentResults) => ({ ...currentResults, [key]: items }));
            });
        }
        setResults((currentResults) => {
            const obsolete = Object.keys(currentResults).filter((key) => !current.has(key));
            return obsolete.length === 0 ? currentResults : Object.fromEntries(Object.entries(currentResults).filter(([key]) => current.has(key)));
        });
    }, [groups, providerId, serverId]);

    const items = React.useMemo(() => groups.flatMap(({ key }) => {
        const result = results[key];
        return result === undefined || result === 'error' ? [] : result;
    }).sort((left, right) => left.leavesAt - right.leavesAt), [groups, results]);

    const remove = React.useCallback((id: string) => {
        setResults((currentResults) => Object.fromEntries(Object.entries(currentResults).map(([key, result]) => [
            key, result === 'error' ? result : result.filter((item) => item.id !== id),
        ])));
    }, []);
    return { items, failed: groups.some(({ key }) => results[key] === 'error'), remove, retry };
}

export async function decideLocalHistoryKeep(item: LocalHistoryKeepItem, operation: 'keep' | 'letGo') {
    const { machineId, serverId, providerId, source } = item.target;
    return await machineLocalHistory(machineId, { providerId, source, operation, items: [
        { remoteSessionId: item.remoteSessionId, projectId: item.projectId },
    ] }, { serverId });
}

export async function readLocalHistoryPreview(item: LocalHistoryKeepItem): Promise<string | null> {
    const { serverId, machineId, providerId, source } = item.target;
    const response = await machineDirectSessionTranscriptPage({
        machineId, providerId, remoteSessionId: item.remoteSessionId,
        source: source.kind === 'claudeConfig' ? { ...source, projectId: item.projectId } : source,
        direction: 'older',
    }, { serverId });
    if (!response.ok) return null;
    for (const message of normalizeDirectTranscriptMessages(response.items).reverse()) {
        if (message.role === 'user' && message.content.text.trim()) return message.content.text;
        if (message.role !== 'agent') continue;
        const text = message.content.slice().reverse().find((content) => content.type === 'text' && content.text.trim());
        if (text?.type === 'text') return text.text;
    }
    return null;
}
