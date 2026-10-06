export const DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE = 'daemon_plugin_catalog_unavailable';
export const DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_PREVIEW =
    'The daemon plugin catalog is unavailable. Check the daemon connection and retry.';

export class DaemonPluginToolCatalogUnavailableError extends Error {
    readonly code = DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE;

    constructor() {
        super(DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_PREVIEW);
        this.name = 'DaemonPluginToolCatalogUnavailableError';
    }
}
