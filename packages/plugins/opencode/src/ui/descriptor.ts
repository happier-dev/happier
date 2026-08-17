
export const OPENCODE_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'opencode',
  agentId: 'opencode',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.opencode',
    subtitleKey: 'profiles.aiBackend.opencodeSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.opencode', connectRoute: null },
    flavorAliases: ['opencode', 'open-code'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.opencodeSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.opencodeSessionIdCopied',
    },
    localControl: true,
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'code-slash-outline',
      iconScale: 0.9,
      cliGlyph: '</>',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'opencode' },
  },
  behavior: {
    descriptorId: 'opencode.uiBehavior.v1',
    guidance: { includeInSessionGettingStartedCliExamples: true },
    mcpServers: { supportsDetectedConfigScan: true },
    newSession: {
      transcriptStorageModesByBackendMode: {
        server: ['persisted', 'direct'],
        acp: ['persisted'],
      },
    },
    externalSessions: {
      browseDescriptorId: 'opencode.externalSessions.browse.v1',
      sessionHandoffDescriptorId: 'opencode.sessionHandoff.v1',
      supportsBackgroundFollow: true,
      browse: {
        order: 30,
        sourceOptions: [
          {
            key: 'opencode:default',
            labelKey: 'externalSessions.browseSourceOpenCodeDefault',
            source: { kind: 'opencodeServer' },
          },
        ],
        compatibleSource: {
          sourceKind: 'opencodeServer',
          optionalFields: ['baseUrl', 'directory'],
        },
      },
    },
    payload: {
      environmentVariables: {
        providerId: 'opencode',
        backendMode: {
          envKey: 'HAPPIER_OPENCODE_BACKEND_MODE',
          settingKey: 'opencodeBackendMode',
          legacyMetadataKey: 'opencodeBackendMode',
          runtimeDescriptorField: 'backendMode',
          defaultValue: 'server',
          values: ['server', 'acp'],
        },
        serverBaseUrl: {
          envKey: 'HAPPIER_OPENCODE_SERVER_URL',
          explicitEnvKey: 'HAPPIER_OPENCODE_SERVER_URL_EXPLICIT',
          settingKey: 'opencodeServerBaseUrl',
          byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
          legacyMetadataKey: 'opencodeServerBaseUrl',
          legacyExplicitMetadataKey: 'opencodeServerBaseUrlExplicit',
          runtimeDescriptorField: 'serverBaseUrl',
          runtimeDescriptorExplicitField: 'serverBaseUrlExplicit',
          allowedProtocols: ['http:', 'https:'],
          rejectCredentials: true,
          originOnly: true,
        },
        agentExtra: {
          owner: 'opencode',
          schemaId: 'opencode.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandleFields: [
            'backendMode',
            'providerSessionId',
            'serverBaseUrl',
            'serverBaseUrlExplicit',
          ],
        },
      },
    },
  },
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: {
      assetId: 'opencode',
      viewBox: '0 0 240 300',
      paths: [
        {
          fillToken: 'text.primary',
          fillRule: 'evenodd',
          clipRule: 'evenodd',
          d: 'M0 0H240V300H0V0ZM60 60H180V240H60V60Z',
        },
        {
          fillToken: 'text.primary',
          fillOpacity: 0.25,
          d: 'M60 120H180V240H60V120Z',
        },
      ],
    },
  },
});
