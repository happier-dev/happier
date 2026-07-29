import {
    LocalServicePreviewAccessUrlV1Schema,
    type LocalServicePreviewDiagnosticV1,
    type LocalServicePreviewResourceV1,
    type LocalServicePreviewSnapshotRowV1,
} from "@happier-dev/protocol";

/**
 * Private-preview `accessUrl` owner.
 *
 * For a private preview (the user's own dev server, reachable over loopback) the daemon
 * mints the access URL directly from the registered loopback target — there is no proxy,
 * tunnel, or public exposure involved. This is the single daemon owner for preview-URL
 * minting that the bootstrap previously lacked ("Preview-URL minting has no daemon owner
 * today"); it is wired through {@link ./routes.createLocalServicePreviewRoutes}, so the
 * snapshot served to the UI carries a real `accessUrl` and the embed renders the dev server.
 *
 * Public preview / tunnels are intentionally out of scope here: internet exposure stays an
 * explicit, per-use action owned by the public-preview surface.
 */

function formatAuthorityHost(host: string): string {
    // IPv6 literals must be bracketed inside a URL authority (e.g. `[::1]`).
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Mint the loopback URL an iframe/WebView should load for an owned dev server, or `null`
 * when no valid http(s) origin can be formed from the resource. Deterministic: the same
 * resource always mints the same URL.
 */
export function mintPrivatePreviewAccessUrl(resource: LocalServicePreviewResourceV1): string | null {
    const { scheme, host, port } = resource.target;
    const authority = `${formatAuthorityHost(host)}:${port}`;
    const search = resource.initialPath.search ?? "";
    const candidate = `${scheme}://${authority}${resource.initialPath.pathname}${search}`;
    const parsed = LocalServicePreviewAccessUrlV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

function hostOriginUnavailableDiagnostic(previewId: string): LocalServicePreviewDiagnosticV1 {
    return {
        v: 1,
        code: "host_origin_unavailable",
        severity: "warning",
        scope: "privatePreview",
        previewId,
        details: {},
    };
}

/**
 * Project a registered preview resource into the canonical snapshot row, attaching the
 * minted `accessUrl`. When minting fails the row stays present with `accessUrl: null` plus a
 * private-preview diagnostic so the UI keeps the surface unavailable rather than crashing.
 */
export function projectLocalServicePreviewSnapshotRow(
    resource: LocalServicePreviewResourceV1,
): LocalServicePreviewSnapshotRowV1 {
    const accessUrl = mintPrivatePreviewAccessUrl(resource);
    return {
        previewId: resource.previewId,
        resource,
        accessUrl,
        expiresAt: null,
        diagnostics: accessUrl ? [] : [hostOriginUnavailableDiagnostic(resource.previewId)],
    };
}

export function projectLocalServicePreviewSnapshotRows(
    resources: readonly LocalServicePreviewResourceV1[],
): readonly LocalServicePreviewSnapshotRowV1[] {
    return resources.map((resource) => projectLocalServicePreviewSnapshotRow(resource));
}
