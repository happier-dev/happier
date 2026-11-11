export const GROK_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'grok',
  agentId: 'grok',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.grok',
    subtitleKey: 'profiles.aiBackend.grokSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.grok', connectRoute: null },
    flavorAliases: ['grok', 'grok-build', 'grok-cli'],
    permissions: { promptProtocol: 'codexDecision' },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.grokSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.grokSessionIdCopied',
    },
    toolRendering: { hideUnknownToolsByDefault: true },
    picker: {
      iconName: 'lightning',
      iconScale: 1.25,
      cliGlyph: 'G',
      cliGlyphScale: 1.25,
      profileCompatibilityGlyphScale: 1.25,
    },
    avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
    icon: { assetId: 'grok' },
  },
  behavior: {},
  components: { slots: [] },
  assets: {
    svgIcon: { path: 'assets/agent-mark.svg' },
  },
});
