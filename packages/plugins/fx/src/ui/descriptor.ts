/**
 * FX agent mark.
 *
 * Geometry is the vendor-supplied `fx_logo.svg` (viewBox `0 0 24 24`, single
 * `logo-fx-glyph` path, `fill-rule="nonzero"`) reproduced exactly. The supplied
 * file hardcodes `fill="#000000"`, which disappears on a dark theme, so the one
 * substitution made here is the Happier theme token; no coordinate is redrawn,
 * rounded, or re-exported.
 *
 * This descriptor is the canonical owner: the bundled plugin generator renders
 * it into the UI projection's SVG. Do not add a parallel raw `.svg` asset.
 */
const FX_ICON_PATHS = Object.freeze([
  Object.freeze({
    fillToken: 'text.primary',
    fillRule: 'nonzero',
    d: 'M10.5626937,0 C11.3535073,0 12.2803588,0.21227889 12.8260052,0.458940979 L13.1339591,0.599463625 L12.3850033,2.78503923 L12.0262221,2.65348612 C11.6106338,2.49950918 11.168137,2.36197638 10.652389,2.36197638 C10.1276715,2.36197638 9.80028359,2.47559043 9.54465197,2.73869666 C9.26809144,3.02422671 9.02890396,3.53399503 8.81961491,4.44888715 L8.81961491,4.44888715 L8.81961491,4.44888715 L8.65666844,5.20980232 L11.1277741,5.20980232 L13.9322473,5.22475154 L13.9711153,5.22475154 L13.9935391,5.25763982 L16.6858932,9.21320279 L19.3603082,5.22475154 L22.9675544,5.22475154 L18.6038778,11.4720296 L23.1514298,17.901688 L19.747493,17.901688 L19.7250691,17.8717896 L11.0485433,6.05144327 L10.7809523,7.38491348 L8.19772746,7.38491348 L5.74904562,19.0168997 C5.48593939,20.2875832 5.07633083,21.3534624 4.41707034,22.105408 C3.74286063,22.8737978 2.83544312,23.2834064 1.66043462,23.2834064 C1.03854717,23.2834064 0.525789004,23.1877314 0.101231225,23.0382392 L-0.148420708,22.9500388 L-0.148420708,20.5073367 L-0.0497558722,20.5402249 L0.34340855,20.6717781 C0.739562816,20.8033312 1.07293037,20.8990062 1.48104401,20.8990062 C1.68883813,20.8990062 1.86374398,20.8586433 2.01772092,20.7764226 C2.17169786,20.6942019 2.30923066,20.5701234 2.43480409,20.3967125 C2.70090016,20.0304566 2.91317905,19.4534168 3.08957982,18.6371895 L5.46052572,7.38491348 L3.3840794,7.38491348 L3.66661962,5.89597141 L3.70847743,5.88251711 L5.91797178,5.1529953 L6.11679638,4.28145591 C6.47109283,2.72225252 6.9569424,1.6354444 7.69543375,0.944790551 C8.4473794,0.240682403 9.4026344,0 10.5626937,0 Z M15.9593612,14.8116848 L13.8784301,17.9764341 L10.0618949,17.9764341 L14.0174579,12.2613483 L15.9593612,14.8116848 Z',
  }),
]);

export const FX_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1', pluginId: 'fx', agentId: 'fx', version: 1,
  display: {
    nameKey: 'agentInput.agent.fx', subtitleKey: 'profiles.aiBackend.fxSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode', availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.fx', connectRoute: null },
    flavorAliases: ['fx', 'vercel-fx'], permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
    resume: { uiVendorResumeIdLabelKey: 'sessionInfo.fxSessionId', uiVendorResumeIdCopiedKey: 'sessionInfo.fxSessionIdCopied' },
    localControl: true, toolRendering: { hideUnknownToolsByDefault: false },
    picker: { iconName: 'lightning', cliGlyph: 'FX', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1, iconScale: 1.15 },
    avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 }, icon: { assetId: 'fx' },
  },
  capabilityStates: { mcpDelivery: 'supported', modelSelection: 'experimental', resume: 'supported' },
  behavior: {}, components: { slots: [] },
  assets: { svgIcon: { assetId: 'fx', viewBox: '0 0 24 24', paths: FX_ICON_PATHS } },
});
