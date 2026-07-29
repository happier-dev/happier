export const CURSOR_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'cursor',
  agentId: 'cursor',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.cursor',
    subtitleKey: 'profiles.aiBackend.cursorSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.cursor', connectRoute: null },
    flavorAliases: ['cursor', 'cursor-agent'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.cursorSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.cursorSessionIdCopied',
    },
    localControl: true,
    toolRendering: {
      hideUnknownToolsByDefault: true,
    },
    picker: {
      iconName: 'code-slash-outline',
      cliGlyph: 'CU',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'cursor' },
  },
  capabilityStates: {
    mcpDelivery: 'experimental',
    modelSelection: 'experimental',
    resume: 'experimental',
  },
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'cursor' },
  },
});
