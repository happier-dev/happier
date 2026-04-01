import * as React from 'react';

import type { SystemTaskSpec } from '@happier-dev/protocol';

import { useSystemTaskSnapshot } from '../useSystemTaskSnapshot';
import type { SystemTaskRunState, SystemTaskRunner } from '../types';
import type { PlanChecklistExecutionState, PlanChecklistLogEntry } from './types';

function toPlanLogEntries(snapshot: SystemTaskRunState | null): readonly PlanChecklistLogEntry[] {
    if (!snapshot) return [];
    return snapshot.events
        .filter((event) => typeof event.stepId === 'string')
        .map((event, index) => ({
            ts: typeof event.tsMs === 'number' ? event.tsMs : index,
            level: (event.type === 'error' ? 'error' : event.type === 'prompt' ? 'warn' : 'info') as PlanChecklistLogEntry['level'],
            message: typeof event.message === 'string' ? event.message.trim() : '',
        }))
        .filter((entry) => entry.message.length > 0);
}

export function mapSystemTaskSnapshotToPlanChecklistExecutionState(
    snapshot: SystemTaskRunState | null,
    params: Readonly<{ errorTitle: string }>,
): PlanChecklistExecutionState {
    if (!snapshot) {
        return { status: 'idle', logs: [] };
    }
    if (snapshot.result?.ok === true) {
        return { status: 'done', logs: toPlanLogEntries(snapshot) };
    }
    if (snapshot.result && !snapshot.result.ok) {
        const message = snapshot.result.error.message?.trim?.() ?? '';
        return {
            status: 'error',
            logs: toPlanLogEntries(snapshot),
            error: { title: params.errorTitle, ...(message ? { message } : {}) },
        };
    }
    const status: PlanChecklistExecutionState['status'] =
        snapshot.status === 'running' || snapshot.status === 'canceling'
            ? 'running'
            : 'queued';
    return {
        status,
        logs: toPlanLogEntries(snapshot),
    };
}

export type SequentialSystemTaskChecklistExecutionController<Id extends string> = Readonly<{
    activeItemId: Id | null;
    activeTaskId: string | null;
    lastSnapshot: SystemTaskRunState | null;
    errorMessage: string | null;
    start: (queue: readonly Id[]) => void;
    cancel: () => void;
    reset: () => void;
}>;

export function useSequentialSystemTaskChecklistExecution<Id extends string>(params: Readonly<{
    runner: SystemTaskRunner;
    buildSpec: (itemId: Id) => SystemTaskSpec;
    onExecutionStateChange: (update: Partial<Record<Id, PlanChecklistExecutionState>>) => void;
    errorTitle: string;
    mapSnapshotToExecutionState?: (snapshot: SystemTaskRunState | null) => PlanChecklistExecutionState;
}>): SequentialSystemTaskChecklistExecutionController<Id> {
    const buildSpecRef = React.useRef(params.buildSpec);
    const runnerRef = React.useRef(params.runner);
    const errorTitleRef = React.useRef(params.errorTitle);
    const onExecutionStateChangeRef = React.useRef(params.onExecutionStateChange);
    const mapSnapshotOverrideRef = React.useRef(params.mapSnapshotToExecutionState);

    React.useEffect(() => {
        buildSpecRef.current = params.buildSpec;
        runnerRef.current = params.runner;
        errorTitleRef.current = params.errorTitle;
        onExecutionStateChangeRef.current = params.onExecutionStateChange;
        mapSnapshotOverrideRef.current = params.mapSnapshotToExecutionState;
    }, [
        params.buildSpec,
        params.errorTitle,
        params.mapSnapshotToExecutionState,
        params.onExecutionStateChange,
        params.runner,
    ]);

    const mapSnapshot = React.useCallback((snapshot: SystemTaskRunState | null): PlanChecklistExecutionState => {
        const override = mapSnapshotOverrideRef.current;
        if (override) {
            return override(snapshot);
        }
        return mapSystemTaskSnapshotToPlanChecklistExecutionState(snapshot, { errorTitle: errorTitleRef.current });
    }, []);
    const [queue, setQueue] = React.useState<readonly Id[] | null>(null);
    const queueRef = React.useRef<readonly Id[] | null>(null);
    const [index, setIndex] = React.useState(0);
    const [activeItemId, setActiveItemId] = React.useState<Id | null>(null);
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const isStartingRef = React.useRef(false);

    const snapshot = useSystemTaskSnapshot(params.runner, activeTaskId);

    const reset = React.useCallback(() => {
        queueRef.current = null;
        setQueue(null);
        setIndex(0);
        setActiveItemId(null);
        setActiveTaskId(null);
        setErrorMessage(null);
        isStartingRef.current = false;
    }, []);

    const startNext = React.useCallback(async (nextQueue: readonly Id[], nextIndex: number) => {
        if (isStartingRef.current) return;
        if (errorMessage) return;
        const nextItem = nextQueue[nextIndex];
        if (!nextItem) {
            return;
        }
        isStartingRef.current = true;
        setActiveItemId(nextItem);
        try {
            const spec = buildSpecRef.current(nextItem);
            const taskId = await runnerRef.current.start(spec);
            setActiveTaskId(taskId);
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : String(error ?? 'unable_to_start_system_task'));
        } finally {
            isStartingRef.current = false;
        }
    }, [errorMessage]);

    const start = React.useCallback((nextQueue: readonly Id[]) => {
        reset();
        if (nextQueue.length === 0) {
            return;
        }
        queueRef.current = nextQueue;
        setQueue(nextQueue);
        setIndex(0);
        void startNext(nextQueue, 0);
    }, [reset, startNext]);

    React.useEffect(() => {
        if (!queue) return;
        if (errorMessage) return;
        if (activeTaskId) return;
        if (isStartingRef.current) return;
        if (index >= queue.length) return;
        void startNext(queue, index);
    }, [activeTaskId, errorMessage, index, queue, startNext]);

    React.useEffect(() => {
        if (!activeItemId) return;
        onExecutionStateChangeRef.current({ [activeItemId]: mapSnapshot(snapshot) } as Partial<Record<Id, PlanChecklistExecutionState>>);
    }, [activeItemId, mapSnapshot, snapshot]);

    React.useEffect(() => {
        if (!queueRef.current) return;
        if (!activeItemId) return;
        if (!snapshot?.result) return;

        if (snapshot.result.ok) {
            setActiveTaskId(null);
            setActiveItemId(null);
            setIndex((current) => current + 1);
            return;
        }

        setErrorMessage(snapshot.result.error.message || snapshot.result.error.code || 'system_task_failed');
        setActiveTaskId(null);
    }, [activeItemId, snapshot?.result]);

    const cancel = React.useCallback(() => {
        const taskId = activeTaskId;
        if (!taskId) return;
        void runnerRef.current.cancel(taskId);
    }, [activeTaskId]);

    return {
        activeItemId,
        activeTaskId,
        lastSnapshot: snapshot,
        errorMessage,
        start,
        cancel,
        reset,
    };
}
