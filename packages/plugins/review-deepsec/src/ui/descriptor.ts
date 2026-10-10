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
      iconName: 'shield-check',
      cliGlyph: 'DS',
      cliGlyphScale: 0.9,
      profileCompatibilityGlyphScale: 0.9,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'deepsec' },
  },
  behavior: {},
  components: { slots: [] },
  assets: {
    // The security review engine's declared shield/check identity.
    svgIcon: {
      assetId: 'deepsec',
      viewBox: '0 0 24 24',
      paths: [{
        fillToken: 'text.primary',
        fillRule: 'evenodd',
        d: 'M12 2 3 5v6c0 5 3 8 9 11 6-3 9-6 9-11V5Zm0 2.1L19 6.4V11c0 4-2.4 6.6-7 8.8C7.4 17.6 5 15 5 11V6.4ZM9 10l-1.4 1.4L11 15l6-6-1.4-1.4L11 12.2Z',
      }],
    },
  },
});
