export const KIMI_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'kimi',
  agentId: 'kimi',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.kimi',
    subtitleKey: 'profiles.aiBackend.kimiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.kimi', connectRoute: null },
    flavorAliases: ['kimi', 'kimi-cli'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.kimiSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.kimiSessionIdCopied',
    },
    toolRendering: {
      hideUnknownToolsByDefault: true,
    },
    picker: {
      iconName: 'code-slash-outline',
      cliGlyphTokenId: 'agentGlyph.kimi',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'kimi' },
  },
  settings: {
    descriptorId: 'kimi.agentSettings.v1',
  },
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'kimi' },
  },
});
