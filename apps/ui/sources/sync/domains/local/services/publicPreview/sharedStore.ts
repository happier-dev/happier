import type {
    LocalServicePublicPreviewStatusClientInput,
    LocalServicePublicPreviewStatusClientResult,
} from './api';
import { fetchLocalServicePublicPreviewStatusViaMachineRpc } from './machineRpc';
import {
    applyLocalServicePublicPreviewRefreshFailed,
    applyLocalServicePublicPreviewRefreshStarted,
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
    type LocalServicePublicPreviewState,
} from './store';
import type { LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';

export type LocalServicePublicPreviewStatusClient = (
    input: LocalServicePublicPreviewStatusClientInput,
) => Promise<LocalServicePublicPreviewStatusClientResult>;

export type LocalServicePublicPreviewStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    previewId?: string | null;
    exposureId?: string | null;
}>;

type PublicPreviewStoreEntry = {
    readonly machineId: string;
    readonly serverId: string | null;
    readonly sessionId: string | null;
    readonly previewId: string | null;
    readonly exposureId: string | null;
    state: LocalServicePublicPreviewState;
    statusClient: LocalServicePublicPreviewStatusClient;
    readonly listeners: Set<() => void>;
    refCount: number;
    inFlight: boolean;
    abortController: AbortController | null;
    nowMs: () => number;
};

export const EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE: LocalServicePublicPreviewState = (
    createLocalServicePublicPreviewState()
);

const defaultStatusClient: LocalServicePublicPreviewStatusClient = (input) => (
    fetchLocalServicePublicPreviewStatusViaMachineRpc(input)
);

const entries = new Map<string, PublicPreviewStoreEntry>();

function normalizeOptionalId(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

function storeKey(input: LocalServicePublicPreviewStoreKeyInput): string {
    return [
        input.serverId ?? '',
        input.machineId,
        normalizeOptionalId(input.sessionId) ?? '',
        normalizeOptionalId(input.previewId) ?? '',
        normalizeOptionalId(input.exposureId) ?? '',
    ].join('::');
}

function notify(entry: PublicPreviewStoreEntry): void {
    for (const listener of entry.listeners) {
        listener();
    }
}

function setState(entry: PublicPreviewStoreEntry, next: LocalServicePublicPreviewState): void {
    if (entry.state === next) {
        return;
    }
    entry.state = next;
    notify(entry);
}

function ensureEntry(
    key: string,
    input: LocalServicePublicPreviewStoreKeyInput,
    options?: Readonly<{ statusClient?: LocalServicePublicPreviewStatusClient; nowMs?: () => number }>,
): PublicPreviewStoreEntry {
    let entry = entries.get(key);
    if (!entry) {
        entry = {
            machineId: input.machineId,
            serverId: input.serverId ?? null,
            sessionId: normalizeOptionalId(input.sessionId),
            previewId: normalizeOptionalId(input.previewId),
            exposureId: normalizeOptionalId(input.exposureId),
            state: createLocalServicePublicPreviewState(),
            statusClient: options?.statusClient ?? defaultStatusClient,
            listeners: new Set(),
            refCount: 0,
            inFlight: false,
            abortController: null,
            nowMs: options?.nowMs ?? Date.now,
        };
        entries.set(key, entry);
    } else {
        if (options?.statusClient) {
            entry.statusClient = options.statusClient;
        }
        if (options?.nowMs) {
            entry.nowMs = options.nowMs;
        }
    }
    return entry;
}

async function runRefresh(entry: PublicPreviewStoreEntry): Promise<void> {
    if (entry.inFlight) {
        return;
    }
    entry.inFlight = true;
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    entry.abortController = abortController;
    setState(entry, applyLocalServicePublicPreviewRefreshStarted(entry.state, entry.nowMs()));
    const result = await entry.statusClient({
        request: {
            machineId: entry.machineId,
            ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
            ...(entry.previewId ? { previewId: entry.previewId } : {}),
            ...(entry.exposureId ? { exposureId: entry.exposureId } : {}),
        },
        serverId: entry.serverId,
        signal: abortController?.signal,
    });
    entry.inFlight = false;
    if (abortController?.signal.aborted) {
        return;
    }
    entry.abortController = null;
    setState(
        entry,
        result.ok
            ? applyLocalServicePublicPreviewSnapshot(entry.state, result.snapshot)
            : applyLocalServicePublicPreviewRefreshFailed(entry.state, entry.nowMs()),
    );
}

export function getLocalServicePublicPreviewState(
    input: LocalServicePublicPreviewStoreKeyInput,
): LocalServicePublicPreviewState {
    return entries.get(storeKey(input))?.state ?? EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE;
}

export type SubscribeLocalServicePublicPreviewStoreOptions = Readonly<{
    statusClient?: LocalServicePublicPreviewStatusClient;
    nowMs?: () => number;
}>;

export function subscribeLocalServicePublicPreviewStore(
    input: LocalServicePublicPreviewStoreKeyInput,
    listener: () => void,
    options?: SubscribeLocalServicePublicPreviewStoreOptions,
): () => void {
    const key = storeKey(input);
    const entry = ensureEntry(key, input, options);
    entry.listeners.add(listener);
    entry.refCount += 1;
    if (entry.refCount === 1) {
        void runRefresh(entry);
    }
    return () => {
        entry.listeners.delete(listener);
        entry.refCount -= 1;
        if (entry.refCount <= 0) {
            entry.abortController?.abort();
            entries.delete(key);
        }
    };
}

export function invalidateLocalServicePublicPreviewStore(
    input: LocalServicePublicPreviewStoreKeyInput,
): void {
    const entry = entries.get(storeKey(input));
    if (entry) {
        void runRefresh(entry);
    }
}

function sameServerAndMachine(
    entry: PublicPreviewStoreEntry,
    input: LocalServicePublicPreviewStoreKeyInput,
): boolean {
    return entry.machineId === input.machineId
        && entry.serverId === (input.serverId ?? null);
}

function publicationCanAffectEntry(
    entry: PublicPreviewStoreEntry,
    input: LocalServicePublicPreviewStoreKeyInput,
): boolean {
    if (!sameServerAndMachine(entry, input)) return false;
    const sessionId = normalizeOptionalId(input.sessionId);
    const previewId = normalizeOptionalId(input.previewId);
    const exposureId = normalizeOptionalId(input.exposureId);
    return (!entry.sessionId || !sessionId || entry.sessionId === sessionId)
        && (!entry.previewId || !previewId || entry.previewId === previewId)
        && (!entry.exposureId || !exposureId || entry.exposureId === exposureId);
}

function snapshotCoversEntry(
    entry: PublicPreviewStoreEntry,
    snapshot: LocalServicePublicPreviewSnapshotV1,
): boolean {
    if (entry.machineId !== snapshot.machineId) return false;
    if (snapshot.sessionId && entry.sessionId !== snapshot.sessionId) return false;
    if (entry.sessionId && snapshot.sessionId && entry.sessionId !== snapshot.sessionId) return false;
    if (snapshot.previewId && entry.previewId !== snapshot.previewId) return false;
    if (entry.previewId && snapshot.previewId && entry.previewId !== snapshot.previewId) return false;
    if (entry.exposureId) {
        return snapshot.exposures.length > 0
            && snapshot.exposures.every((exposure) => exposure.exposureId === entry.exposureId);
    }
    return true;
}

export function publishLocalServicePublicPreviewSnapshot(
    input: LocalServicePublicPreviewStoreKeyInput,
    snapshot: LocalServicePublicPreviewSnapshotV1,
): void {
    for (const entry of entries.values()) {
        if (!publicationCanAffectEntry(entry, input)) {
            continue;
        }
        if (snapshotCoversEntry(entry, snapshot)) {
            setState(entry, applyLocalServicePublicPreviewSnapshot(entry.state, snapshot));
            continue;
        }
        void runRefresh(entry);
    }
}

export function resetLocalServicePublicPreviewStoreForTests(): void {
    for (const entry of entries.values()) {
        entry.abortController?.abort();
    }
    entries.clear();
}
