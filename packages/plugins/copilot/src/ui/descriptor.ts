export const COPILOT_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'copilot',
  agentId: 'copilot',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.copilot',
    subtitleKey: 'profiles.aiBackend.copilotSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.connectedServiceLabel.copilot', connectRoute: null },
    flavorAliases: ['copilot', 'github-copilot', 'copilot-cli'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.copilotSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.copilotSessionIdCopied',
    },
    toolRendering: {
      hideUnknownToolsByDefault: true,
    },
    picker: {
      iconName: 'code-slash-outline',
      cliGlyph: 'CP',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'copilot' },
  },
  capabilityStates: {
    mcpDelivery: 'experimental',
    modelSelection: 'experimental',
    resume: 'experimental',
  },
  behavior: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'copilot' },
  },
});
