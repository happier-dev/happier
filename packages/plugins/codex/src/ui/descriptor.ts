export const CODEX_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'codex',
  agentId: 'codex',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.codex',
    subtitleKey: 'profiles.aiBackend.codexSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedService: { serviceId: 'openai', labelKey: 'agentInput.agent.codex', connectRoute: null },
    flavorAliases: ['codex', 'openai', 'gpt'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.codexSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.codexSessionIdCopied',
    },
    localControl: true,
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'terminal-outline',
      cliGlyphTokenId: 'agentGlyph.codex',
      cliGlyphScale: 0.92,
      profileCompatibilityGlyphScale: 0.82,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'codex' },
  },
  settings: {},
  behavior: {},
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'codex' },
  },
});
