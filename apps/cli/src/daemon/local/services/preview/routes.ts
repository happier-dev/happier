import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import axios from 'axios';
import type {
    DaemonLocalServicePreviewOpenOrCreateRequestV1,
    DaemonLocalServicePreviewOpenOrCreateResponseV1,
    DaemonLocalServicePreviewRevokeRequestV1,
    DaemonLocalServicePreviewRevokeResponseV1,
    LocalServicePreviewSnapshotV1,
    LocalServicePreviewResourceV1,
} from '@happier-dev/protocol';

import { createLocalServicePreviewServerRoutes, type LocalServicePreviewServerInput } from './serverRoutes';
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
import { localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { startLocalServicePreviewNativeAdapter } from './nativeAdapter';

export type LocalServicePreviewLifecycleResult<TResponse> =
    | Readonly<{ ok: true; response: TResponse }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type LocalServicePreviewRoutes = Readonly<{
    acquireNativeApplication(binding: LocalServicePreviewDirectBindingV1, grantId: string, signal?: AbortSignal): Promise<Readonly<{
        destination: Readonly<{ host: string; port: number }>; signal: AbortSignal; close: () => Promise<void>;
    }>>;
    getSnapshot(): Promise<LocalServicePreviewSnapshotV1>;
    openOrCreate(
        request: DaemonLocalServicePreviewOpenOrCreateRequestV1,
    ): Promise<LocalServicePreviewLifecycleResult<DaemonLocalServicePreviewOpenOrCreateResponseV1>>;
    revoke(
        request: DaemonLocalServicePreviewRevokeRequestV1,
    ): Promise<LocalServicePreviewLifecycleResult<DaemonLocalServicePreviewRevokeResponseV1>>;
}>;

function previewIdForInventoryEntry(accountId: string, machineId: string, sessionId: string | undefined, entryId: string): string {
    return `preview-${createHash('sha256').update(JSON.stringify([accountId, machineId, sessionId ?? null, entryId])).digest('hex')}`;
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
    accountId: string;
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
        previewId: previewIdForInventoryEntry(input.accountId, input.machineId, input.sessionId, input.entry.id),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        machineId: input.machineId,
        owner: input.sessionId
            ? { kind: 'session', id: input.sessionId }
            : { kind: 'user', id: input.accountId },
        target: { scheme: endpoint.scheme, host, port: endpoint.port },
        initialPath: input.initialPath ?? { pathname: '/', search: '' },
        display: { title, addressLabel },
        originMode: 'host',
    };
}

export function createLocalServicePreviewRoutes(input: Readonly<{
    machineId: string;
    accountId?: string;
    server?: LocalServicePreviewServerInput;
    registry: LocalServicePreviewRegistry;
    inventoryRegistry?: LocalServiceInventoryRegistry;
    now?: () => number;
}>): LocalServicePreviewRoutes {
    const now = input.now ?? (() => Date.now());
    const server = input.server ? createLocalServicePreviewServerRoutes(input.server) : null;

    function failureReason(error: unknown): string {
        if (axios.isAxiosError(error) && error.response?.data && typeof error.response.data === 'object') {
            const reason: unknown = error.response.data.reasonCode;
            if (typeof reason === 'string') return reason;
        }
        return 'preview_registration_failed';
    }

    async function publish(resource: LocalServicePreviewResourceV1) {
        try {
            if (!server) throw new Error('preview_server_unavailable');
            const preview = await server.registerPreview(resource);
            input.registry.previewsById.set(resource.previewId, preview);
            return { ok: true as const, preview };
        } catch (error) {
            const reasonCode = server ? failureReason(error) : 'preview_server_unavailable';
            input.registry.previewsById.set(resource.previewId, {
                previewId: resource.previewId,
                resource,
                accessUrl: null,
                expiresAt: null,
                diagnostics: [{ v: 1, code: 'preview_registration_failed', severity: 'error', scope: 'privatePreview', previewId: resource.previewId, details: { reasonCode } }],
            });
            return { ok: false as const, reasonCode };
        }
    }

    function buildSnapshot(): LocalServicePreviewSnapshotV1 {
        const resources = [...listLocalServicePreviewResources(input.registry)]
            .sort((a, b) => a.previewId.localeCompare(b.previewId));
        return {
            v: 1,
            machineId: input.machineId,
            generatedAt: now(),
            refreshState: 'idle',
            resources,
            previews: resources.map((resource) => input.registry.previewsById.get(resource.previewId)!),
            diagnostics: [],
        };
    }

    return {
        async acquireNativeApplication(binding, grantId, signal) {
            const resource = input.registry.previewsById.get(binding.previewId)?.resource;
            if (!server || !resource || binding.machineId !== input.machineId
                || !isDeepStrictEqual(localServicePreviewDirectBindingV1(resource), binding)) {
                throw new Error('preview_registration_unavailable');
            }
            const registration = await server.acquireNativeRegistration(binding, grantId, signal);
            try {
                const current = input.registry.previewsById.get(binding.previewId)?.resource;
                if (!current || !isDeepStrictEqual(localServicePreviewDirectBindingV1(current), binding)) {
                    throw new Error('preview_registration_changed');
                }
                const adapter = await startLocalServicePreviewNativeAdapter({ preview: resource, signal: registration.signal });
                return {
                    destination: { host: '127.0.0.1', port: adapter.port }, signal: registration.signal,
                    close: async () => { registration.close(); await adapter.close(); },
                };
            } catch (error) { registration.close(); throw error; }
        },

        async getSnapshot() {
            // Reads project registration state. Each explicit Open requests its own one-use
            // admission through openOrCreate; observing metadata must not mint credentials.
            return buildSnapshot();
        },

        async openOrCreate(request) {
            if (request.machineId !== input.machineId) {
                return { ok: false, reasonCode: 'wrong_machine' };
            }

            // Already-registered target (managed/launch services register their own preview, or a
            // prior openOrCreate did): return it idempotently rather than double-registering.
            const existingId = request.inventoryEntryId
                ? previewIdForInventoryEntry(input.accountId ?? '', input.machineId, request.sessionId, request.inventoryEntryId)
                : request.launchTargetId ?? request.managedServiceId ?? null;
            if (existingId && !request.inventoryEntryId) {
                const existing = input.registry.previewsById.get(existingId)?.resource;
                if (existing) {
                    if (existing.sessionId !== request.sessionId) return { ok: false, reasonCode: 'preview_session_mismatch' };
                    const published = await publish({ ...existing, initialPath: request.initialPath ?? existing.initialPath });
                    if (!published.ok) return published;
                    return {
                        ok: true,
                        response: {
                            protocolVersion: 1,
                            status: 'existing',
                            preview: published.preview,
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
                accountId: input.accountId ?? '',
                sessionId: request.sessionId,
                initialPath: request.initialPath,
            });
            if (!previewInput) {
                return { ok: false, reasonCode: 'non_loopback_target' };
            }
            if (!input.accountId) return { ok: false, reasonCode: 'preview_account_unavailable' };
            const status = input.registry.previewsById.has(previewInput.previewId) ? 'existing' : 'created';
            const registration = registerLocalServicePreview(input.registry, previewInput);
            if (!registration.ok) {
                return { ok: false, reasonCode: registration.reasonCode };
            }
            const published = await publish(registration.resource);
            if (!published.ok) return published;
            return {
                ok: true,
                response: {
                    protocolVersion: 1,
                    status,
                    preview: published.preview,
                    snapshot: buildSnapshot(),
                },
            };
        },

        async revoke(request) {
            if (request.machineId !== input.machineId) {
                return { ok: false, reasonCode: 'wrong_machine' };
            }
            if (input.registry.previewsById.has(request.previewId)) {
                if (!server) return { ok: false, reasonCode: 'preview_server_unavailable' };
                try { await server.unregisterPreview(request.previewId); }
                catch (error) { return { ok: false, reasonCode: failureReason(error) }; }
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
