/**
 * GitHub's connected service, where a missing GitHub connection is fixed. The settings route owner
 * (connectedAccountSettingsRoute) translates this legacy built-in id to its qualified service; this leaf
 * module carries no registry imports, so a pane can link it without loading the plugin registry.
 */
export const GITHUB_CONNECTED_SERVICE_ROUTE = Object.freeze({
    pathname: '/(app)/settings/connected-services/[serviceId]' as const,
    params: Object.freeze({ serviceId: 'github' as const }),
});
