export const OH_MY_PI_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'ohmypi',
  agentId: 'ohMyPi',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.ohMyPi',
    subtitleKey: 'profiles.aiBackend.ohMyPiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.ohMyPi', connectRoute: null },
    flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: null,
      uiVendorResumeIdCopiedKey: null,
    },
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'planet-outline',
      iconScale: 0.9,
      cliGlyphTokenId: 'agentGlyph.ohMyPi',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'ohMyPi' },
  },
  settings: {},
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'ohMyPi' },
  },
});
