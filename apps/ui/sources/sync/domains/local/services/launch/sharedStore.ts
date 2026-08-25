import { createLocalServicesSharedSubscriptionStore } from '../sharedSubscriptionStore';
import {
    type LocalServiceLauncherSnapshotClientInput,
    type LocalServiceLauncherSnapshotClientResult,
} from './api';
import { fetchLocalServiceLauncherSnapshotViaMachineRpc } from './machineRpc';
import {
    applyLocalServiceLauncherRefreshStarted,
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    failLocalServiceLauncherRefresh,
} from './store';
import type { LocalServiceLauncherSnapshot, LocalServiceLauncherState } from './types';

export type LocalServiceLauncherSnapshotClient = (
    input: LocalServiceLauncherSnapshotClientInput,
) => Promise<LocalServiceLauncherSnapshotClientResult>;

export type LocalServiceLauncherStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    scope?: 'workspace' | 'machine' | null;
    workspaceRoot?: string | null;
}>;

type NormalizedLocalServiceLauncherStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
    sessionId: string | null;
    scope: 'workspace' | 'machine' | null;
    workspaceRoot: string | null;
}>;

export const EMPTY_LOCAL_SERVICE_LAUNCHER_STATE: LocalServiceLauncherState = createLocalServiceLauncherState();

const defaultSnapshotClient: LocalServiceLauncherSnapshotClient = (input) => (
    fetchLocalServiceLauncherSnapshotViaMachineRpc(input)
);

function normalizeInput(input: LocalServiceLauncherStoreKeyInput): NormalizedLocalServiceLauncherStoreKeyInput {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? null,
        sessionId: input.sessionId ?? null,
        scope: input.scope ?? null,
        workspaceRoot: input.workspaceRoot ?? null,
    };
}

function storeKey(input: LocalServiceLauncherStoreKeyInput): string {
    return [
        input.serverId ?? '',
        input.machineId,
        input.sessionId ?? '',
        input.scope ?? '',
        input.workspaceRoot ?? '',
    ].join('::');
}

function entryMatches(
    entryInput: LocalServiceLauncherStoreKeyInput,
    publishInput: LocalServiceLauncherStoreKeyInput,
): boolean {
    const entry = normalizeInput(entryInput);
    return entry.machineId === publishInput.machineId
        && (publishInput.serverId === undefined || entry.serverId === (publishInput.serverId ?? null))
        && (publishInput.sessionId === undefined || entry.sessionId === (publishInput.sessionId ?? null))
        && (publishInput.scope === undefined || entry.scope === (publishInput.scope ?? null))
        && (publishInput.workspaceRoot === undefined || entry.workspaceRoot === (publishInput.workspaceRoot ?? null));
}

function failRefresh(
    state: LocalServiceLauncherState,
    input: NormalizedLocalServiceLauncherStoreKeyInput,
    reasonCode: string,
): LocalServiceLauncherState {
    return failLocalServiceLauncherRefresh(state, {
        machineId: input.machineId,
        sessionId: input.sessionId ?? undefined,
        reasonCode,
    });
}

const store = createLocalServicesSharedSubscriptionStore<
    LocalServiceLauncherStoreKeyInput,
    LocalServiceLauncherState,
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherSnapshotClient
>({
    emptyState: EMPTY_LOCAL_SERVICE_LAUNCHER_STATE,
    createState: createLocalServiceLauncherState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    beginRefresh: (state, input) => {
        const normalized = normalizeInput(input);
        return applyLocalServiceLauncherRefreshStarted(state, {
            machineId: normalized.machineId,
            sessionId: normalized.sessionId ?? undefined,
        });
    },
    refresh: async ({ input, state, snapshotClient, signal }) => {
        const normalized = normalizeInput(input);
        const result = await snapshotClient({
            machineId: normalized.machineId,
            serverId: normalized.serverId,
            sessionId: normalized.sessionId,
            scope: normalized.scope,
            workspaceRoot: normalized.workspaceRoot,
            signal,
        });
        return result.ok
            ? applyLocalServiceLauncherSnapshot(state, result.snapshot)
            : failRefresh(state, normalized, result.reason);
    },
    failRefresh: (state, input) => (
        failRefresh(state, normalizeInput(input), 'request_failed')
    ),
    applySnapshot: applyLocalServiceLauncherSnapshot,
    matchesPublish: entryMatches,
});

export function getLocalServiceLauncherState(
    input: LocalServiceLauncherStoreKeyInput,
): LocalServiceLauncherState {
    return store.getState(input);
}

export function subscribeLocalServiceLauncherStore(
    input: LocalServiceLauncherStoreKeyInput,
    listener: () => void,
    options?: Readonly<{ snapshotClient?: LocalServiceLauncherSnapshotClient; nowMs?: () => number }>,
): () => void {
    return store.subscribe(input, listener, options);
}

export function invalidateLocalServiceLauncherStore(input: LocalServiceLauncherStoreKeyInput): void {
    store.invalidate(input);
}

export function publishLocalServiceLauncherSnapshot(
    input: LocalServiceLauncherStoreKeyInput,
    snapshot: LocalServiceLauncherSnapshot,
): void {
    store.publish(input, snapshot);
}

export function resetLocalServiceLauncherStoreForTests(): void {
    store.reset();
}
