import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePreviewResourceV1, LocalServicePreviewSnapshotRowV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { localServicePreviewDirectBindingV1, type LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { BrowserLocalServicePreviewTargetV1 } from '@happier-dev/protocol';
import { isLiteralLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';

type PreviewOccurrenceObservation = 'fresh' | 'retained';
type PreviewOccurrence = { isCurrent(observation?: PreviewOccurrenceObservation): boolean | Promise<boolean>; ended?: boolean };
export type LocalServicePreviewRegistry = Readonly<{
    previewsById: Map<string, LocalServicePreviewSnapshotRowV1 & { occurrence?: PreviewOccurrence }>;
    onRegistrationsChanged?: () => void;
}>;

/** The registration owner alone decides whether its occurrence can still serve bytes.
 * Unknown observations throw and fail closed without marking a live occurrence ended.
 * An ended occurrence cannot become live again just because its endpoint is reused.
 */
export async function resolveLocalServicePreviewApplication(
    registry: LocalServicePreviewRegistry,
    binding: LocalServicePreviewDirectBindingV1,
    observation: PreviewOccurrenceObservation = 'fresh',
): Promise<LocalServicePreviewResourceV1> {
    const row = registry.previewsById.get(binding.previewId);
    const unavailable = () => Object.assign(new Error('preview_not_found'), { reasonCode: 'preview_not_found' as const });
    if (!row || !isDeepStrictEqual(localServicePreviewDirectBindingV1(row.resource), binding)) throw unavailable();
    if (row.occurrence?.ended) throw unavailable();
    const serving = row.occurrence ? await row.occurrence.isCurrent(observation) : true;
    // Resolution can await an OS observation while Open/revoke changes the registration.
    const current = registry.previewsById.get(binding.previewId);
    if (!current || current.occurrence?.ended || current.occurrence !== row.occurrence
        || !isDeepStrictEqual(localServicePreviewDirectBindingV1(current.resource), binding)) throw unavailable();
    if (!serving && current.occurrence) {
        current.occurrence.ended = true;
        registry.onRegistrationsChanged?.();
        throw unavailable();
    }
    return current.resource;
}

/** Managed activity carries its exact supervisor's observation; scanned/native listeners
 * still require their request-owned fresh native evidence. Unknowns retain registration.
 */
export async function refreshManagedLocalServicePreviewOccurrences(registry: LocalServicePreviewRegistry): Promise<void> {
    await Promise.allSettled([...registry.previewsById.values()]
        .filter(row => row.resource.serviceTarget && row.occurrence && !row.occurrence.ended)
        .map(row => resolveLocalServicePreviewApplication(registry, localServicePreviewDirectBindingV1(row.resource), 'retained')));
}

export type RegisterLocalServicePreviewInput = Omit<LocalServicePreviewResourceV1, "browserTarget">;

export type RegisterLocalServicePreviewResult =
    | Readonly<{ ok: true; resource: LocalServicePreviewResourceV1 }>
    | Readonly<{ ok: false; reasonCode: "invalid_resource" | "non_loopback_target" }>;

export type UnregisterLocalServicePreviewResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: "not_found" }>;

export function buildLocalServicePreviewBrowserTarget(resource: RegisterLocalServicePreviewInput): BrowserLocalServicePreviewTargetV1 {
    return {
        kind: "localServicePreview",
        targetId: resource.previewId,
        sessionId: resource.sessionId,
        machineId: resource.machineId,
        serviceTarget: resource.serviceTarget,
        display: {
            title: resource.display.title,
            addressLabel: resource.display.addressLabel,
            folderLabel: resource.display.folderLabel,
            iconToken: resource.display.iconToken,
            tone: resource.display.tone,
        },
    };
}

export function createLocalServicePreviewRegistry(onRegistrationsChanged?: () => void): LocalServicePreviewRegistry {
    return {
        previewsById: new Map(),
        onRegistrationsChanged,
    };
}

export function registerLocalServicePreview(
    registry: LocalServicePreviewRegistry,
    input: RegisterLocalServicePreviewInput,
    occurrence?: PreviewOccurrence,
): RegisterLocalServicePreviewResult {
    const normalizedHost = normalizeHostnameForLoopbackCheck(input.target.host);
    if (!isLiteralLoopbackHostname(normalizedHost)) {
        return { ok: false, reasonCode: "non_loopback_target" };
    }

    const parsed = LocalServicePreviewResourceV1Schema.safeParse({
        ...input,
        target: {
            ...input.target,
            host: normalizedHost,
        },
        browserTarget: buildLocalServicePreviewBrowserTarget(input),
    });
    if (!parsed.success) {
        return { ok: false, reasonCode: "invalid_resource" };
    }

    const previous = registry.previewsById.get(parsed.data.previewId);
    const retainedOccurrence = previous?.occurrence?.ended
        && isDeepStrictEqual(localServicePreviewDirectBindingV1(previous.resource), localServicePreviewDirectBindingV1(parsed.data))
        ? previous.occurrence : occurrence;
    registry.previewsById.set(parsed.data.previewId, {
        previewId: parsed.data.previewId,
        resource: parsed.data,
        accessUrl: null,
        expiresAt: null,
        diagnostics: [],
        ...(retainedOccurrence ? { occurrence: retainedOccurrence } : {}),
    });
    if (!previous || !isDeepStrictEqual(previous.resource, parsed.data)) registry.onRegistrationsChanged?.();
    return { ok: true, resource: parsed.data };
}

export function unregisterLocalServicePreview(
    registry: LocalServicePreviewRegistry,
    previewId: string,
): UnregisterLocalServicePreviewResult {
    if (!registry.previewsById.delete(previewId)) {
        return { ok: false, reasonCode: "not_found" };
    }
    registry.onRegistrationsChanged?.();
    return { ok: true };
}

export function listLocalServicePreviewResources(
    registry: LocalServicePreviewRegistry,
): readonly LocalServicePreviewResourceV1[] {
    return [...registry.previewsById.values()].filter(preview => !preview.occurrence?.ended).map(preview => preview.resource);
}

export function previewIdForInventoryEntry(accountId: string, machineId: string, sessionId: string | undefined, entryId: string): string {
    return `preview-${createHash('sha256').update(JSON.stringify([accountId, machineId, sessionId ?? null, entryId])).digest('hex')}`;
}

/** Inventory Open and launcher projection must select the same existing listener registration.
 * An explicit Session remains a separate scope; a Machine view may use a Session-owned preview
 * without transferring its ownership or creating another registration for the same listener.
 */
export function selectLocalServicePreviewForInventoryEntry(
    resources: readonly LocalServicePreviewResourceV1[],
    entry: NormalizedLocalServiceInventoryEntry,
    accountId: string | undefined,
    sessionId?: string,
): LocalServicePreviewResourceV1 | undefined {
    if (!accountId) return undefined;
    const entryHost = normalizeHostnameForLoopbackCheck(entry.endpoint?.host ?? entry.address.host);
    return resources.filter((resource) => {
        // A managed registration belongs to one native occurrence, never to an
        // arbitrary listener or its replacement on the same endpoint.
        if (resource.serviceTarget) return false;
        if (resource.machineId !== entry.machineId || resource.target.port !== entry.port) return false;
        if (sessionId !== undefined && resource.sessionId !== sessionId) return false;
        if (entry.endpoint && entry.endpoint.scheme !== 'unknown' && resource.target.scheme !== entry.endpoint.scheme) return false;
        // Endpoint equality alone cannot distinguish a replacement process. Use the
        // registration owner's occurrence identity, including the resource's Session
        // so a Machine view can still reuse a Session-owned preview of this listener.
        if (resource.previewId !== previewIdForInventoryEntry(accountId, entry.machineId, resource.sessionId, entry.id)) return false;
        const host = normalizeHostnameForLoopbackCheck(resource.target.host);
        return host === entryHost
            || (entry.address.kind === 'wildcard' && isLiteralLoopbackHostname(host))
            || (entry.address.kind === 'loopback' && (host === 'localhost' || entryHost === 'localhost'));
    }).sort((a, b) => Number(a.sessionId !== sessionId) - Number(b.sessionId !== sessionId)
        || a.previewId.localeCompare(b.previewId))[0];
}
