export {
    PluginSurfaceHost,
    PluginSurfacePlacementHost,
    PluginInlineSurfaceHost,
    PluginSettingsPageHost,
    type PluginInlineSurfaceHostProps,
    type PluginInlineSurfaceMountV1,
} from './PluginSurfaceHost';
// §3.1: a placement supplies FACTS (`binding`), never a composed Host API. The
// mounted API type is deliberately not re-exported here — the only way to obtain
// one is `createBoundPluginSurfaceController`, so a mount cannot type a private
// composition against the host's barrel.
export { PluginSurfacePlacementStack } from './PluginSurfacePlacementStack';
export {
    PLUGIN_UI_ICON_FALLBACK,
    resolvePluginUiIconName,
} from './iconToken/resolvePluginUiIconToken';
