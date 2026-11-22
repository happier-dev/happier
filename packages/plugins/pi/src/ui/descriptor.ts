export const PI_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'pi',
  agentId: 'pi',
  version: 1,
  identityColor: { light: '#e87ba4', dark: '#d55181' },
  display: {
    nameKey: 'agentInput.agent.pi',
    subtitleKey: 'profiles.aiBackend.piSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.pi', connectRoute: null },
    flavorAliases: ['pi', 'pi-coding-agent'],
    permissions: {
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
      iconName: 'code',
      iconScale: 0.9,
      cliGlyph: 'PI',
      cliGlyphScale: 1.0,
      profileCompatibilityGlyphScale: 1.0,
    },
    avatarOverlay: {
      circleScale: 0.35,
      iconScaleRatio: 0.22,
    },
    icon: { assetId: 'pi' },
  },
  behavior: {
    accountingSourcePresentation: [
      {
        sourceId: 'pi-native-accounting',
        title: {
          key: 'usage.board.page.sourceAccountingAgent',
          fallback: 'usage · {agent}',
          params: {
            agent: 'Pi'
          }
        }
      },
      {
        sourceId: 'pi-session-stats',
        title: {
          key: 'usage.board.page.sourceAccountingAgent',
          fallback: 'usage · {agent}',
          params: {
            agent: 'Pi'
          }
        }
      }
    ],
    descriptorId: 'pi.uiBehavior.v1',
  },
  components: { slots: [] },
  assets: {
    svgIcon: { path: 'assets/agent-mark.svg' },
  },
});
