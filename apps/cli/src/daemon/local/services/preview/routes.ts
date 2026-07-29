import type {
    DaemonLocalServicePreviewOpenOrCreateRequestV1,
    DaemonLocalServicePreviewOpenOrCreateResponseV1,
    DaemonLocalServicePreviewRevokeRequestV1,
    DaemonLocalServicePreviewRevokeResponseV1,
    LocalServicePreviewSnapshotV1,
} from '@happier-dev/protocol';

import {
    projectLocalServicePreviewSnapshotRow,
    projectLocalServicePreviewSnapshotRows,
} from './previewAccessUrlOwner';
import {
    listLocalServicePreviewResources,
    registerLocalServicePreview,
    unregisterLocalServicePreview,
    type LocalServicePreviewRegistry,
    type RegisterLocalServicePreviewInput,
} from './registry';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { buildLocalServiceEndpointUrl } from '../inventory/endpoint';

export type LocalServicePreviewLifecycleResult<TResponse> =
    | Readonly<{ ok: true; response: TResponse }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type LocalServicePreviewRoutes = Readonly<{
    getSnapshot(): Promise<LocalServicePreviewSnapshotV1>;
    openOrCreate(
        request: DaemonLocalServicePreviewOpenOrCreateRequestV1,
    ): Promise<LocalServicePreviewLifecycleResult<DaemonLocalServicePreviewOpenOrCreateResponseV1>>;
    revoke(
        request: DaemonLocalServicePreviewRevokeRequestV1,
    ): Promise<LocalServicePreviewLifecycleResult<DaemonLocalServicePreviewRevokeResponseV1>>;
}>;

function previewIdForInventoryEntry(entryId: string): string {
    return `lsv-preview:inventory:${entryId}`;
}

/**
 * Map a detected loopback listener to the loopback host a private preview embed should load.
 * Loopback entries pass through; a wildcard listener (`0.0.0.0`/`::`) is reachable over
 * loopback so it is normalized to `127.0.0.1`. Anything else (LAN/unknown) is not a private
 * preview and is rejected upstream.
 */
function resolveLoopbackHost(entry: NormalizedLocalServiceInventoryEntry): string | null {
    if (entry.address.kind === 'loopback') return entry.address.host;
    if (entry.address.kind === 'wildcard') return '127.0.0.1';
    return null;
}

function buildInventoryPreviewInput(input: Readonly<{
    entry: NormalizedLocalServiceInventoryEntry;
    machineId: string;
    sessionId: string | undefined;
    initialPath: DaemonLocalServicePreviewOpenOrCreateRequestV1['initialPath'];
}>): RegisterLocalServicePreviewInput | null {
    const host = resolveLoopbackHost(input.entry);
    if (!host) return null;
    const endpoint = input.entry.endpoint;
    if (!endpoint || (endpoint.scheme !== 'http' && endpoint.scheme !== 'https')) return null;
    const addressLabel = input.entry.presentation?.addressLabel ?? `${host}:${input.entry.port}`;
    const title = input.entry.presentation?.displayName
        ?? input.entry.presentation?.pageTitle
        ?? addressLabel;
    return {
        previewId: previewIdForInventoryEntry(input.entry.id),
        sessionId: input.sessionId ?? `machine:${input.machineId}`,
        machineId: input.machineId,
        owner: input.sessionId
            ? { kind: 'session', id: input.sessionId }
            : { kind: 'user', id: input.machineId },
        target: { scheme: endpoint.scheme, host: endpoint.host, port: endpoint.port },
        initialPath: input.initialPath ?? { pathname: '/', search: '' },
        display: { title, addressLabel },
        originMode: 'host',
    };
}

export function createLocalServicePreviewRoutes(input: Readonly<{
    machineId: string;
    registry: LocalServicePreviewRegistry;
    inventoryRegistry?: LocalServiceInventoryRegistry;
    now?: () => number;
}>): LocalServicePreviewRoutes {
    const now = input.now ?? (() => Date.now());

    function buildSnapshot(): LocalServicePreviewSnapshotV1 {
        const resources = [...listLocalServicePreviewResources(input.registry)]
            .sort((a, b) => a.previewId.localeCompare(b.previewId));
        return {
            v: 1,
            machineId: input.machineId,
            generatedAt: now(),
            refreshState: 'idle',
            resources,
            // Canonical render rows: each registered loopback resource projected with its
            // minted private-preview `accessUrl` so the UI embed loads the real dev server.
            previews: [...projectLocalServicePreviewSnapshotRows(resources)],
            diagnostics: [],
        };
    }

    return {
        async getSnapshot() {
            return buildSnapshot();
        },

        async openOrCreate(request) {
            if (request.machineId !== input.machineId) {
                return { ok: false, reasonCode: 'wrong_machine' };
            }

            // Already-registered target (managed/launch services register their own preview, or a
            // prior openOrCreate did): return it idempotently rather than double-registering.
            const existingId = request.inventoryEntryId
                ? previewIdForInventoryEntry(request.inventoryEntryId)
                : request.launchTargetId ?? request.managedServiceId ?? null;
            if (existingId) {
                const existing = input.registry.resourcesById.get(existingId);
                if (existing) {
                    return {
                        ok: true,
                        response: {
                            protocolVersion: 1,
                            status: 'existing',
                            preview: projectLocalServicePreviewSnapshotRow(existing),
                            snapshot: buildSnapshot(),
                        },
                    };
                }
            }

            if (!request.inventoryEntryId) {
                // managed/launch targets that are not already registered have no daemon-resolvable
                // loopback origin here — the managed launch path owns their registration.
                return { ok: false, reasonCode: 'preview_target_unresolved' };
            }
            if (!input.inventoryRegistry) {
                return { ok: false, reasonCode: 'inventory_unavailable' };
            }
            const entry = input.inventoryRegistry.getSnapshot().entries.find((candidate) => (
                candidate.id === request.inventoryEntryId && candidate.machineId === input.machineId
            ));
            if (!entry) {
                return { ok: false, reasonCode: 'unknown_inventory_entry' };
            }
            if (
                (entry.address.kind === 'loopback' || entry.address.kind === 'wildcard')
                && (!entry.endpoint || !buildLocalServiceEndpointUrl(entry.endpoint))
            ) {
                return { ok: false, reasonCode: 'endpoint_scheme_unknown' };
            }
            const previewInput = buildInventoryPreviewInput({
                entry,
                machineId: input.machineId,
                sessionId: request.sessionId,
                initialPath: request.initialPath,
            });
            if (!previewInput) {
                return { ok: false, reasonCode: 'non_loopback_target' };
            }
            const registration = registerLocalServicePreview(input.registry, previewInput);
            if (!registration.ok) {
                return { ok: false, reasonCode: registration.reasonCode };
            }
            return {
                ok: true,
                response: {
                    protocolVersion: 1,
                    status: 'created',
                    preview: projectLocalServicePreviewSnapshotRow(registration.resource),
                    snapshot: buildSnapshot(),
                },
            };
        },

        async revoke(request) {
            if (request.machineId !== input.machineId) {
                return { ok: false, reasonCode: 'wrong_machine' };
            }
            const result = unregisterLocalServicePreview(input.registry, request.previewId);
            return {
                ok: true,
                response: {
                    protocolVersion: 1,
                    previewId: request.previewId,
                    revoked: result.ok,
                    snapshot: buildSnapshot(),
                },
            };
        },
    };
}
