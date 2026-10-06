import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePreviewResourceV1, LocalServicePreviewSnapshotRowV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { BrowserLocalServicePreviewTargetV1 } from '@happier-dev/protocol';
import { isLiteralLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';

export type LocalServicePreviewRegistry = Readonly<{
    previewsById: Map<string, LocalServicePreviewSnapshotRowV1>;
}>;

export type RegisterLocalServicePreviewInput = Omit<LocalServicePreviewResourceV1, "browserTarget">;

export type RegisterLocalServicePreviewResult =
    | Readonly<{ ok: true; resource: LocalServicePreviewResourceV1 }>
    | Readonly<{ ok: false; reasonCode: "invalid_resource" | "non_loopback_target" }>;

export type UnregisterLocalServicePreviewResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: "not_found" }>;

function toBrowserTarget(resource: RegisterLocalServicePreviewInput): BrowserLocalServicePreviewTargetV1 {
    return {
        kind: "localServicePreview",
        targetId: resource.previewId,
        sessionId: resource.sessionId,
        machineId: resource.machineId,
        display: {
            title: resource.display.title,
            addressLabel: resource.display.addressLabel,
            folderLabel: resource.display.folderLabel,
            iconToken: resource.display.iconToken,
            tone: resource.display.tone,
        },
    };
}

export function createLocalServicePreviewRegistry(): LocalServicePreviewRegistry {
    return {
        previewsById: new Map(),
    };
}

export function registerLocalServicePreview(
    registry: LocalServicePreviewRegistry,
    input: RegisterLocalServicePreviewInput,
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
        browserTarget: toBrowserTarget(input),
    });
    if (!parsed.success) {
        return { ok: false, reasonCode: "invalid_resource" };
    }

    registry.previewsById.set(parsed.data.previewId, {
        previewId: parsed.data.previewId,
        resource: parsed.data,
        accessUrl: null,
        expiresAt: null,
        diagnostics: [],
    });
    return { ok: true, resource: parsed.data };
}

export function unregisterLocalServicePreview(
    registry: LocalServicePreviewRegistry,
    previewId: string,
): UnregisterLocalServicePreviewResult {
    if (!registry.previewsById.delete(previewId)) {
        return { ok: false, reasonCode: "not_found" };
    }
    return { ok: true };
}

export function listLocalServicePreviewResources(
    registry: LocalServicePreviewRegistry,
): readonly LocalServicePreviewResourceV1[] {
    return Array.from(registry.previewsById.values(), (preview) => preview.resource);
}
