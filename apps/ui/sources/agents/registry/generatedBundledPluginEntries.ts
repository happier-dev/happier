/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled plugins.
 * This file is emitted by:
 * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`
 *
 * UI facts here are descriptor-derived and no-execute; this file must not import plugin UI runtime exports.
 */

import type { AgentCoreConfig, CanonicalAgentId } from './registryCore';
import type { AgentIconSvgXmlResolver, AgentUiConfig } from './registryUi';
import { AGENT_LOGO_SVG_XML } from './agentLogoSvgXml';

import { buildCatalogAgentCliUiConfig } from '@/agents/registry/buildCatalogAgentCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

function normalizeGeneratedSvgXml(xml: string): string {
    return xml.replace(/\s{2,}/g, ' ').trim();
}

function createGeneratedSvgIconXml(viewBox: string, body: string): string {
    return normalizeGeneratedSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`);
}

const CLAUDE_CORE: AgentCoreConfig = {
    id: 'claude',
    displayNameKey: 'agentInput.agent.claude',
    subtitleKey: 'profiles.aiBackend.claudeSubtitle',
    permissionModeI18nPrefix: 'agentInput.permissionMode',
    availability: { experimental: false },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'claude' }),
    uiConnectedService: { serviceId: 'anthropic', labelKey: 'agentInput.connectedServiceLabel.claude', connectRoute: '/(app)/settings/connect/claude' },
    flavorAliases: ['claude'],
    providerOwnedEnvironmentKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SETUP_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
    cli: buildCatalogAgentCliUiConfig('claude'),
    permissions: {
        modeGroup: 'claude',
        promptProtocol: 'claude',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('claude'),
        staticOptions: [
            { id: 'default', nameKey: 'agentInput.mode.build', descriptionKey: 'agentInput.mode.buildDescription' },
            { id: 'plan', nameKey: 'agentInput.mode.plan', descriptionKey: 'agentInput.mode.planDescription' },
        ],
    },
    model: getAgentModelConfig('claude'),
    resume: buildAgentResumeUiConfig({
        agentId: 'claude',
        uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'claude' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'claude' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'claude' }),
    ui: {
        agentPickerIconName: 'sparkles-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1.14,
    },
};

const CLAUDE_UI: AgentUiConfig = {
    id: 'claude',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.claude ?? null,
    pickerIconScale: 1.1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: '✳︎',
};

const CODEX_CORE: AgentCoreConfig = {
    id: 'codex',
    displayNameKey: 'agentInput.agent.codex',
    subtitleKey: 'profiles.aiBackend.codexSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'codex' }),
    uiConnectedService: { serviceId: 'openai', labelKey: 'agentInput.connectedServiceLabel.codex', connectRoute: null },
    flavorAliases: ['codex', 'codex-acp', 'codex-mcp', 'openai', 'gpt'],
    providerOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
    cli: buildCatalogAgentCliUiConfig('codex'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('codex'),
    },
    model: getAgentModelConfig('codex'),
    resume: buildAgentResumeUiConfig({
        agentId: 'codex',
        uiVendorResumeIdLabelKey: 'sessionInfo.codexSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codexSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'codex' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'codex' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'codex' }),
    ui: {
        agentPickerIconName: 'terminal-outline',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.82,
    },
};

const CODEX_UI: AgentUiConfig = {
    id: 'codex',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.codex ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: '꩜',
};

const CURSOR_CORE: AgentCoreConfig = {
    id: 'cursor',
    displayNameKey: 'agentInput.agent.cursor',
    subtitleKey: 'profiles.aiBackend.cursorSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'cursor' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.cursor', connectRoute: null },
    flavorAliases: ['cursor', 'cursor-agent'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('cursor'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('cursor'),
    },
    model: getAgentModelConfig('cursor'),
    resume: buildAgentResumeUiConfig({
        agentId: 'cursor',
        uiVendorResumeIdLabelKey: 'sessionInfo.cursorSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.cursorSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'cursor' }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'cursor' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'cursor' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const CURSOR_UI: AgentUiConfig = {
    id: 'cursor',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.cursor ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'CU',
};

const OPENCODE_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 240 300',
    `
        <path fill="${theme.colors.text.primary}" fill-rule="evenodd" clip-rule="evenodd" d="M0 0H240V300H0V0ZM60 60H180V240H60V60Z"/>
        <path fill="${theme.colors.text.primary}" fill-opacity="0.25" d="M60 120H180V240H60V120Z"/>
    `,
);

const OPENCODE_CORE: AgentCoreConfig = {
    id: 'opencode',
    displayNameKey: 'agentInput.agent.opencode',
    subtitleKey: 'profiles.aiBackend.opencodeSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'opencode' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.opencode', connectRoute: null },
    flavorAliases: ['opencode', 'open-code'],
    providerOwnedEnvironmentKeys: ['HAPPIER_OPENCODE_PROVIDER_API_KEY', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG_CONTENT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    cli: buildCatalogAgentCliUiConfig('opencode'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('opencode'),
    },
    model: getAgentModelConfig('opencode'),
    resume: buildAgentResumeUiConfig({
        agentId: 'opencode',
        uiVendorResumeIdLabelKey: 'sessionInfo.opencodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.opencodeSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'opencode' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'opencode' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'opencode' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const OPENCODE_UI: AgentUiConfig = {
    id: 'opencode',
    icon: null,
    svgIconXml: OPENCODE_SVG_ICON_XML,
    pickerIconScale: 0.9,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: '</>',
};

const ANTIGRAVITY_CORE: AgentCoreConfig = {
    id: 'antigravity',
    displayNameKey: 'agentInput.agent.antigravity',
    subtitleKey: 'profiles.aiBackend.antigravitySubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'antigravity' }),
    uiConnectedService: { serviceId: 'gemini', labelKey: 'agentInput.agent.antigravity', connectRoute: null },
    flavorAliases: ['agy'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('antigravity'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('antigravity'),
    },
    model: getAgentModelConfig('antigravity'),
    resume: buildAgentResumeUiConfig({
        agentId: 'antigravity',
        uiVendorResumeIdLabelKey: null,
        uiVendorResumeIdCopiedKey: null,
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'antigravity' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'antigravity' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'antigravity' }),
    ui: {
        agentPickerIconName: 'rocket-outline',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.92,
    },
};

const ANTIGRAVITY_UI: AgentUiConfig = {
    id: 'antigravity',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.antigravity ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'AG',
};

const GEMINI_CORE: AgentCoreConfig = {
    id: 'gemini',
    displayNameKey: 'agentInput.agent.gemini',
    subtitleKey: 'profiles.aiBackend.geminiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.geminiPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'gemini' }),
    uiConnectedService: { serviceId: 'gemini', labelKey: 'agentInput.connectedServiceLabel.gemini', connectRoute: null },
    flavorAliases: ['gemini'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('gemini'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('gemini'),
    },
    model: getAgentModelConfig('gemini'),
    resume: buildAgentResumeUiConfig({
        agentId: 'gemini',
        uiVendorResumeIdLabelKey: 'sessionInfo.geminiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.geminiSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'gemini' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'gemini' }),
    ui: {
        agentPickerIconName: 'planet-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 0.88,
    },
};

const GEMINI_UI: AgentUiConfig = {
    id: 'gemini',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.gemini ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: '✦︎',
};

const GROK_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 1024 1024',
    `
        <path fill="${theme.colors.text.primary}" d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916"/>
        <path fill="${theme.colors.text.primary}" d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339"/>
    `,
);

const GROK_CORE: AgentCoreConfig = {
    id: 'grok',
    displayNameKey: 'agentInput.agent.grok',
    subtitleKey: 'profiles.aiBackend.grokSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'grok' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.grok', connectRoute: null },
    flavorAliases: ['grok', 'grok-build', 'grok-cli'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('grok'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('grok'),
    },
    model: getAgentModelConfig('grok'),
    resume: buildAgentResumeUiConfig({
        agentId: 'grok',
        uiVendorResumeIdLabelKey: 'sessionInfo.grokSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.grokSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'grok' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'grok' }),
    ui: {
        agentPickerIconName: 'flash-outline',
        cliGlyphScale: 1.25,
        profileCompatibilityGlyphScale: 1.25,
    },
};

const GROK_UI: AgentUiConfig = {
    id: 'grok',
    icon: null,
    svgIconXml: GROK_SVG_ICON_XML,
    pickerIconScale: 1.25,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'G',
};

const AUGGIE_CORE: AgentCoreConfig = {
    id: 'auggie',
    displayNameKey: 'agentInput.agent.auggie',
    subtitleKey: 'profiles.aiBackend.auggieSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'auggie' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.auggie', connectRoute: null },
    flavorAliases: ['auggie'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('auggie'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('auggie'),
    },
    model: getAgentModelConfig('auggie'),
    resume: buildAgentResumeUiConfig({
        agentId: 'auggie',
        uiVendorResumeIdLabelKey: 'sessionInfo.auggieSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.auggieSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'auggie' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'auggie' }),
    ui: {
        agentPickerIconName: 'sparkles',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const AUGGIE_UI: AgentUiConfig = {
    id: 'auggie',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.auggie ?? null,
    pickerIconScale: 1.15,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'A',
};

const QWEN_CORE: AgentCoreConfig = {
    id: 'qwen',
    displayNameKey: 'agentInput.agent.qwen',
    subtitleKey: 'profiles.aiBackend.qwenSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'qwen' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.qwen', connectRoute: null },
    flavorAliases: ['qwen', 'qwen-code'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('qwen'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
        permissionModeMapping: {
  "default": null,
  "plan": "plan",
  "read-only": "plan",
  "safe-yolo": "auto-edit",
  "yolo": "yolo"
},
    },
    sessionModes: {
        kind: getAgentSessionModesKind('qwen'),
    },
    model: getAgentModelConfig('qwen'),
    resume: buildAgentResumeUiConfig({
        agentId: 'qwen',
        uiVendorResumeIdLabelKey: 'sessionInfo.qwenSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.qwenSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'qwen' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'qwen' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};

const QWEN_UI: AgentUiConfig = {
    id: 'qwen',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.qwen ?? null,
    pickerIconScale: 0.9,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'Q',
};

const KIMI_CORE: AgentCoreConfig = {
    id: 'kimi',
    displayNameKey: 'agentInput.agent.kimi',
    subtitleKey: 'profiles.aiBackend.kimiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'kimi' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.kimi', connectRoute: null },
    flavorAliases: ['kimi', 'kimi-cli'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('kimi'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kimi'),
    },
    model: getAgentModelConfig('kimi'),
    resume: buildAgentResumeUiConfig({
        agentId: 'kimi',
        uiVendorResumeIdLabelKey: 'sessionInfo.kimiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kimiSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'kimi' }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'kimi' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'kimi' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const KIMI_UI: AgentUiConfig = {
    id: 'kimi',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.kimi ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'K',
};

const KILO_CORE: AgentCoreConfig = {
    id: 'kilo',
    displayNameKey: 'agentInput.agent.kilo',
    subtitleKey: 'profiles.aiBackend.kiloSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'kilo' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.kilo', connectRoute: null },
    flavorAliases: ['kilo', 'kilocode'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('kilo'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kilo'),
    },
    model: getAgentModelConfig('kilo'),
    resume: buildAgentResumeUiConfig({
        agentId: 'kilo',
        uiVendorResumeIdLabelKey: 'sessionInfo.kiloSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kiloSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'kilo' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'kilo' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const KILO_UI: AgentUiConfig = {
    id: 'kilo',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.kilo ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'KL',
};

const KIRO_CORE: AgentCoreConfig = {
    id: 'kiro',
    displayNameKey: 'agentInput.agent.kiro',
    subtitleKey: 'profiles.aiBackend.kiroSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'kiro' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.kiro', connectRoute: null },
    flavorAliases: ['kiro', 'kiro-cli'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('kiro'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kiro'),
    },
    model: getAgentModelConfig('kiro'),
    resume: buildAgentResumeUiConfig({
        agentId: 'kiro',
        uiVendorResumeIdLabelKey: 'sessionInfo.kiroSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kiroSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'kiro' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'kiro' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'kiro' }),
    ui: {
        agentPickerIconName: 'flash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const KIRO_UI: AgentUiConfig = {
    id: 'kiro',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.kiro ?? null,
    pickerIconScale: 1.25,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'KR',
};

const DEVIN_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 256 294',
    `
        <path fill="${theme.colors.text.primary}" d="M0,98.5741786 L0,37.8339264 C0,35.164464 1.42411826,32.697809 3.73594287,31.3631225 L56.3241455,1.00108188 C58.6363275,-0.333693961 61.484564,-0.333693961 63.796746,1.00108188 L116.385484,31.3631225 C118.696773,32.697809 120.120891,35.164464 120.120891,37.8339264 L120.120891,68.8544207 C120.351395,79.1627498 125.799496,89.1047749 135.381471,94.6368579 C144.963446,100.168048 156.297426,99.9152087 165.339773,94.9611709 L192.204147,79.4513258 C194.515436,78.11655 197.363672,78.11655 199.675854,79.4513258 L252.264593,109.813456 C254.575881,111.147339 256,113.614083 256,116.283635 L256,177.007895 C256,179.677446 254.575881,182.144191 252.264593,183.478966 L199.675854,213.841096 C197.363672,215.175872 194.515436,215.175872 192.204147,213.841096 L165.556875,198.456331 C156.479685,193.387041 145.042067,193.084171 135.384151,198.660031 C125.802176,204.192114 120.354075,214.13414 120.123571,224.441575 L120.123571,255.453225 C120.123571,258.122776 118.699453,260.589521 116.387271,261.924297 L63.7994263,292.286427 C61.4872443,293.621202 58.6390077,293.621202 56.3268258,292.286427 L3.7385338,261.924297 C1.42670919,260.589521 0,258.122776 0,255.453225 L0,194.729858 C0.00259093,192.060306 1.42670919,189.593562 3.7385338,188.258786 L56.3268258,157.896656 C58.6390077,156.56188 61.4872443,156.56188 63.7994263,157.896656 L90.7245531,173.442238 C99.7561793,178.361432 111.057996,178.60087 120.616742,173.082188 C130.274658,167.506328 135.7308,157.449051 135.879108,147.053166 C135.648605,136.744837 130.200504,125.73785 120.619422,120.205767 C111.037447,114.673684 99.7034673,114.926523 90.66112,119.880561 L63.6734534,135.550329 C61.3514438,136.898506 58.4844453,136.897612 56.1642226,135.546755 L3.71450069,105.032743 C1.41473731,103.695287 0,101.234796 0,98.5741786 Z"/>
    `,
);

const DEVIN_CORE: AgentCoreConfig = {
    id: 'devin',
    displayNameKey: 'agentInput.agent.devin',
    subtitleKey: 'profiles.aiBackend.devinSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'devin' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.devin', connectRoute: null },
    flavorAliases: ['devin', 'devin-cli'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('devin'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
        permissionModeMapping: {
  "default": null,
  "plan": "plan",
  "read-only": "ask",
  "safe-yolo": "smart",
  "yolo": "bypass"
},
    },
    sessionModes: {
        kind: getAgentSessionModesKind('devin'),
    },
    model: getAgentModelConfig('devin'),
    resume: buildAgentResumeUiConfig({
        agentId: 'devin',
        uiVendorResumeIdLabelKey: 'sessionInfo.devinSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.devinSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'devin' }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'devin' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'devin' }),
    ui: {
        agentPickerIconName: 'hardware-chip-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const DEVIN_UI: AgentUiConfig = {
    id: 'devin',
    icon: null,
    svgIconXml: DEVIN_SVG_ICON_XML,
    pickerIconScale: 1.1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'DV',
};

const FX_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 24 24',
    `
        <path fill="${theme.colors.text.primary}" fill-rule="nonzero" d="M10.5626937,0 C11.3535073,0 12.2803588,0.21227889 12.8260052,0.458940979 L13.1339591,0.599463625 L12.3850033,2.78503923 L12.0262221,2.65348612 C11.6106338,2.49950918 11.168137,2.36197638 10.652389,2.36197638 C10.1276715,2.36197638 9.80028359,2.47559043 9.54465197,2.73869666 C9.26809144,3.02422671 9.02890396,3.53399503 8.81961491,4.44888715 L8.81961491,4.44888715 L8.81961491,4.44888715 L8.65666844,5.20980232 L11.1277741,5.20980232 L13.9322473,5.22475154 L13.9711153,5.22475154 L13.9935391,5.25763982 L16.6858932,9.21320279 L19.3603082,5.22475154 L22.9675544,5.22475154 L18.6038778,11.4720296 L23.1514298,17.901688 L19.747493,17.901688 L19.7250691,17.8717896 L11.0485433,6.05144327 L10.7809523,7.38491348 L8.19772746,7.38491348 L5.74904562,19.0168997 C5.48593939,20.2875832 5.07633083,21.3534624 4.41707034,22.105408 C3.74286063,22.8737978 2.83544312,23.2834064 1.66043462,23.2834064 C1.03854717,23.2834064 0.525789004,23.1877314 0.101231225,23.0382392 L-0.148420708,22.9500388 L-0.148420708,20.5073367 L-0.0497558722,20.5402249 L0.34340855,20.6717781 C0.739562816,20.8033312 1.07293037,20.8990062 1.48104401,20.8990062 C1.68883813,20.8990062 1.86374398,20.8586433 2.01772092,20.7764226 C2.17169786,20.6942019 2.30923066,20.5701234 2.43480409,20.3967125 C2.70090016,20.0304566 2.91317905,19.4534168 3.08957982,18.6371895 L5.46052572,7.38491348 L3.3840794,7.38491348 L3.66661962,5.89597141 L3.70847743,5.88251711 L5.91797178,5.1529953 L6.11679638,4.28145591 C6.47109283,2.72225252 6.9569424,1.6354444 7.69543375,0.944790551 C8.4473794,0.240682403 9.4026344,0 10.5626937,0 Z M15.9593612,14.8116848 L13.8784301,17.9764341 L10.0618949,17.9764341 L14.0174579,12.2613483 L15.9593612,14.8116848 Z"/>
    `,
);

const FX_CORE: AgentCoreConfig = {
    id: 'fx',
    displayNameKey: 'agentInput.agent.fx',
    subtitleKey: 'profiles.aiBackend.fxSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'fx' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.fx', connectRoute: null },
    flavorAliases: ['fx', 'vercel-fx'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('fx'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
        permissionModeMapping: {
  "default": null,
  "read-only": "ask",
  "safe-yolo": "code"
},
    },
    sessionModes: {
        kind: getAgentSessionModesKind('fx'),
    },
    model: getAgentModelConfig('fx'),
    resume: buildAgentResumeUiConfig({
        agentId: 'fx',
        uiVendorResumeIdLabelKey: 'sessionInfo.fxSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.fxSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'fx' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'fx' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'fx' }),
    ui: {
        agentPickerIconName: 'flash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const FX_UI: AgentUiConfig = {
    id: 'fx',
    icon: null,
    svgIconXml: FX_SVG_ICON_XML,
    pickerIconScale: 1.15,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'FX',
};

const DROID_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 67 65',
    `
        <path fill="${theme.colors.text.primary}" d="M47.75 11.15a.867.867 0 0 1-.671-.806.84.84 0 0 1 .067-.362c1.688-4.007 2.433-7.213 1.23-8.555-3.183-3.56-15.952 3.52-20.024 5.919a.9.9 0 0 1-1.273-.41c-1.711-3.998-3.51-6.78-5.334-6.9-4.833-.323-8.73 13.49-9.87 17.992a.85.85 0 0 1-.459.563.9.9 0 0 1-.737.027c-4.109-1.647-7.398-2.373-8.773-1.2-3.651 3.104 3.609 15.557 6.068 19.528a.85.85 0 0 1-.11 1.031.9.9 0 0 1-.31.21C3.455 39.856.604 41.61.478 43.389c-.329 4.713 13.834 8.513 18.452 9.625q.186.046.337.163a.87.87 0 0 1 .332.642.84.84 0 0 1-.067.362c-1.688 4.007-2.433 7.214-1.23 8.555 3.183 3.561 15.954-3.519 20.025-5.917a.9.9 0 0 1 1.058.107.9.9 0 0 1 .215.302c1.711 3.997 3.509 6.779 5.334 6.9 4.833.322 8.73-13.49 9.868-17.993a.85.85 0 0 1 .168-.33.88.88 0 0 1 .659-.324.9.9 0 0 1 .371.066c4.109 1.647 7.397 2.372 8.773 1.2 3.651-3.105-3.61-15.559-6.07-19.53a.85.85 0 0 1 .111-1.03.9.9 0 0 1 .31-.21c4.1-1.67 6.952-3.424 7.075-5.203.331-4.713-13.833-8.513-18.45-9.623m-5.546-4.518c.93 1.624-3.858 12.446-7.42 20.015a.7.7 0 0 1-.28.303.71.71 0 0 1-.796-.059.7.7 0 0 1-.23-.341c-1.439-4.921-3.082-10.704-4.841-15.612a.84.84 0 0 1 .01-.594.87.87 0 0 1 .401-.446c4.392-2.34 11.908-5.446 13.156-3.266m-21.048 1.34c1.833.507 6.294 11.46 9.264 19.268a.67.67 0 0 1-.2.754.71.71 0 0 1-.794.08c-4.589-2.485-9.94-5.444-14.743-7.702a.87.87 0 0 1-.422-.427.84.84 0 0 1-.04-.591c1.414-4.679 4.471-12.063 6.935-11.383M7.243 23.433c1.664-.906 12.762 3.763 20.522 7.235.13.058.239.154.311.274a.67.67 0 0 1-.06.776.7.7 0 0 1-.35.225c-5.045 1.403-10.976 3.006-16.01 4.721a.9.9 0 0 1-.607-.01.88.88 0 0 1-.456-.391c-2.395-4.284-5.586-11.613-3.35-12.83M8.617 43.96c.519-1.788 11.752-6.14 19.758-9.035a.72.72 0 0 1 .773.195.67.67 0 0 1 .081.774c-2.548 4.475-5.582 9.694-7.898 14.377a.87.87 0 0 1-.437.413.9.9 0 0 1-.607.039c-4.797-1.37-12.37-4.36-11.67-6.763m15.855 13.568c-.93-1.623 3.859-12.446 7.42-20.014a.7.7 0 0 1 .28-.303.715.715 0 0 1 .796.059.7.7 0 0 1 .23.34c1.439 4.92 3.083 10.705 4.841 15.613a.84.84 0 0 1-.01.593.87.87 0 0 1-.402.445c-4.391 2.335-11.908 5.447-13.15 3.267zm21.049-1.34c-1.836-.506-6.297-11.461-9.266-19.269a.67.67 0 0 1 .2-.755.71.71 0 0 1 .795-.078c4.587 2.484 9.94 5.445 14.742 7.703.189.088.339.24.423.426a.84.84 0 0 1 .039.592c-1.413 4.686-4.47 12.063-6.933 11.381m13.912-15.462c-1.665.907-12.762-3.763-20.523-7.236a.7.7 0 0 1-.311-.273.67.67 0 0 1 .06-.777.7.7 0 0 1 .35-.225c5.046-1.402 10.975-3.005 16.009-4.72a.9.9 0 0 1 .609.01.88.88 0 0 1 .457.392c2.393 4.282 5.584 11.613 3.349 12.829M58.06 20.2c-.521 1.79-11.753 6.14-19.759 9.036a.72.72 0 0 1-.774-.195.67.67 0 0 1-.08-.776c2.547-4.474 5.581-9.694 7.897-14.377a.87.87 0 0 1 .437-.412.9.9 0 0 1 .607-.038c4.797 1.377 12.37 4.359 11.672 6.762"/>
    `,
);

const DROID_CORE: AgentCoreConfig = {
    id: 'droid',
    displayNameKey: 'agentInput.agent.droid',
    subtitleKey: 'profiles.aiBackend.droidSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'droid' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.droid', connectRoute: null },
    flavorAliases: ['droid', 'factory', 'factory-droid'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('droid'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('droid'),
    },
    model: getAgentModelConfig('droid'),
    resume: buildAgentResumeUiConfig({
        agentId: 'droid',
        uiVendorResumeIdLabelKey: 'sessionInfo.droidSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.droidSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'droid' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'droid' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'droid' }),
    ui: {
        agentPickerIconName: 'hardware-chip-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const DROID_UI: AgentUiConfig = {
    id: 'droid',
    icon: null,
    svgIconXml: DROID_SVG_ICON_XML,
    pickerIconScale: 1.1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'DR',
};

const CODEBUDDY_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 873 612',
    `
        <path fill="${theme.colors.text.primary}" d="M611.24 0C631.42 0.472994 652.67 0.151247 672.917 0.149414L783.53 0.125977L783.58 114.446C783.58 131.188 782.828 155.62 783.732 171.959C793.764 172.165 866.262 170.817 869.239 173.294C869.728 173.699 870.138 174.379 870.486 174.905L872.008 175.384C873.402 179.664 872.344 228.902 872.338 236.71C872.313 263.731 873.157 518.745 871.959 521.349C871.837 521.605 871.58 521.905 871.415 522.119L869.141 522.375C841.374 521.684 811.566 522.247 783.646 522.271C784.001 538.325 783.695 555.229 783.72 571.344C783.738 583.932 784.056 598.74 783.451 611.182C613.783 610.846 273.598 611.469 87.6807 611.041C87.3452 610.736 87.0093 610.436 86.6738 610.137L86.2393 607.375C86.831 602.028 86.4052 585.668 86.3984 579.416L86.2812 521.838C82.9453 522.522 63.9127 522.272 59.0283 522.266L0.391602 522.259L0.398438 278.798L0.427734 209.334C0.430803 201.523 0.934097 181.445 0 174.62C0.578928 172.779 0.0735528 173.48 1.33105 172.293C17.2444 171.377 36.4875 172.458 52.7188 172.065C59.0087 171.913 81.4327 171.805 86.0195 172.717L85.9805 56.9336L85.9072 21.3467C85.895 15.7024 85.6474 5.58945 86.2832 0.297852L89.3057 0.0224609C145.847 1.00635 204.767 0.149918 261.493 0.137695L261.571 58.8008C261.576 63.634 261.865 82.5764 261.06 86.293C288.984 85.6006 319.108 86.1736 347.17 86.1797L509.068 86.1846L576.67 86.1357C582.985 86.1314 604.124 85.7374 608.728 86.8135C607.982 81.7879 608.33 64.0733 608.33 58.0186L608.428 1.34473C609.424 -0.0534957 608.978 0.391111 611.24 0ZM697.12 173.048C694.553 171.797 619.805 172.389 610.134 172.389L279.41 172.397L201.266 172.392C193.899 172.39 184.497 172.27 176.995 172.399C175.636 172.423 175.324 173.65 174.702 174.81L172.704 175.383C172.033 177.999 172.341 204.836 172.348 208.9L172.398 294.312L172.37 445.969L172.349 494.032C172.347 501.781 172.011 513.954 172.658 521.324C174.533 523.401 174.111 521.52 174.854 522.534C175.611 523.561 175.655 525.034 177.928 525.016C181.545 524.988 185.335 524.97 189.044 524.966H347.752L604.785 524.96L669.054 525.009C673.406 525.009 693.575 525.296 696.857 524.643C697.499 523.408 697.493 523.505 697.542 522.118C696.815 500.607 697.389 475.931 697.389 454.243V327.045L697.383 228.248C697.383 211.843 696.729 190.781 697.64 174.935L697.12 173.048Z"/>
        <path fill="${theme.colors.text.primary}" d="M347.56 260.864L349.808 261.441C351.42 265.483 350.329 418.222 350.229 435.792C344.53 436.85 263.503 436.929 260.894 435.722L261.464 433.765C261.114 420.392 261.416 405.532 261.413 392.005L261.412 313.381C261.422 299.699 262.22 276.275 261.106 263.652C261.428 261.859 261.059 262.619 262.19 261.257C268.232 260.664 277.082 261.319 283.456 261.111C303.554 260.454 327.973 262.241 347.56 260.864Z"/>
        <path fill="${theme.colors.text.primary}" d="M608.752 260.881L610.641 261.353C612.854 266.169 610.268 347.019 611.302 358.962C611.693 363.539 611.436 434.199 610.892 435.767C610.293 435.847 609.248 436.027 608.685 436.028C584.88 436.436 548.549 435.89 523.533 435.943C522.702 435.945 522.567 435.098 522.127 434.149C522.787 429.284 522.445 415.565 522.445 410.114L522.415 362.246L522.457 298.316C522.463 288.598 522.94 272.837 522.097 263.668L522.586 261.78C525.887 259.891 595.756 261.699 608.752 260.881Z"/>
    `,
);

const CODEBUDDY_CORE: AgentCoreConfig = {
    id: 'codebuddy',
    displayNameKey: 'agentInput.agent.codebuddy',
    subtitleKey: 'profiles.aiBackend.codebuddySubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'codebuddy' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.codebuddy', connectRoute: null },
    flavorAliases: ['codebuddy-code'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('codebuddy'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
        permissionModeMapping: {
  "default": null,
  "plan": "plan",
  "read-only": "dontAsk",
  "safe-yolo": "auto",
  "yolo": "bypassPermissions"
},
    },
    sessionModes: {
        kind: getAgentSessionModesKind('codebuddy'),
    },
    model: getAgentModelConfig('codebuddy'),
    resume: buildAgentResumeUiConfig({
        agentId: 'codebuddy',
        uiVendorResumeIdLabelKey: 'sessionInfo.codebuddySessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codebuddySessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'codebuddy' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'codebuddy' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'codebuddy' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const CODEBUDDY_UI: AgentUiConfig = {
    id: 'codebuddy',
    icon: null,
    svgIconXml: CODEBUDDY_SVG_ICON_XML,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.3),
    },
    cliGlyph: 'CB',
};

const PI_CORE: AgentCoreConfig = {
    id: 'pi',
    displayNameKey: 'agentInput.agent.pi',
    subtitleKey: 'profiles.aiBackend.piSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'pi' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.pi', connectRoute: null },
    flavorAliases: ['pi', 'pi-coding-agent'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('pi'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('pi'),
    },
    runtimeInput: {
        inFlightSteerSupported: true,
    },
    model: getAgentModelConfig('pi'),
    resume: buildAgentResumeUiConfig({
        agentId: 'pi',
        uiVendorResumeIdLabelKey: 'sessionInfo.piSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.piSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'pi' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'pi' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const PI_UI: AgentUiConfig = {
    id: 'pi',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.pi ?? null,
    pickerIconScale: 0.9,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'PI',
};

const OH_MY_PI_CORE: AgentCoreConfig = {
    id: 'ohMyPi',
    displayNameKey: 'agentInput.agent.ohMyPi',
    subtitleKey: 'profiles.aiBackend.ohMyPiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'ohMyPi' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.ohMyPi', connectRoute: null },
    flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('ohMyPi'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('ohMyPi'),
    },
    model: getAgentModelConfig('ohMyPi'),
    resume: buildAgentResumeUiConfig({
        agentId: 'ohMyPi',
        uiVendorResumeIdLabelKey: null,
        uiVendorResumeIdCopiedKey: null,
    }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'ohMyPi' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'ohMyPi' }),
    ui: {
        agentPickerIconName: 'planet-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const OH_MY_PI_UI: AgentUiConfig = {
    id: 'ohMyPi',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.ohMyPi ?? null,
    pickerIconScale: 0.9,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'OMP',
};

const COPILOT_CORE: AgentCoreConfig = {
    id: 'copilot',
    displayNameKey: 'agentInput.agent.copilot',
    subtitleKey: 'profiles.aiBackend.copilotSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'copilot' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.connectedServiceLabel.copilot', connectRoute: null },
    flavorAliases: ['copilot', 'github-copilot', 'copilot-cli'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('copilot'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('copilot'),
    },
    model: getAgentModelConfig('copilot'),
    resume: buildAgentResumeUiConfig({
        agentId: 'copilot',
        uiVendorResumeIdLabelKey: 'sessionInfo.copilotSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.copilotSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'copilot' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'copilot' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const COPILOT_UI: AgentUiConfig = {
    id: 'copilot',
    icon: null,
    svgIconXml: AGENT_LOGO_SVG_XML.copilot ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'CP',
};

const CODERABBIT_CORE: AgentCoreConfig = {
    id: 'coderabbit',
    displayNameKey: 'agentInput.agent.coderabbit',
    subtitleKey: 'profiles.aiBackend.coderabbitSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'coderabbit' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.coderabbit', connectRoute: null },
    flavorAliases: ['coderabbit'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('coderabbit'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('coderabbit'),
    },
    model: getAgentModelConfig('coderabbit'),
    resume: buildAgentResumeUiConfig({
        agentId: 'coderabbit',
        uiVendorResumeIdLabelKey: null,
        uiVendorResumeIdCopiedKey: null,
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'coderabbit' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'coderabbit' }),
    ui: {
        agentPickerIconName: 'git-pull-request-outline',
        cliGlyphScale: 0.9,
        profileCompatibilityGlyphScale: 0.9,
    },
};

const CODERABBIT_UI: AgentUiConfig = {
    id: 'coderabbit',
    icon: null,
    svgIconXml: null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'CR',
};

const DEEPSEC_CORE: AgentCoreConfig = {
    id: 'deepsec',
    displayNameKey: 'agentInput.agent.deepsec',
    subtitleKey: 'profiles.aiBackend.deepsecSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'deepsec' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.deepsec', connectRoute: null },
    flavorAliases: ['deepsec'],
    providerOwnedEnvironmentKeys: [],
    cli: buildCatalogAgentCliUiConfig('deepsec'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('deepsec'),
    },
    model: getAgentModelConfig('deepsec'),
    resume: buildAgentResumeUiConfig({
        agentId: 'deepsec',
        uiVendorResumeIdLabelKey: null,
        uiVendorResumeIdCopiedKey: null,
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'deepsec' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'deepsec' }),
    ui: {
        agentPickerIconName: 'shield-checkmark-outline',
        cliGlyphScale: 0.9,
        profileCompatibilityGlyphScale: 0.9,
    },
};

const DEEPSEC_UI: AgentUiConfig = {
    id: 'deepsec',
    icon: null,
    svgIconXml: null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'DS',
};

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-antigravity",
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-channel-discord",
  "@happier-dev/plugins-channel-telegram",
  "@happier-dev/plugins-channels",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-cliproxyapi",
  "@happier-dev/plugins-codebuddy",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-deepseek",
  "@happier-dev/plugins-devin",
  "@happier-dev/plugins-droid",
  "@happier-dev/plugins-elevenlabs",
  "@happier-dev/plugins-fx",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-google",
  "@happier-dev/plugins-grok",
  "@happier-dev/plugins-inspector",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-kiro",
  "@happier-dev/plugins-lmstudio",
  "@happier-dev/plugins-minimax",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-ollama",
  "@happier-dev/plugins-openai",
  "@happier-dev/plugins-openai-compat",
  "@happier-dev/plugins-openai-models",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-openrouter",
  "@happier-dev/plugins-pi",
  "@happier-dev/plugins-posthog",
  "@happier-dev/plugins-qwen",
  "@happier-dev/plugins-review-coderabbit",
  "@happier-dev/plugins-review-deepsec",
  "@happier-dev/plugins-scm-azure-devops",
  "@happier-dev/plugins-scm-bitbucket",
  "@happier-dev/plugins-scm-git",
  "@happier-dev/plugins-scm-github",
  "@happier-dev/plugins-scm-gitlab",
  "@happier-dev/plugins-scm-sapling",
  "@happier-dev/plugins-sentry",
  "@happier-dev/plugins-triage",
  "@happier-dev/plugins-xai",
  "@happier-dev/plugins-zai",
]);

export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCoreConfig>> = Object.freeze({
    claude: CLAUDE_CORE,
    codex: CODEX_CORE,
    cursor: CURSOR_CORE,
    opencode: OPENCODE_CORE,
    antigravity: ANTIGRAVITY_CORE,
    gemini: GEMINI_CORE,
    grok: GROK_CORE,
    auggie: AUGGIE_CORE,
    qwen: QWEN_CORE,
    kimi: KIMI_CORE,
    kilo: KILO_CORE,
    kiro: KIRO_CORE,
    devin: DEVIN_CORE,
    fx: FX_CORE,
    droid: DROID_CORE,
    codebuddy: CODEBUDDY_CORE,
    pi: PI_CORE,
    ohMyPi: OH_MY_PI_CORE,
    copilot: COPILOT_CORE,
    coderabbit: CODERABBIT_CORE,
    deepsec: DEEPSEC_CORE,
} satisfies Readonly<Record<CanonicalAgentId, AgentCoreConfig>>);

export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Record<CanonicalAgentId, AgentUiConfig>> = Object.freeze({
    claude: CLAUDE_UI,
    codex: CODEX_UI,
    cursor: CURSOR_UI,
    opencode: OPENCODE_UI,
    antigravity: ANTIGRAVITY_UI,
    gemini: GEMINI_UI,
    grok: GROK_UI,
    auggie: AUGGIE_UI,
    qwen: QWEN_UI,
    kimi: KIMI_UI,
    kilo: KILO_UI,
    kiro: KIRO_UI,
    devin: DEVIN_UI,
    fx: FX_UI,
    droid: DROID_UI,
    codebuddy: CODEBUDDY_UI,
    pi: PI_UI,
    ohMyPi: OH_MY_PI_UI,
    copilot: COPILOT_UI,
    coderabbit: CODERABBIT_UI,
    deepsec: DEEPSEC_UI,
} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);
