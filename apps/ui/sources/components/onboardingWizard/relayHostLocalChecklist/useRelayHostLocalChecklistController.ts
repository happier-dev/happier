import * as React from 'react';

import { buildLocalRelayRuntimeSystemTaskSpec } from '@/components/settings/server/localControl/buildLocalRelayRuntimeSystemTaskSpec';
import { buildLocalTailscaleSecureAccessSystemTaskSpec } from '@/components/settings/server/localControl/buildLocalTailscaleSecureAccessSystemTaskSpec';
import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';

import { buildRelayHostLocalChecklistItems } from './buildRelayHostLocalChecklistItems';
import { mapRelayHostLocalChecklistExecution } from './mapRelayHostLocalChecklistExecution';
import type {
    RelayHostLocalChecklistController,
    RelayHostLocalChecklistLogEntry,
    RelayHostLocalChecklistItemId,
    RelayHostLocalChecklistRuntimeStatus,
} from './types';

type RelayTaskKind =
    | 'relay.runtime.installOrUpdate.v1'
    | 'relay.runtime.start.v1'
    | 'secureAccess.tailscale.v1';

function taskSpecFor(kind: RelayTaskKind, upstreamUrl: string | null) {
    if (kind === 'relay.runtime.installOrUpdate.v1' || kind === 'relay.runtime.start.v1') {
        return buildLocalRelayRuntimeSystemTaskSpec(kind);
    }
    if (!upstreamUrl) {
        throw new Error('Missing upstream URL for Tailscale secure access.');
    }
    return buildLocalTailscaleSecureAccessSystemTaskSpec({ upstreamUrl });
}

function readableDiagnostics(params: Readonly<{
    itemId: RelayHostLocalChecklistItemId;
    status: RelayHostLocalChecklistRuntimeStatus | null;
    activeRelayUrl: string | null;
    shareableUrl: string | null;
    logs: readonly RelayHostLocalChecklistLogEntry[];
}>): string {
    const lines = [
        `Item: ${params.itemId}`,
        `Runtime installed: ${params.status?.installed ? 'yes' : 'no'}`,
        `Runtime version: ${params.status?.version ?? 'n/a'}`,
        `Service active: ${params.status?.service.active === true ? 'yes' : 'no'}`,
        `Relay URL: ${params.status?.relayUrl ?? 'n/a'}`,
        `Current relay: ${params.activeRelayUrl ?? 'n/a'}`,
        `Secure access URL: ${params.shareableUrl ?? 'n/a'}`,
        '',
        'Logs:',
        ...params.logs.map((log) => `[${log.level}] ${log.stepId ?? 'unknown'}: ${log.message}`),
    ];
    return lines.join('\n');
}

export function useRelayHostLocalChecklistController(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}): RelayHostLocalChecklistController {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const { status } = useLocalRelayRuntimeControl({ runner });
    const activeServerSnapshot = getActiveServerSnapshot();
    const currentRelayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null;
    const currentShareableUrl = activeServerSnapshot.activeShareableServerUrl
        ? String(activeServerSnapshot.activeShareableServerUrl).trim()
        : null;
    const items = React.useMemo(
        () => buildRelayHostLocalChecklistItems({
            runtimeStatus: status,
            currentRelayUrl,
            currentShareableUrl,
        }),
        [currentRelayUrl, currentShareableUrl, status],
    );

    const [selectedIds, setSelectedIds] = React.useState<readonly RelayHostLocalChecklistItemId[]>(
        () => items.filter((item) => item.defaultSelected || item.satisfied).map((item) => item.id),
    );
    const [expandedIds, setExpandedIds] = React.useState<ReadonlySet<RelayHostLocalChecklistItemId>>(() => new Set());
    const [phase, setPhase] = React.useState<'select' | 'execute' | 'done'>('select');
    const [completedItemIds, setCompletedItemIds] = React.useState<readonly RelayHostLocalChecklistItemId[]>([]);
    const [failedItemIds, setFailedItemIds] = React.useState<readonly RelayHostLocalChecklistItemId[]>([]);
    const [logsById, setLogsById] = React.useState<Partial<Record<RelayHostLocalChecklistItemId, readonly { ts: number; level: 'info' | 'warn' | 'error'; stepId: string | null; message: string }[]>>>({});
    const [errorById, setErrorById] = React.useState<Partial<Record<RelayHostLocalChecklistItemId, string | null>>>({});
    const [activeItemId, setActiveItemId] = React.useState<RelayHostLocalChecklistItemId | null>(null);
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [executionIndex, setExecutionIndex] = React.useState(0);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const queue = React.useMemo(
        () => items.filter((item) => selectedIds.includes(item.id) && !item.satisfied),
        [items, selectedIds],
    );

    React.useEffect(() => {
        setSelectedIds((current) => {
            const merged = new Set(current);
            for (const item of items) {
                if (item.satisfied || item.defaultSelected) {
                    merged.add(item.id);
                }
            }
            const next = Array.from(merged);
            if (next.length === current.length && next.every((value, index) => value === current[index])) {
                return current;
            }
            return next;
        });
    }, [items]);

    React.useEffect(() => {
        if (phase !== 'execute') return;
        if (activeTaskId) return;
        if (executionIndex >= queue.length) {
            setPhase('done');
            return;
        }

        const item = queue[executionIndex];
        if (!item) {
            setPhase('done');
            return;
        }

        setActiveItemId(item.id);
        const kind: RelayTaskKind =
            item.id === 'installRelayRuntime'
                ? 'relay.runtime.installOrUpdate.v1'
                : item.id === 'startRelayRuntime'
                    ? 'relay.runtime.start.v1'
                    : 'secureAccess.tailscale.v1';

        void (async () => {
            const taskSpec = taskSpecFor(kind, currentRelayUrl);
            const taskId = await runner.start(taskSpec);
            setActiveTaskId(taskId);
        })().catch(() => {
            setFailedItemIds((current) => Array.from(new Set([...current, item.id])));
            setActiveItemId(null);
            setActiveTaskId(null);
        });
    }, [activeTaskId, currentRelayUrl, executionIndex, phase, queue, runner]);

    React.useEffect(() => {
        if (!activeTaskSnapshot || !activeItemId || activeTaskSnapshot.result == null) {
            if (activeTaskSnapshot && activeItemId) {
                const logs = activeTaskSnapshot.events
                    .filter((event) => typeof event.stepId === 'string')
                    .map((event) => ({
                        ts: typeof event.tsMs === 'number' ? event.tsMs : Date.now(),
                        level: (event.type === 'error' ? 'error' : event.type === 'prompt' ? 'warn' : 'info') as RelayHostLocalChecklistLogEntry['level'],
                        stepId: typeof event.stepId === 'string' ? event.stepId : null,
                        message: typeof event.message === 'string' ? event.message.trim() : '',
                    }))
                    .filter((entry) => entry.message.length > 0);
                setLogsById((current) => ({ ...current, [activeItemId]: logs }));
            }
            return;
        }

        const result = activeTaskSnapshot.result;
        if (result == null) {
            return;
        }
        const success = result.ok;
        const logs = activeTaskSnapshot.events
            .filter((event) => typeof event.stepId === 'string')
            .map((event) => ({
                ts: typeof event.tsMs === 'number' ? event.tsMs : Date.now(),
                level: (event.type === 'error' ? 'error' : event.type === 'prompt' ? 'warn' : 'info') as RelayHostLocalChecklistLogEntry['level'],
                stepId: typeof event.stepId === 'string' ? event.stepId : null,
                message: typeof event.message === 'string' ? event.message.trim() : '',
            }))
            .filter((entry) => entry.message.length > 0);
        setLogsById((current) => ({ ...current, [activeItemId]: logs }));
        setErrorById((current) => ({
            ...current,
            [activeItemId]: success ? null : (result.error.message.trim() || result.error.code || null),
        }));
        if (success) {
            setCompletedItemIds((current) => Array.from(new Set([...current, activeItemId])));
        } else {
            setFailedItemIds((current) => Array.from(new Set([...current, activeItemId])));
        }
        setActiveItemId(null);
        setActiveTaskId(null);
        setExecutionIndex((current) => current + 1);
    }, [activeItemId, activeTaskSnapshot]);

    const executionById = React.useMemo(
        () => mapRelayHostLocalChecklistExecution({
            items,
            selectedIds,
            activeItemId,
            activeSnapshot: activeTaskSnapshot,
            completedItemIds,
            failedItemIds,
            logsById,
            errorById,
        }),
        [activeItemId, activeTaskSnapshot, completedItemIds, errorById, failedItemIds, items, logsById, selectedIds],
    );
    const executionWithExpandedById = React.useMemo(() => {
        const fallbackExecution = {
            status: 'idle' as const,
            selected: false,
            expanded: false,
            logs: [],
            errorMessage: null,
        };
        return Object.fromEntries(
            items.map((item) => [
                item.id,
                {
                    ...(executionById[item.id] ?? fallbackExecution),
                    expanded: expandedIds.has(item.id),
                },
            ]),
        ) as RelayHostLocalChecklistController['executionById'];
    }, [expandedIds, executionById, items]);

    const toggleItem = React.useCallback((itemId: RelayHostLocalChecklistItemId) => {
        if (phase !== 'select') {
            return;
        }
        setSelectedIds((current) => {
            const item = items.find((entry) => entry.id === itemId);
            if (!item || item.disabled) {
                return current;
            }
            const next = new Set(current);
            if (next.has(itemId)) next.delete(itemId);
            else next.add(itemId);
            return Array.from(next);
        });
    }, [items, phase]);

    const toggleExpanded = React.useCallback((itemId: RelayHostLocalChecklistItemId) => {
        setExpandedIds((current) => {
            const next = new Set(current);
            if (next.has(itemId)) next.delete(itemId);
            else next.add(itemId);
            return next;
        });
    }, []);

    const startExecution = React.useCallback(() => {
        setCompletedItemIds([]);
        setFailedItemIds([]);
        setLogsById({});
        setErrorById({});
        setActiveItemId(null);
        setActiveTaskId(null);
        setExecutionIndex(0);
        setPhase('execute');
    }, []);

    const retry = React.useCallback(() => {
        setCompletedItemIds([]);
        setFailedItemIds([]);
        setLogsById({});
        setErrorById({});
        setActiveItemId(null);
        setActiveTaskId(null);
        setExecutionIndex(0);
        setPhase('execute');
    }, []);

    const cancel = React.useCallback(() => {
        if (activeTaskId) {
            void runner.cancel(activeTaskId);
        }
    }, [activeTaskId, runner]);

    const copyDiagnostics = React.useCallback((itemId: RelayHostLocalChecklistItemId) => {
        const item = items.find((entry) => entry.id === itemId);
        if (!item) return;
        const logs = executionById[itemId]?.logs ?? [];
        const diagnostics = readableDiagnostics({
            itemId,
            status,
            activeRelayUrl: currentRelayUrl,
            shareableUrl: currentShareableUrl,
            logs,
        });
        void setClipboardStringSafe(diagnostics).then((copied) => {
            Modal.alert(
                copied ? t('common.copied') : t('common.error'),
                copied
                    ? t('items.copiedToClipboard', { label: item.title })
                    : t('items.failedToCopyToClipboard'),
            );
        });
    }, [currentRelayUrl, currentShareableUrl, executionById, items, status]);

    React.useEffect(() => {
        if (phase !== 'execute') {
            return;
        }
        if (queue.length === 0) {
            setPhase('done');
        }
    }, [phase, queue.length]);

    return {
        items,
        executionById: Object.freeze({
            installRelayRuntime: executionWithExpandedById.installRelayRuntime,
            startRelayRuntime: executionWithExpandedById.startRelayRuntime,
            enableSecureAccess: executionWithExpandedById.enableSecureAccess,
        }),
        selectedIds,
        phase,
        activeTaskSnapshot,
        toggleItem,
        toggleExpanded,
        startExecution,
        retry,
        copyDiagnostics,
        cancel,
        runner,
        status,
        currentShareableUrl,
        currentRelayUrl,
    };
}
