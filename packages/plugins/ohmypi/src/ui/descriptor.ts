export const OH_MY_PI_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'ohmypi',
  agentId: 'ohMyPi',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.ohMyPi',
    subtitleKey: 'profiles.aiBackend.ohMyPiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.ohMyPi', connectRoute: null },
    flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: null,
      uiVendorResumeIdCopiedKey: null,
    },
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'planet-outline',
      iconScale: 0.9,
      cliGlyph: 'OMP',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'ohMyPi' },
  },
  behavior: {
    mcpServers: { supportsDetectedConfigScan: true },
    externalSessions: {
      supportsBackgroundFollow: false,
      browse: {
        order: 25,
        sourceOptions: [
          {
            key: 'ohMyPi:default-agent-dir',
            labelKey: 'agentInput.agent.ohMyPi',
            detail: '~/.omp/agent',
            source: { kind: 'ohMyPiAgentDir' },
          },
        ],
        compatibleSource: {
          sourceKind: 'ohMyPiAgentDir',
          optionalFields: ['agentDir'],
        },
        linkEnsureRequestExtras: {
          sourceFromCandidate: {
            sourceKind: 'ohMyPiAgentDir',
            optionalFields: ['agentDir'],
          },
        },
      },
    },
  },
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'ohMyPi' },
  },
});
