
export const CLAUDE_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'claude',
  agentId: 'claude',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.claude',
    subtitleKey: 'profiles.aiBackend.claudeSubtitle',
    permissionModeI18nPrefix: 'agentInput.permissionMode',
    availability: { experimental: false },
    connectedService: {
      serviceId: 'anthropic',
      labelKey: 'agentInput.connectedServiceLabel.claude',
      connectRoute: '/(app)/settings/connect/claude',
    },
    flavorAliases: ['claude'],
    permissions: {
      modeGroup: 'claude',
      promptProtocol: 'claude',
    },
    sessionModes: {
      staticOptions: [
        {
          id: 'default',
          nameKey: 'agentInput.mode.build',
          descriptionKey: 'agentInput.mode.buildDescription',
        },
        {
          id: 'plan',
          nameKey: 'agentInput.mode.plan',
          descriptionKey: 'agentInput.mode.planDescription',
        },
      ],
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
    },
    localControl: true,
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'sparkles-outline',
      iconScale: 1.1,
      cliGlyph: '✳︎',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.14,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'claude' },
  },
  behavior: {
    descriptorId: 'claude.uiBehavior.v1',
    // Capability-driven editable-goal gating. Active sessions use the runner's live session RPC
    // registry; a persisted goal item carrying `goalCapabilities.canEdit` is only the detached-session
    // semantic fallback. This keeps provider support and actual remote reachability separate.
    workState: {
      editableGoals: {
        providerId: 'claude',
        capabilityDriven: true,
        persistedGoalSnapshot: {
          path: ['sessionWorkStateV1'],
          itemKind: 'goal',
          providerFields: ['agentId', 'backendId'],
        },
      },
    },
    sessionComposer: {
      nonSteerableWhileBusy: {
        reason: 'provider_config_change_refused',
        metaKeys: ['reasoningEffort'],
        sessionConfigOptionIds: ['reasoning_effort'],
        freshModelOverride: true,
      },
    },
    contextWindow: {
      defaultTokens: 200_000,
      modelRules: [
        {
          idSuffix: '[1m]',
          descriptionIncludesAny: ['1 million', '1m context'],
          tokens: 1_000_000,
        },
      ],
      observedUsageBumpTokens: [200_000, 1_000_000],
      trustObservedUsageBeyondKnown: true,
    },
    externalSessions: {
      browseDescriptorId: 'claude.externalSessions.browse.v1',
      sessionHandoffDescriptorId: 'claude.sessionHandoff.v1',
      sessionHandoff: {
        clearMetadataKeys: [
          'claudeTranscriptPath',
          'claudeLastCheckpointId',
          'claudeLastAssistantUuid',
        ],
      },
      browse: {
        order: 20,
        sourceOptions: [
          {
            key: 'claude:default',
            labelKey: 'externalSessions.browseSourceClaudeDefault',
            source: { kind: 'claudeConfig' },
          },
        ],
        compatibleSource: {
          sourceKind: 'claudeConfig',
          optionalFields: ['configDir', 'projectId'],
        },
        linkEnsureRequestExtras: {
          sourceFromCandidate: {
            sourceKind: 'claudeConfig',
            optionalFields: ['configDir', 'projectId'],
          },
        },
      },
    },
  },
  session: {
    providerBehavior: {
      kind: 'session.providerBehavior.v1',
      agentTeam: {
        kind: 'session.agentTeamBehavior.v1',
        snapshotKey: 'claudeTeam',
        providerLabel: 'Claude',
        flavorAliases: ['claude'],
        tools: {
          teamCreate: ['AgentTeamCreate', 'TeamCreate'],
          teamDelete: ['AgentTeamDelete', 'TeamDelete'],
          teamSendMessage: ['AgentTeamSendMessage', 'TeamSendMessage'],
          subagentSpawn: ['Agent', 'Task'],
          activeTeamFallbackSubagentSpawn: ['Agent'],
          configMutation: ['Edit', 'Write'],
        },
        configTeamPath: {
          rootDirectory: '.claude',
          teamsDirectory: 'teams',
          filename: 'config.json',
        },
        lifecycleEvents: {
          ignoreActivityPreview: ['idle_notification', 'shutdown_approved'],
          shutdownApproved: 'shutdown_approved',
        },
      },
    },
    providerBehaviorDescriptorId: 'claude.sessionProviderBehavior.v1',
    participantDescriptorId: 'claude.teamParticipants.v1',
    subagentDescriptorId: 'claude.teamSubagents.v1',
    autoRecipientPolicyId: 'claude.teamMemberAutoRecipient.v1',
    visibleMessages: {
      kind: 'session.visibleMessages.v1',
      subagentKinds: ['agent_team_member'],
      fallbackToolNames: ['Agent', 'Task'],
      excludeJsonEventTypes: ['idle_notification', 'shutdown_approved'],
    },
  },
  message: {
    metaOverrides: [
      {
        id: 'reasoning-effort',
        targetKey: 'reasoningEffort',
        value: {
          kind: 'sessionConfigOptionOverride',
          key: 'reasoning_effort',
        },
        normalize: 'trimLowercase',
      },
    ],
  },
  components: {
    slots: [
      {
        id: 'claude.subagentLaunchCards',
        slot: 'sessionSubagents.launchCards',
        componentId: 'firstParty.claude.subagentLaunchCards',
        props: {
          teamIds: {
            kind: 'subagentGroupKeys',
            subagentKinds: ['agent_team_member'],
          },
        },
      },
      {
        id: 'claude.teammateDetailsTab',
        slot: 'sessionSubagents.teammateDetailsTab',
        componentId: 'firstParty.claude.teammateDetailsTab',
        resourceKind: 'claudeSubagentLauncher',
        iconName: 'people',
        tab: {
          keyPrefix: 'claude-subagent-launcher',
          titleKey: 'session.subagents.panel.launchTeammateAction',
          subtitleKey: 'session.subagents.panel.launchClaudeTeamsSubtitle',
        },
      },
    ],
  },
  assets: {
    svgIcon: { assetId: 'claude' },
  },
});
