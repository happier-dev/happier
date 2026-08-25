import type { LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';

import { createLocalServicesSharedSubscriptionStore } from '../sharedSubscriptionStore';
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

export const EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE: LocalServicePublicPreviewState = (
    createLocalServicePublicPreviewState()
);

const defaultStatusClient: LocalServicePublicPreviewStatusClient = (input) => (
    fetchLocalServicePublicPreviewStatusViaMachineRpc(input)
);

function normalizeOptionalId(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * SB-A: this was the fifth hand-rolled copy of the shared subscription lifecycle — 245 lines
 * re-implementing entry/refCount/in-flight/abort/notify that the other four local-service domains
 * had already collapsed onto `sharedSubscriptionStore.ts`. It was the only one of the five without
 * the factory import, and its unsubscribe lacked the factory's `subscribed` idempotency guard, so a
 * double unsubscribe decremented `refCount` twice.
 *
 * The one thing the factory genuinely lacked was refresh-on-publish-miss: an entry pinned to a
 * narrower scope than the publication (one `exposureId`) must re-fetch rather than adopt a snapshot
 * describing a different exposure. That is now the factory's `snapshotCoversEntry` hook, so this
 * file is a configuration and no longer a second implementation.
 */
function sameServerAndMachine(
    entry: LocalServicePublicPreviewStoreKeyInput,
    input: LocalServicePublicPreviewStoreKeyInput,
): boolean {
    return entry.machineId === input.machineId
        && (entry.serverId ?? null) === (input.serverId ?? null);
}

const store = createLocalServicesSharedSubscriptionStore<
    LocalServicePublicPreviewStoreKeyInput,
    LocalServicePublicPreviewState,
    LocalServicePublicPreviewSnapshotV1,
    LocalServicePublicPreviewStatusClient
>({
    emptyState: EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE,
    createState: createLocalServicePublicPreviewState,
    normalizeInput: (input) => ({
        machineId: input.machineId,
        serverId: input.serverId ?? null,
        sessionId: normalizeOptionalId(input.sessionId),
        previewId: normalizeOptionalId(input.previewId),
        exposureId: normalizeOptionalId(input.exposureId),
    }),
    storeKey: (input) => [
        input.serverId ?? '',
        input.machineId,
        input.sessionId ?? '',
        input.previewId ?? '',
        input.exposureId ?? '',
    ].join('::'),
    defaultSnapshotClient: defaultStatusClient,
    beginRefresh: (state) => applyLocalServicePublicPreviewRefreshStarted(state),
    refresh: async ({ input, state, snapshotClient, nowMs, signal }) => {
        const result = await snapshotClient({
            request: {
                machineId: input.machineId,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                ...(input.previewId ? { previewId: input.previewId } : {}),
                ...(input.exposureId ? { exposureId: input.exposureId } : {}),
            },
            serverId: input.serverId ?? null,
            signal,
        });
        return result.ok
            ? applyLocalServicePublicPreviewSnapshot(state, result.snapshot)
            : applyLocalServicePublicPreviewRefreshFailed(state);
    },
    failRefresh: (state) => applyLocalServicePublicPreviewRefreshFailed(state),
    applySnapshot: applyLocalServicePublicPreviewSnapshot,
    // Which entries a publication can affect: same server + machine, and no contradicting scope.
    matchesPublish: (entryInput, publishInput) => {
        if (!sameServerAndMachine(entryInput, publishInput)) return false;
        const sessionId = normalizeOptionalId(publishInput.sessionId);
        const previewId = normalizeOptionalId(publishInput.previewId);
        const exposureId = normalizeOptionalId(publishInput.exposureId);
        return (!entryInput.sessionId || !sessionId || entryInput.sessionId === sessionId)
            && (!entryInput.previewId || !previewId || entryInput.previewId === previewId)
            && (!entryInput.exposureId || !exposureId || entryInput.exposureId === exposureId);
    },
    // Whether the payload actually describes this entry. A miss refreshes instead of applying.
    snapshotCoversEntry: (entryInput, snapshot) => {
        if (entryInput.machineId !== snapshot.machineId) return false;
        if (snapshot.sessionId && entryInput.sessionId !== snapshot.sessionId) return false;
        if (snapshot.previewId && entryInput.previewId !== snapshot.previewId) return false;
        if (entryInput.exposureId) {
            return snapshot.exposures.length > 0
                && snapshot.exposures.every((exposure) => exposure.exposureId === entryInput.exposureId);
        }
        return true;
    },
});

export type SubscribeLocalServicePublicPreviewStoreOptions = Readonly<{
    statusClient?: LocalServicePublicPreviewStatusClient;
    nowMs?: () => number;
}>;

export function getLocalServicePublicPreviewState(
    input: LocalServicePublicPreviewStoreKeyInput,
): LocalServicePublicPreviewState {
    return store.getState(input);
}

export function subscribeLocalServicePublicPreviewStore(
    input: LocalServicePublicPreviewStoreKeyInput,
    listener: () => void,
    options?: SubscribeLocalServicePublicPreviewStoreOptions,
): () => void {
    return store.subscribe(input, listener, {
        ...(options?.statusClient ? { snapshotClient: options.statusClient } : {}),
        ...(options?.nowMs ? { nowMs: options.nowMs } : {}),
    });
}

export function invalidateLocalServicePublicPreviewStore(
    input: LocalServicePublicPreviewStoreKeyInput,
): void {
    store.invalidate(input);
}

export function publishLocalServicePublicPreviewSnapshot(
    input: LocalServicePublicPreviewStoreKeyInput,
    snapshot: LocalServicePublicPreviewSnapshotV1,
): void {
    store.publish(input, snapshot);
}

export function resetLocalServicePublicPreviewStoreForTests(): void {
    store.reset();
}
