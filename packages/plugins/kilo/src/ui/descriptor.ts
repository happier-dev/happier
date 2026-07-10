export const KILO_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'kilo',
  agentId: 'kilo',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.kilo',
    subtitleKey: 'profiles.aiBackend.kiloSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.kilo', connectRoute: null },
    flavorAliases: ['kilo', 'kilocode'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.kiloSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.kiloSessionIdCopied',
    },
    toolRendering: {
      hideUnknownToolsByDefault: true,
    },
    picker: {
      iconName: 'code-slash-outline',
      cliGlyphTokenId: 'agentGlyph.kilo',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'kilo' },
  },
  capabilityStates: {
    mcpDelivery: 'experimental',
    modelSelection: 'experimental',
    resume: 'experimental',
  },
  settings: {
    descriptorId: 'kilo.agentSettings.v1',
  },
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'kilo' },
  },
});
