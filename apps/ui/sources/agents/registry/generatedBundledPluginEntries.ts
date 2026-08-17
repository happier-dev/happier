/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled plugins.
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
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
  "@happier-dev/plugins-channel-telegram",
  "@happier-dev/plugins-channels",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-cliproxyapi",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-deepseek",
  "@happier-dev/plugins-elevenlabs",
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

export const BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES: Readonly<Record<
  CanonicalAgentId,
  Readonly<{ pluginId: string; localId: string }>
>> = Object.freeze({
    claude: Object.freeze({
        pluginId: "happier.agent.claude",
        localId: "claude",
    }),
    codex: Object.freeze({
        pluginId: "happier.agent.codex",
        localId: "codex",
    }),
    cursor: Object.freeze({
        pluginId: "happier.agent.cursor",
        localId: "cursor",
    }),
    opencode: Object.freeze({
        pluginId: "happier.agent.opencode",
        localId: "opencode",
    }),
    antigravity: Object.freeze({
        pluginId: "happier.agent.antigravity",
        localId: "antigravity",
    }),
    gemini: Object.freeze({
        pluginId: "happier.agent.gemini",
        localId: "gemini",
    }),
    grok: Object.freeze({
        pluginId: "happier.agent.grok",
        localId: "grok",
    }),
    auggie: Object.freeze({
        pluginId: "happier.agent.auggie",
        localId: "auggie",
    }),
    qwen: Object.freeze({
        pluginId: "happier.agent.qwen",
        localId: "qwen",
    }),
    kimi: Object.freeze({
        pluginId: "happier.agent.kimi",
        localId: "kimi",
    }),
    kilo: Object.freeze({
        pluginId: "happier.agent.kilo",
        localId: "kilo",
    }),
    kiro: Object.freeze({
        pluginId: "happier.agent.kiro",
        localId: "kiro",
    }),
    pi: Object.freeze({
        pluginId: "happier.agent.pi",
        localId: "pi",
    }),
    ohMyPi: Object.freeze({
        pluginId: "happier.agent.ohmypi",
        localId: "ohmypi",
    }),
    copilot: Object.freeze({
        pluginId: "happier.agent.copilot",
        localId: "copilot",
    }),
    coderabbit: Object.freeze({
        pluginId: "happier.review.coderabbit",
        localId: "coderabbit",
    }),
    deepsec: Object.freeze({
        pluginId: "happier.review.deepsec",
        localId: "deepsec",
    }),
});

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
    pi: PI_UI,
    ohMyPi: OH_MY_PI_UI,
    copilot: COPILOT_UI,
    coderabbit: CODERABBIT_UI,
    deepsec: DEEPSEC_UI,
} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);
