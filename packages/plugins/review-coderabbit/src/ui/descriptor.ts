export const CODERABBIT_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'review-coderabbit',
  agentId: 'coderabbit',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.coderabbit',
    subtitleKey: 'profiles.aiBackend.coderabbitSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.coderabbit', connectRoute: null },
    flavorAliases: ['coderabbit'],
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
      iconName: 'git-pull-request-outline',
      cliGlyph: 'CR',
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
  session: {},
  message: {},
  components: { slots: [] },
  assets: {},
});
