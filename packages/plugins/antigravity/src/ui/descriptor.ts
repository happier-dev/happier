export const ANTIGRAVITY_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'antigravity',
  agentId: 'antigravity',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.antigravity',
    subtitleKey: 'profiles.aiBackend.antigravitySubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: 'happier.agent.antigravity/antigravity-account', labelKey: 'agentInput.agent.antigravity', connectRoute: null },
    flavorAliases: ['agy'],
    permissions: {
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: null,
      uiVendorResumeIdCopiedKey: null,
    },
    localControl: true,
    toolRendering: { hideUnknownToolsByDefault: false },
    picker: {
      iconName: 'rocket',
      cliGlyph: 'AG',
      cliGlyphScale: 0.92,
      profileCompatibilityGlyphScale: 0.92,
    },
    avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
    icon: { assetId: 'antigravity' },
  },
  components: { slots: [] },
  assets: {
    svgIcon: { path: 'assets/agent-mark.svg' },
  },
});
