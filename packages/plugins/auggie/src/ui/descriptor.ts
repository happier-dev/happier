export const AUGGIE_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'auggie',
  agentId: 'auggie',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.auggie',
    subtitleKey: 'profiles.aiBackend.auggieSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.auggie', connectRoute: null },
    flavorAliases: ['auggie'],
    permissions: {
      modeGroup: 'codexLike',
      promptProtocol: 'codexDecision',
    },
    resume: {
      uiVendorResumeIdLabelKey: 'sessionInfo.auggieSessionId',
      uiVendorResumeIdCopiedKey: 'sessionInfo.auggieSessionIdCopied',
    },
    toolRendering: {
      hideUnknownToolsByDefault: false,
    },
    picker: {
      iconName: 'sparkles',
      iconScale: 1.15,
      cliGlyph: 'A',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'auggie' },
  },
  behavior: {
    descriptorId: 'auggie.uiBehavior.v1',
    newSession: {
      agentOptions: [
        { key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true },
      ],
    },
  },
  session: {},
  message: {},
  components: {
    slots: [
      {
        id: 'auggie-allow-indexing',
        slot: 'newSession.agentInputExtraActionChips',
        chip: {
          kind: 'booleanOption',
          optionStateKey: 'allowIndexing',
          iconName: 'magnifying-glass',
          onLabelKey: 'agentInput.auggieIndexingChip.on',
          offLabelKey: 'agentInput.auggieIndexingChip.off',
        },
      },
    ],
  },
  assets: {
    svgIcon: { assetId: 'auggie' },
  },
});
