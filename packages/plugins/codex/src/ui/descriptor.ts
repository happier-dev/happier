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
    connectedService: { serviceId: 'openai', labelKey: 'agentInput.connectedServiceLabel.codex', connectRoute: null },
    flavorAliases: ['codex', 'codex-acp', 'codex-mcp', 'openai', 'gpt'],
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
      cliGlyph: '꩜',
      cliGlyphScale: 0.92,
      profileCompatibilityGlyphScale: 0.82,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'codex' },
  },
  behavior: {
    guidance: { includeInSessionGettingStartedCliExamples: true },
    // Cold-start context windows use the RAW catalog `context_window` values (see
    // ~/.codex/models_cache.json: 372k for the 5.6 family, 272k for 5.5/5.4). These are only
    // shown transiently before the first turn: the live app-server token-usage notification
    // delivers the EFFECTIVE window (e.g. 258_400 = 272_000 × 0.95) and always wins as the
    // context resolver's priority-1 source. The raw catalog value is the intended cold-start
    // seed (R-L2 F-R-L2-2). If these change, regenerate the bundled projection with the
    // canonical generator (generatedBundledPluginEntries.uiBehaviorOverrides.ts).
    contextWindow: {
      defaultTokens: 372_000,
      modelRules: [
        { idSuffix: 'gpt-5.6-sol', tokens: 372_000 },
        { idSuffix: 'gpt-5.6-terra', tokens: 372_000 },
        { idSuffix: 'gpt-5.6-luna', tokens: 372_000 },
        { idSuffix: 'gpt-5.5', tokens: 272_000 },
        { idSuffix: 'gpt-5.4', tokens: 272_000 },
        { idSuffix: 'gpt-5.4-mini', tokens: 272_000 },
      ],
    },
    externalSessions: {
      browse: {
        order: 10,
        sourceOptions: [
          {
            key: 'codex:user',
            labelKey: 'externalSessions.browseSourceCodexUserHome',
            source: { kind: 'codexHome', home: 'user' },
          },
        ],
        connectedServiceProfileSources: [
          {
            serviceId: 'openai-codex',
            keyPrefix: 'codex:connected-service',
            labelKey: 'externalSessions.browseSourceCodexConnectedServices',
            labelParams: { service: 'OpenAI Codex' },
            detailSettingsKey: 'connectedServicesProfileLabelByKey',
            source: { kind: 'codexHome', home: 'connectedService' },
            serviceIdField: 'connectedServiceId',
            profileIdField: 'connectedServiceProfileId',
          },
        ],
        lockedConnectedServiceSource: {
          serviceId: 'openai-codex',
          keyPrefix: 'codex:connected-service',
          source: { kind: 'codexHome', home: 'connectedService' },
          serviceIdField: 'connectedServiceId',
          profileIdField: 'connectedServiceProfileId',
          groupIdField: 'connectedServiceGroupId',
        },
        compatibleSource: {
          sourceKind: 'codexHome',
          optionalFields: [
            'home',
            'connectedServiceId',
            'connectedServiceProfileId',
            'connectedServiceGroupId',
            'homePath',
          ],
        },
        linkEnsureRequestExtras: {
          sourceFromCandidate: {
            sourceKind: 'codexHome',
            optionalFields: [
              'home',
              'connectedServiceId',
              'connectedServiceProfileId',
              'connectedServiceGroupId',
              'homePath',
            ],
          },
          runtimeDescriptorFromCandidate: {
            runtimeDescriptorOutputKey: 'runtimeDescriptorV1',
            legacyModeOutputKey: 'codexBackendMode',
            backendMode: {
              values: ['acp', 'appServer'],
            },
            sourceFields: [
              'home',
              'connectedServiceId',
              'connectedServiceProfileId',
              'connectedServiceGroupId',
              'homePath',
            ],
            agentExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandleFields: [
                'backendMode',
                'providerSessionId',
                'home',
                'connectedServiceId',
                'connectedServiceProfileId',
                'connectedServiceGroupId',
                'homePath',
              ],
            },
          },
        },
      },
    },
    permissions: {
      footer: {
        usePermissionUpdates: false,
        forceReadOnlyAfterStop: false,
        supportsExecPolicyAmendment: true,
        stopHandling: 'denyOnly',
      },
    },
    workState: {
      editableGoals: {
        modeValues: ['acp', 'appServer'],
        activeModeValues: ['appServer'],
        activeWhenNoPersistedMode: true,
        persistedGoalSnapshot: {
          path: ['sessionWorkStateV1'],
          itemKind: 'goal',
          providerFields: ['agentId', 'backendId'],
        },
      },
    },
    resume: {
      experimentSwitches: [
        {
          id: 'resumeAcp',
          when: {
            kind: 'settingEquals',
            settingKey: 'codexBackendMode',
            value: 'acp',
            aliases: {
              mcp: 'appServer',
              mcp_resume: 'acp',
            },
          },
        },
      ],
    },
    newSession: {
      relevantInstallableDeps: [
        {
          keys: ['codex-acp'],
            when: {
              all: [
                { kind: 'experimentsEnabled' },
                {
                  any: [
                    {
                      kind: 'settingEquals',
                      settingKey: 'codexBackendMode',
                      value: 'acp',
                      aliases: {
                        mcp: 'appServer',
                        mcp_resume: 'acp',
                      },
                    },
                    {
                      kind: 'settingTrue',
                      settingKey: 'experimentalCodexAcp',
                    },
                  ],
                },
              ],
            },
        },
      ],
    },
    payload: {
      sessionExtras: {
        outputKey: 'codexBackendMode',
        values: ['acp', 'appServer'],
      },
      backendTransport: {
        runtimeDescriptorOutputKey: 'runtimeDescriptorV1',
        legacyModeOutputKey: 'codexBackendMode',
        backendMode: {
          values: ['acp', 'appServer'],
          // Retired setting spellings still reach spawn/resume from persisted UI state.
          aliases: {
            mcp: 'appServer',
            mcp_resume: 'acp',
          },
          legacyExperimentalValue: 'acp',
        },
        runtimeHandleFields: [
          'backendMode',
          'providerSessionId',
          'home',
          'connectedServiceId',
          'connectedServiceProfileId',
          'connectedServiceGroupId',
          'homePath',
        ],
        agentExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
        },
      },
    },
  },
  session: {},
  message: {},
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'codex' },
  },
});
