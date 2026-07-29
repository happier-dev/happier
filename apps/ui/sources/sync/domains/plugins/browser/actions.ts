export {
    canUsePluginBrowserProjectionEntry,
    hasDeferredPluginBrowserPolicy,
} from './policy';
export {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    normalizePluginBrowserProjection,
    resolvePluginBrowserProjectionState,
    type PluginBrowserActionProjection,
    type PluginBrowserProjectionEntry,
    type PluginBrowserProjectionModel,
    type PluginBrowserTargetProjection,
} from './targets';
export {
    executePluginBrowserAction,
    selectPluginBrowserActionsForPlacement,
    selectPluginBrowserToolbarActions,
    type ExecutePluginBrowserActionResult,
    type PluginBrowserActionPlacement,
    type PluginBrowserActionTransport,
} from './execute';
