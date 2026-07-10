export const PI_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'pi',
  agentId: 'pi',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.pi',
    subtitleKey: 'profiles.aiBackend.piSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.pi', connectRoute: null },
    flavorAliases: ['pi', 'pi-coding-agent'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    runtimeInput: {
      inFlightSteerSupported: true,
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.piSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.piSessionIdCopied',
    },
    toolRendering: {
      hideUnknownToolsByDefault: true,
    },
    picker: {
      iconName: 'code-slash-outline',
      iconScale: 0.9,
      cliGlyphTokenId: 'agentGlyph.pi',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'pi' },
  },
  settings: {
    descriptorId: 'pi.agentSettings.v1',
  },
  behavior: {
    descriptorId: 'pi.uiBehavior.v1',
  },
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'pi' },
  },
});
