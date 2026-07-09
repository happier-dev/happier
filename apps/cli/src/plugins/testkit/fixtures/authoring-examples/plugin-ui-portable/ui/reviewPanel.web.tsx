// Portable plugin UI source entry for the hosted-web surface.
//
// This is a *plugin* source compiled by `happier-plugin-build-ui` into
// `dist/happier-plugin-ui/hosted-web/preview-web/...`. It is intentionally
// sandboxed: a plugin UI talks to the host only through the SDK host-API client
// (`@happier-dev/plugin-sdk/ui/hostApiClient`) and does NOT import host chrome,
// themed tokens, or `@/` app modules — the package boundary forbids it.
//
// The fixture build is exercised end-to-end by the daemon static-asset
// consumer proof in
// apps/cli/src/daemon/local/services/plugins/staticAssets/portableFixture.test.ts,
// which builds this surface with the executor and asserts the daemon resolves it
// with zero `hosted_web_ui_artifacts_manifest_read_failed` diagnostics.

export function activate(): void {
    // Real plugins mount their React tree and create a host-API client here.
}
