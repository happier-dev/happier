import * as React from 'react';
import { useRouter } from 'expo-router';
import {
    SessionMcpSelectionV1Schema,
    readSessionMcpSelectionV1FromMetadata,
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { Modal } from '@/modal';
import { computeNextSessionMcpSelectionMetadata } from '@/sync/engine/overrides/sessionMcpSelectionPublish';
import { sync } from '@/sync/sync';
import { t } from '@/text';

const DEFAULT_MCP_SELECTION = SessionMcpSelectionV1Schema.parse({});

function selectionKey(selection: SessionMcpSelectionV1): string {
    return JSON.stringify(selection);
}

export function shouldShowExistingSessionMcpChip(params: Readonly<{
    isReadOnly: boolean;
    sessionActive: boolean;
}>): boolean {
    return !params.isReadOnly;
}

export function resolveExistingSessionMcpSelectionRollback(params: Readonly<{
    failedSelectionKey: string;
    pendingSelectionKey: string | null;
    persistedSelection: SessionMcpSelectionV1;
}>): SessionMcpSelectionV1 | null {
    return params.pendingSelectionKey === params.failedSelectionKey ? params.persistedSelection : null;
}

export function useExistingSessionMcpSelection(params: Readonly<{
    sessionId: string;
    sessionMetadata: unknown;
    machineId: string | null;
    directory: string;
    agentId: AgentId;
    serverId?: string | null;
    isReadOnly: boolean;
    sessionActive: boolean;
}>): AgentInputExtraActionChip | null {
    const router = useRouter();
    const persistedSelection = React.useMemo(
        () => readSessionMcpSelectionV1FromMetadata(params.sessionMetadata) ?? DEFAULT_MCP_SELECTION,
        [params.sessionMetadata],
    );
    const persistedSelectionRef = React.useRef(persistedSelection);
    persistedSelectionRef.current = persistedSelection;
    const [optimisticSelection, setOptimisticSelection] = React.useState(persistedSelection);
    const optimisticSelectionRef = React.useRef(optimisticSelection);
    optimisticSelectionRef.current = optimisticSelection;
    const pendingSelectionKeyRef = React.useRef<string | null>(null);
    const writeQueueRef = React.useRef<Promise<void>>(Promise.resolve());

    React.useEffect(() => {
        const incomingKey = selectionKey(persistedSelection);
        if (pendingSelectionKeyRef.current && pendingSelectionKeyRef.current !== incomingKey) return;
        pendingSelectionKeyRef.current = null;
        setOptimisticSelection((current) => selectionKey(current) === incomingKey ? current : persistedSelection);
    }, [persistedSelection]);

    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>>((nextValue) => {
        if (params.isReadOnly) return;
        const previous = optimisticSelectionRef.current;
        const next = SessionMcpSelectionV1Schema.parse(
            typeof nextValue === 'function' ? nextValue(previous) : nextValue,
        );
        const nextKey = selectionKey(next);
        if (nextKey === selectionKey(previous)) return;

        optimisticSelectionRef.current = next;
        pendingSelectionKeyRef.current = nextKey;
        setOptimisticSelection(next);

        writeQueueRef.current = writeQueueRef.current
            .catch(() => undefined)
            .then(async () => {
                await sync.patchSessionMetadataWithRetry(
                    params.sessionId,
                    (metadata) => computeNextSessionMcpSelectionMetadata(metadata, next, {
                        sessionActive: params.sessionActive,
                    }),
                    { serverId: params.serverId ?? null },
                );
            })
            .catch(() => {
                const rollback = resolveExistingSessionMcpSelectionRollback({
                    failedSelectionKey: nextKey,
                    pendingSelectionKey: pendingSelectionKeyRef.current,
                    persistedSelection: persistedSelectionRef.current,
                });
                if (!rollback) return;
                pendingSelectionKeyRef.current = null;
                optimisticSelectionRef.current = rollback;
                setOptimisticSelection(rollback);
                Modal.alert(t('common.error'), t('errors.operationFailed'));
            });
    }, [params.isReadOnly, params.serverId, params.sessionActive, params.sessionId]);

    const selection = useNewSessionMcpSelection({
        selectedMachineId: params.machineId,
        selectedPath: params.directory,
        agentType: params.agentId,
        targetServerId: params.serverId ?? null,
        mcpSelection: optimisticSelection,
        setMcpSelection: setSelection,
        onOpenSettings: () => router.push('/settings/mcp'),
    });

    return shouldShowExistingSessionMcpChip(params) ? selection.mcpChip : null;
}
