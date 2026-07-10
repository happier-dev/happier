export const KIRO_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'kiro',
  agentId: 'kiro',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.kiro',
    subtitleKey: 'profiles.aiBackend.kiroSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.kiro', connectRoute: null },
    flavorAliases: ['kiro', 'kiro-cli'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.kiroSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.kiroSessionIdCopied',
    },
    localControl: true,
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'flash-outline',
      cliGlyphTokenId: 'agentGlyph.kiro',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
      iconScale: 1.25,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'kiro' },
  },
  capabilityStates: {
    mcpDelivery: 'supported',
    modelSelection: 'experimental',
    resume: 'experimental',
  },
  settings: {
    descriptorId: 'kiro.agentSettings.v1',
  },
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'kiro' },
  },
});
