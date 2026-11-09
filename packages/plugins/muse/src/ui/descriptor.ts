import { MUSE_ACCOUNTING_SOURCE_ID } from '../agent/definition.js';

/** Muse facts in the same data-only envelope used by the bundled UI projector. */
export const MUSE_UI_DESCRIPTOR = Object.freeze({
  kind: 'plugin.ui.v1',
  pluginId: 'happier.agent.muse',
  agentId: 'muse',
  version: 1,
  display: {
    nameKey: 'agentInput.agent.muse',
    subtitleKey: 'profiles.aiBackend.museSubtitle',
    permissionModeI18nPrefix: 'agentInput.permissionMode',
    availability: { experimental: false },
    connectedService: { serviceId: null, labelKey: 'agentInput.agent.muse', connectRoute: null },
    flavorAliases: [],
    // Required display fallback; offered native answers are authorized by the native-choice owner.
    permissions: { promptProtocol: 'claude' },
    resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },
    toolRendering: { hideUnknownToolsByDefault: false },
    picker: { iconName: 'stack-simple', iconScale: 1, cliGlyph: '?', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1 },
    avatarOverlay: { circleScale: 1, iconScaleRatio: 1 },
  },
  behavior: {
    accountingSourcePresentation: [{
      sourceId: MUSE_ACCOUNTING_SOURCE_ID,
      title: { key: 'usage.board.page.sourceAccountingAgent', fallback: 'usage · {agent}', params: { agent: 'Muse' } },
    }],
  },
});
