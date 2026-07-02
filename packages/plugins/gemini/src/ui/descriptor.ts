export const GEMINI_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'gemini',
  agentId: 'gemini',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.gemini',
    subtitleKey: 'profiles.aiBackend.geminiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.geminiPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: 'gemini', labelKey: 'agentInput.agent.gemini', connectRoute: null },
    flavorAliases: ['gemini'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.geminiSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.geminiSessionIdCopied',
    },
    toolRendering: { hideUnknownToolsByDefault: true },
    picker: {
      iconName: 'planet-outline',
      cliGlyphTokenId: 'agentGlyph.gemini',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 0.88,
    },
    avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
    icon: { assetId: 'gemini' },
  },
  settings: {},
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'gemini' },
  },
});
