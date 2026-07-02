import {
    LocalServicePreviewResourceV1Schema,
    type BrowserLocalServicePreviewTargetV1,
    type LocalServicePreviewResourceV1,
} from "@happier-dev/protocol";

export type LocalServicePreviewRegistry = Readonly<{
    resourcesById: Map<string, LocalServicePreviewResourceV1>;
}>;

export type RegisterLocalServicePreviewInput = Omit<LocalServicePreviewResourceV1, "browserTarget">;

export type RegisterLocalServicePreviewResult =
    | Readonly<{ ok: true; resource: LocalServicePreviewResourceV1 }>
    | Readonly<{ ok: false; reasonCode: "invalid_resource" | "non_loopback_target" }>;

export type UnregisterLocalServicePreviewResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: "not_found" }>;

function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.|$)/u.test(normalized);
}

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
        resourcesById: new Map(),
    };
}

export function registerLocalServicePreview(
    registry: LocalServicePreviewRegistry,
    input: RegisterLocalServicePreviewInput,
): RegisterLocalServicePreviewResult {
    if (!isLoopbackHost(input.target.host)) {
        return { ok: false, reasonCode: "non_loopback_target" };
    }

    const parsed = LocalServicePreviewResourceV1Schema.safeParse({
        ...input,
        browserTarget: toBrowserTarget(input),
    });
    if (!parsed.success) {
        return { ok: false, reasonCode: "invalid_resource" };
    }

    registry.resourcesById.set(parsed.data.previewId, parsed.data);
    return { ok: true, resource: parsed.data };
}

export function unregisterLocalServicePreview(
    registry: LocalServicePreviewRegistry,
    previewId: string,
): UnregisterLocalServicePreviewResult {
    if (!registry.resourcesById.delete(previewId)) {
        return { ok: false, reasonCode: "not_found" };
    }
    return { ok: true };
}

export function listLocalServicePreviewResources(
    registry: LocalServicePreviewRegistry,
): readonly LocalServicePreviewResourceV1[] {
    return Array.from(registry.resourcesById.values());
}
