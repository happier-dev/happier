export const DEEPSEC_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'review-deepsec',
  agentId: 'deepsec',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.deepsec',
    subtitleKey: 'profiles.aiBackend.deepsecSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.deepsec', connectRoute: null },
    flavorAliases: ['deepsec'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: null,
      uiVendorResumeIdCopiedKey: null,
    },
    toolRendering: {
      hideUnknownToolsByDefault: true,
    },
    picker: {
      iconName: 'shield-checkmark-outline',
      cliGlyph: 'DS',
      cliGlyphScale: 0.9,
      profileCompatibilityGlyphScale: 0.9,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: null },
  },
  behavior: {},
  components: { slots: [] },
  assets: {},
});
