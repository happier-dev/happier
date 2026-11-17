import { isDeepStrictEqual } from 'node:util';
import axios from '@/api/client/credentialAxios';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';
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
    previewIdForInventoryEntry,
    registerLocalServicePreview,
    resolveLocalServicePreviewApplication,
    selectLocalServicePreviewForInventoryEntry,
    unregisterLocalServicePreview,
    type LocalServicePreviewRegistry,
    type RegisterLocalServicePreviewInput,
} from './registry';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { buildLocalServiceEndpointUrl, type LocalServiceEndpointEnricher } from '../inventory/endpoint';
import { localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { startLocalServicePreviewNativeAdapter } from './nativeAdapter';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { admitLocalServicePreviewRequest } from './requester';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { matchesProjectManagedServiceTarget } from '@/plugins/runtime/invocation/services/projectServiceResolution';
import { readProjectManagedServicePreviewEndpoint } from './projectEndpoint';
import { isProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { formatLocalServiceLauncherTitle } from '../launch/suggestions';
import { readProcessCensus } from '@/processes/census/processCensus';
import { scanPlatformLocalServices } from '../inventory/platform/scan';
import { normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';

export type LocalServicePreviewLifecycleResult<TResponse> =
    | Readonly<{ ok: true; response: TResponse }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type LocalServicePreviewRoutes = Readonly<{
    resolveApplication(binding: LocalServicePreviewDirectBindingV1): Promise<LocalServicePreviewResourceV1>;
    acquireNativeApplication(binding: LocalServicePreviewDirectBindingV1, grantId: string, signal?: AbortSignal): Promise<Readonly<{
        destination: Readonly<{ host: string; port: number }>; signal: AbortSignal; close: () => Promise<void>;
    }>>;
    getSnapshot(context?: RpcHandlerContext): Promise<LocalServicePreviewSnapshotV1>;
    openOrCreate(
        request: DaemonLocalServicePreviewOpenOrCreateRequestV1,
        signal?: AbortSignal,
        context?: RpcHandlerContext,
    ): Promise<LocalServicePreviewLifecycleResult<DaemonLocalServicePreviewOpenOrCreateResponseV1>>;
    revoke(
        request: DaemonLocalServicePreviewRevokeRequestV1,
        context?: RpcHandlerContext,
    ): Promise<LocalServicePreviewLifecycleResult<DaemonLocalServicePreviewRevokeResponseV1>>;
}>;

/**
 * Bind a detected listener using the canonical endpoint owner's observed scheme/loopback host.
 * LAN/unknown addresses are outside private-preview discovery.
 */
function buildInventoryPreviewInput(input: Readonly<{
    entry: NormalizedLocalServiceInventoryEntry;
    machineId: string;
    accountId: string;
    sessionId: string | undefined;
    initialPath: DaemonLocalServicePreviewOpenOrCreateRequestV1['initialPath'];
}>): RegisterLocalServicePreviewInput | null {
    if (input.entry.address.kind !== 'loopback' && input.entry.address.kind !== 'wildcard') return null;
    const endpoint = input.entry.endpoint;
    if (!endpoint || (endpoint.scheme !== 'http' && endpoint.scheme !== 'https')) return null;
    const host = endpoint.host;
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
    serverId?: string;
    accountId?: string;
    server?: LocalServicePreviewServerInput;
    registry: LocalServicePreviewRegistry;
    inventoryRegistry?: LocalServiceInventoryRegistry;
    projectManagedServices?: Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectService'>
        & Partial<Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectServiceDeclaration'>>;
    endpointEnricher?: LocalServiceEndpointEnricher;
    signal?: AbortSignal;
    now?: () => number;
}>): LocalServicePreviewRoutes {
    const now = input.now ?? (() => Date.now());
    const server = input.server ? createLocalServicePreviewServerRoutes(input.server) : null;
    const admitRequest = (context: RpcHandlerContext | undefined, effect: boolean) => admitLocalServicePreviewRequest({
        accountId: input.accountId, machineId: input.machineId, serverId: input.serverId, server: input.server,
        projectManagedServices: input.projectManagedServices, context, effect,
    });
    type Admission = Awaited<ReturnType<typeof admitRequest>>;

    function failureReason(error: unknown): string {
        if (error instanceof Error && (error.message === 'requester_credentials_unavailable' || error.message === 'preview_target_unresolved')) return error.message;
        if (axios.isAxiosError(error) && error.response?.data && typeof error.response.data === 'object') {
            const reason: unknown = error.response.data.reasonCode;
            if (typeof reason === 'string') return reason;
        }
        return 'preview_registration_failed';
    }

    async function publish(admission: Admission, resource: LocalServicePreviewResourceV1, signal?: AbortSignal, context?: RpcHandlerContext, isCurrent?: () => boolean) {
        const registration = input.registry.previewsById.get(resource.previewId);
        const occurrence = registration?.occurrence;
        // A server reply belongs to the registration that requested it. Revoke or
        // replacement during either await must not resurrect or overwrite a row.
        const stillRegistered = () => registration !== undefined
            && input.registry.previewsById.get(resource.previewId) === registration
            && registration.occurrence === occurrence;
        try {
            if (!admission.server) throw new Error('preview_server_unavailable');
            signal?.throwIfAborted();
            if (!stillRegistered() || occurrence?.ended || isCurrent && !isCurrent()) throw new Error('preview_target_unresolved');
            const preview = await admission.server.registerPreview(resource, signal);
            signal?.throwIfAborted();
            context?.signal.throwIfAborted();
            if (!stillRegistered() || occurrence?.ended || isCurrent && !isCurrent()) throw new Error('preview_target_unresolved');
            // Viewer credentials belong only to this Open's reply, never the shared Machine projection.
            input.registry.previewsById.set(resource.previewId, { ...preview,
                ...(admission.requesterOnly ? { accessUrl: null, expiresAt: null } : {}), ...(occurrence ? { occurrence } : {}) });
            return { ok: true as const, preview };
        } catch (error) {
            signal?.throwIfAborted();
            context?.signal.throwIfAborted();
            if (!stillRegistered() || occurrence?.ended) return { ok: false as const, reasonCode: 'preview_target_unresolved' };
            logger.warnLocalFile('[local-service] Preview publication failed', projectActionFailureCauseV1(error, 'local_service.preview.publish', { allowUnknownErrorCode: false }));
            const reasonCode = admission.server ? failureReason(error) : 'preview_server_unavailable';
            input.registry.previewsById.set(resource.previewId, {
                ...(occurrence ? { occurrence } : {}),
                previewId: resource.previewId,
                resource,
                accessUrl: null,
                expiresAt: null,
                diagnostics: [{ v: 1, code: 'preview_registration_failed', severity: 'error', scope: 'privatePreview', previewId: resource.previewId, details: { reasonCode } }],
            });
            return { ok: false as const, reasonCode };
        }
    }

    async function buildSnapshot(admission: Admission): Promise<LocalServicePreviewSnapshotV1> {
        const resources = [...await admission.selectResources(listLocalServicePreviewResources(input.registry))]
            .sort((a, b) => a.previewId.localeCompare(b.previewId));
        return {
            v: 1,
            machineId: input.machineId,
            generatedAt: now(),
            refreshState: 'idle',
            resources,
            previews: resources.map((resource) => {
                const { occurrence: _occurrence, ...row } = input.registry.previewsById.get(resource.previewId)!;
                return admission.requesterOnly ? { ...row, accessUrl: null, expiresAt: null } : row;
            }),
            diagnostics: [],
        };
    }

    return {
        resolveApplication: binding => resolveLocalServicePreviewApplication(input.registry, binding),
        async acquireNativeApplication(binding, grantId, signal) {
            const resource = await resolveLocalServicePreviewApplication(input.registry, binding);
            if (!server || !resource || binding.machineId !== input.machineId
                || !isDeepStrictEqual(localServicePreviewDirectBindingV1(resource), binding)) {
                throw new Error('preview_registration_unavailable');
            }
            const registration = await server.acquireNativeRegistration(binding, grantId, signal);
            try {
                const current = await resolveLocalServicePreviewApplication(input.registry, binding);
                if (!current || !isDeepStrictEqual(localServicePreviewDirectBindingV1(current), binding)) {
                    throw new Error('preview_registration_changed');
                }
                const adapter = await startLocalServicePreviewNativeAdapter({ preview: resource, signal: registration.signal,
                    resolvePreview: () => resolveLocalServicePreviewApplication(input.registry, binding) });
                return {
                    destination: { host: '127.0.0.1', port: adapter.port }, signal: registration.signal,
                    close: async () => { registration.close(); await adapter.close(); },
                };
            } catch (error) { registration.close(); throw error; }
        },

        async getSnapshot(context) {
            const admission = await admitRequest(context, false);
            // Reads project registration state. Each explicit Open requests its own one-use
            // admission through openOrCreate; observing metadata must not mint credentials.
            return await buildSnapshot(admission);
        },

        async openOrCreate(request, signal, context) {
            let admission: Admission;
            try { admission = await admitRequest(context, true); }
            catch { return { ok: false, reasonCode: 'requester_credentials_unavailable' }; }
            if (input.signal) signal = signal ? AbortSignal.any([input.signal, signal]) : input.signal;
            signal?.throwIfAborted();
            if (request.machineId !== input.machineId) {
                return { ok: false, reasonCode: 'wrong_machine' };
            }

            if (request.launchTargetId && !request.serviceTarget) {
                const declaration = input.projectManagedServices?.resolveProjectServiceDeclaration?.(request.launchTargetId);
                if (!declaration && isProjectServiceDeclarationTargetIdV1(request.launchTargetId)) return { ok: false, reasonCode: 'service_not_listening' };
                if (declaration?.kind === 'workspace') request = { ...request, serviceTarget: {
                    kind: 'managed_service', managedServiceId: declaration.instanceId, machineId: declaration.workspace.machineId,
                    workspaceId: declaration.workspace.id, cwd: declaration.cwd, declaration: declaration.declaration,
                } };
            }

            if (request.serviceTarget) {
                const requestedServiceTarget = request.serviceTarget;
                if (!await admission.canAccess(requestedServiceTarget)) return { ok: false, reasonCode: 'unknown_managed_service' };
                if (request.sessionId !== undefined) return { ok: false, reasonCode: 'preview_target_unresolved' };
                const resolved = input.projectManagedServices?.resolveProjectService(requestedServiceTarget);
                if (resolved?.status === 'stale') return { ok: false, reasonCode: 'stale_service' };
                if (resolved?.status === 'unknown') return { ok: false, reasonCode: 'unknown_managed_service' };
                if (resolved?.status !== 'found') return { ok: false, reasonCode: 'preview_target_unresolved' };
                const handle = resolved.handle;
                if (handle.kind !== 'workspace') return { ok: false, reasonCode: 'preview_target_unresolved' };
                const endpoint = readProjectManagedServicePreviewEndpoint(handle);
                if (!endpoint) return { ok: false, reasonCode: request.launchTargetId
                    ? 'service_not_listening' : 'preview_target_unresolved' };
                const serviceTarget = { kind: 'managed_service' as const, managedServiceId: handle.instanceId,
                    machineId: handle.workspace.machineId, workspaceId: handle.workspace.id,
                    cwd: handle.cwd, declaration: handle.declaration };
                const existing = listLocalServicePreviewResources(input.registry).find(resource =>
                    resource.machineId === input.machineId && resource.previewId === handle.instanceId
                    && resource.serviceTarget && matchesProjectManagedServiceTarget(resource.serviceTarget, serviceTarget));
                const current = () => {
                    const latest = input.projectManagedServices?.resolveProjectService(serviceTarget);
                    return latest?.status === 'found' && latest.handle === handle
                        && isDeepStrictEqual(readProjectManagedServicePreviewEndpoint(handle), endpoint);
                };
                const selection = handle.declaration.selection;
                const registration = registerLocalServicePreview(input.registry, {
                    previewId: existing?.previewId ?? handle.instanceId,
                    // Existing server registrations retain their original immutable binding.
                    machineId: input.machineId, serviceTarget: existing?.serviceTarget ?? serviceTarget,
                    browserTarget: { kind: 'localServicePreview', targetId: handle.serviceId, machineId: input.machineId,
                        display: { title: formatLocalServiceLauncherTitle(handle.declaration.selection.kind === 'manifest'
                            ? handle.declaration.selection.name : handle.declaration.selection.source.target) } },
                    owner: { kind: 'user', id: handle.requester.accountId }, target: endpoint,
                    initialPath: request.initialPath ?? existing?.initialPath ?? { pathname: '/', search: '' },
                    display: existing?.display ?? { title: formatLocalServiceLauncherTitle(selection.kind === 'manifest' ? selection.name : selection.source.target),
                        addressLabel: `${endpoint.host === '::1' ? '[::1]' : endpoint.host}:${endpoint.port}` },
                    originMode: 'host', ...(existing?.policy ? { policy: existing.policy } : {}),
                }, { async isCurrent(observation) {
                    if (!handle.isCurrent() || handle.retirementSignal.aborted) return false;
                    // Native adapters (including external plugins) supply lifecycle
                    // evidence through the existing managed-process owner, not HTTP
                    // health or endpoint equality. Unknown inspection fails closed.
                    const snapshot = observation === 'retained' ? handle.snapshot() : await handle.inspectCurrentOccurrence();
                    if (snapshot.mode === 'native' && snapshot.nativePhase === 'unknown') {
                        throw Object.assign(new Error('preview_target_unresolved'), { reasonCode: 'preview_target_unresolved' });
                    }
                    if (!handle.isServing()) return false;
                    return current();
                } });
                if (!registration.ok) return { ok: false, reasonCode: registration.reasonCode };
                const published = await publish(admission, registration.resource, signal, context, current);
                if (!published.ok) return published;
                return { ok: true, response: { protocolVersion: 1, status: existing ? 'existing' : 'created', preview: published.preview, snapshot: await buildSnapshot(admission) } };
            }

            // Already-registered target (managed/launch services register their own preview, or a
            // prior openOrCreate did): return it idempotently rather than double-registering.
            const existingId = request.launchTargetId ?? request.managedServiceId;
            if (existingId) {
                const existing = input.registry.previewsById.get(existingId)?.resource;
                if (existing) {
                    if (!await admission.canAccess(existing.serviceTarget)) return { ok: false, reasonCode: 'unknown_managed_service' };
                    if (existing.sessionId !== request.sessionId) return { ok: false, reasonCode: 'preview_session_mismatch' };
                    const published = await publish(admission, { ...existing, initialPath: request.initialPath ?? existing.initialPath }, signal, context);
                    if (!published.ok) return published;
                    return {
                        ok: true,
                        response: {
                            protocolVersion: 1,
                            status: 'existing',
                            preview: published.preview,
                            snapshot: await buildSnapshot(admission),
                        },
                    };
                }
            }

            if (admission.requesterOnly) return { ok: false, reasonCode: 'unknown_inventory_entry' };
            if (!request.inventoryEntryId) {
                // managed/launch targets that are not already registered have no daemon-resolvable
                // loopback origin here — the managed launch path owns their registration.
                return { ok: false, reasonCode: 'preview_target_unresolved' };
            }
            if (!input.inventoryRegistry) {
                return { ok: false, reasonCode: 'inventory_unavailable' };
            }
            let entry = input.inventoryRegistry.getSnapshot().entries.find((candidate) => (
                candidate.id === request.inventoryEntryId && candidate.machineId === input.machineId
            ));
            if (!entry) {
                return { ok: false, reasonCode: 'unknown_inventory_entry' };
            }
            if (input.endpointEnricher || !entry.endpoint || !buildLocalServiceEndpointUrl(entry.endpoint)) {
                const endpoint = await input.endpointEnricher?.resolve(entry, signal);
                signal?.throwIfAborted();
                // Resolution may outlive a scan, label edit, or Forget. Use the
                // current listener, but keep this selected Open's HTTP fact local:
                // native inventory scans must not erase it and wake idle viewers.
                const current = input.inventoryRegistry.getSnapshot();
                const latest = current.entries.find((candidate) => candidate.id === entry?.id);
                if (!latest || latest.state !== 'listening') return { ok: false, reasonCode: 'unknown_inventory_entry' };
                const resolvedEntry = endpoint ? { ...latest, endpoint } : latest;
                entry = resolvedEntry;
            }
            if (
                (entry.address.kind === 'loopback' || entry.address.kind === 'wildcard')
                && (!entry.endpoint || !buildLocalServiceEndpointUrl(entry.endpoint))
            ) {
                return { ok: false, reasonCode: entry.endpoint?.reasonCode ?? 'endpoint_scheme_unknown' };
            }
            const existing = selectLocalServicePreviewForInventoryEntry(
                listLocalServicePreviewResources(input.registry), entry, input.accountId, request.sessionId,
            );
            if (existing) {
                const published = await publish(admission, { ...existing, initialPath: request.initialPath ?? existing.initialPath }, signal, context);
                if (!published.ok) return published;
                return { ok: true, response: { protocolVersion: 1, status: 'existing', preview: published.preview, snapshot: await buildSnapshot(admission) } };
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
            const registeredEntry = entry;
            const registration = registerLocalServicePreview(input.registry, previewInput, { async isCurrent() {
                const unavailable = () => Object.assign(new Error('preview_target_unresolved'), { reasonCode: 'preview_target_unresolved' });
                // Inventory is presentation: Forget hides rows and scan deadlines can
                // mark them stale/gone. Only fresh native evidence can end this binding.
                const process = registeredEntry.provenance?.process;
                if (!process || process.processStartTimeMs === undefined) throw unavailable();
                const census = await readProcessCensus({ freshness: 'fresh', scope: 'all', pids: [process.pid], fields: [], includeAncestors: false });
                if (census.status !== 'ok' || census.partial?.some(row => row.pid === process.pid)) throw unavailable();
                const observed = census.rows.find(row => row.pid === process.pid);
                if (!observed || observed.state === 'zombie' || observed.start.startTimeMs !== process.processStartTimeMs) return false;
                // A live process can close its listener without exiting. Reuse the
                // socket owner with only this PID's FDs, never a machine process walk.
                const sockets = await scanPlatformLocalServices({ includeProcessFacts: false, listenerOwnerPids: [process.pid] });
                if (sockets.diagnostics.length || sockets.socketOwnerReadFailures?.includes(process.pid)) throw unavailable();
                if (!sockets.listeners.some(listener => listener.pid === process.pid && listener.port === registeredEntry.port
                    && normalizeHostnameForLoopbackCheck(listener.address) === normalizeHostnameForLoopbackCheck(registeredEntry.address.host))) {
                    // The same live process can reopen its listener. Refuse bytes while it is down,
                    // without permanently retiring the registration (QA-R88-MAC origin outage).
                    throw Object.assign(new Error('preview_transport_unavailable'), { reasonCode: 'preview_transport_unavailable' });
                }
                return true;
            } });
            if (!registration.ok) {
                return { ok: false, reasonCode: registration.reasonCode };
            }
            const published = await publish(admission, registration.resource, signal, context);
            if (!published.ok) return published;
            return {
                ok: true,
                response: {
                    protocolVersion: 1,
                    status,
                    preview: published.preview,
                    snapshot: await buildSnapshot(admission),
                },
            };
        },

        async revoke(request, context) {
            let admission: Awaited<ReturnType<typeof admitRequest>>;
            try { admission = await admitRequest(context, true); }
            catch { return { ok: false, reasonCode: 'requester_credentials_unavailable' }; }
            if (request.machineId !== input.machineId) {
                return { ok: false, reasonCode: 'wrong_machine' };
            }
            const resource = input.registry.previewsById.get(request.previewId)?.resource;
            if (!await admission.canAccess(resource?.serviceTarget)) return { ok: false, reasonCode: 'unknown_managed_service' };
            if (resource && (resource.serviceTarget
                ? !request.serviceTarget || !matchesProjectManagedServiceTarget(request.serviceTarget, resource.serviceTarget)
                : request.serviceTarget !== undefined)) {
                return { ok: false, reasonCode: 'preview_service_mismatch' };
            }
            if (resource) {
                if (!admission.server) return { ok: false, reasonCode: 'preview_server_unavailable' };
                try { await admission.server.unregisterPreview(request.previewId); }
                catch (error) {
                    logger.warnLocalFile('[local-service] Preview revocation failed', projectActionFailureCauseV1(error, 'local_service.preview.revoke', { allowUnknownErrorCode: false }));
                    return { ok: false, reasonCode: failureReason(error) };
                }
            }
            const result = unregisterLocalServicePreview(input.registry, request.previewId);
            return {
                ok: true,
                response: {
                    protocolVersion: 1,
                    previewId: request.previewId,
                    revoked: result.ok,
                    snapshot: await buildSnapshot(admission),
                },
            };
        },
    };
}
