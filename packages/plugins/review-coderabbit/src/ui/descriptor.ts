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
      iconName: 'git-pull-request',
      cliGlyph: 'CR',
      cliGlyphScale: 0.9,
      profileCompatibilityGlyphScale: 0.9,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'coderabbit' },
  },
  behavior: {},
  components: { slots: [] },
  assets: {
    // The review engine's declared pull-request identity, not a borrowed vendor logo.
    svgIcon: {
      assetId: 'coderabbit',
      viewBox: '0 0 24 24',
      paths: [{
        fillToken: 'text.primary',
        fillRule: 'evenodd',
        d: 'M6 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-1 4h2v8H5Zm1 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm12-2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM12 2 8 6l4 4V7h2a3 3 0 0 1 3 3v6h2v-6a5 5 0 0 0-5-5h-2Z',
      }],
    },
  },
});
