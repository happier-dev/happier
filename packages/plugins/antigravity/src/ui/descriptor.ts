import { ANTIGRAVITY_ACP_SERVER_INSTALL_ID } from '../agent/install/cliRuntime.js';

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
    connectedService: { serviceId: 'gemini', labelKey: 'agentInput.agent.antigravity', connectRoute: null },
    flavorAliases: ['agy'],
    permissions: {
      modeGroup: 'codexLike',
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
  behavior: {
    // Happier ACP sessions run the managed `agy_acp_server`, never the optional
    // interactive `agy` CLI, so New Session availability depends on this
    // dependency alone and the host installs it in the background.
    newSession: { relevantInstallableDepKeys: [ANTIGRAVITY_ACP_SERVER_INSTALL_ID] },
  },
  components: { slots: [] },
  assets: {
    svgIcon: { assetId: 'antigravity' },
  },
});
