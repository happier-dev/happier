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
import type { PluginAgentAcpDefinitionV2, PluginAgentCliMetadata, PluginAgentContributionV2, PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type { PluginSettingsContributionV2 } from '@happier-dev/protocol/plugins/contributions/settings';
import type { ProviderContributionV1 } from '@happier-dev/protocol/providers/contributions';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/protocol';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { AgentIconSvgXmlResolver, AgentUiConfig } from './registryUi';
import { AGENT_LOGO_SVG_XML } from './agentLogoSvgXml';

import { buildCatalogAgentCliUiConfig } from '@/agents/registry/buildCatalogAgentCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';
import { readBundledAgentPresentation } from '@happier-dev/agents/presentation';

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
        agentPickerIconName: 'sparkle',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1.14,
    },
};

const CLAUDE_UI: AgentUiConfig = {
    id: 'claude',
    icon: null,
    identityColor: readBundledAgentPresentation('claude')?.identityColor ?? undefined,
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
        agentPickerIconName: 'terminal',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.82,
    },
};

const CODEX_UI: AgentUiConfig = {
    id: 'codex',
    icon: null,
    identityColor: readBundledAgentPresentation('codex')?.identityColor ?? undefined,
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
        agentPickerIconName: 'code',
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
        agentPickerIconName: 'code',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const OPENCODE_UI: AgentUiConfig = {
    id: 'opencode',
    icon: null,
    identityColor: readBundledAgentPresentation('opencode')?.identityColor ?? undefined,
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
    uiConnectedService: { serviceId: 'happier.agent.antigravity/antigravity-account', labelKey: 'agentInput.agent.antigravity', connectRoute: null },
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
        agentPickerIconName: 'rocket',
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
    providerOwnedEnvironmentKeys: ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_CLI_CUSTOM_HEADERS', 'GEMINI_API_KEY_AUTH_MECHANISM', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GEMINI_CLI_AUTH_OVERRIDE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS', 'HAPPIER_GEMINI_ACP_AUTH_METHOD', 'HAPPIER_GEMINI_ACP_AUTH_META'],
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
        agentPickerIconName: 'globe',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 0.88,
    },
};

const GEMINI_UI: AgentUiConfig = {
    id: 'gemini',
    icon: null,
    identityColor: readBundledAgentPresentation('gemini')?.identityColor ?? undefined,
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
        agentPickerIconName: 'lightning',
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
        agentPickerIconName: 'sparkle',
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
        agentPickerIconName: 'code',
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
        agentPickerIconName: 'code',
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
    providerOwnedEnvironmentKeys: ['HAPPIER_KILO_PROVIDER_API_KEY', 'KILO_CONFIG_CONTENT', 'KILO_AUTH_CONTENT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
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
        agentPickerIconName: 'code',
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
        agentPickerIconName: 'lightning',
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
        agentPickerIconName: 'cpu',
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
    providerOwnedEnvironmentKeys: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'FX_PROVIDER', 'FX_MODEL', 'FX_AUTH_MODE', 'FX_GATEWAY_BASE_URL', 'FX_E2E_GATEWAY_CHAT_URL', 'FX_E2E_GATEWAY_MODELS_URL', 'FX_E2E_GATEWAY_CREDITS_URL'],
    cli: buildCatalogAgentCliUiConfig('fx'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
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
        agentPickerIconName: 'lightning',
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
    providerOwnedEnvironmentKeys: ['HAPPIER_DROID_PROVIDER_API_KEY', 'FACTORY_API_KEY'],
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
        agentPickerIconName: 'cpu',
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
        agentPickerIconName: 'code',
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
        agentPickerIconName: 'code',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
    },
};

const PI_UI: AgentUiConfig = {
    id: 'pi',
    icon: null,
    identityColor: readBundledAgentPresentation('pi')?.identityColor ?? undefined,
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
        agentPickerIconName: 'globe',
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
    providerOwnedEnvironmentKeys: ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_MODEL', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_PROVIDER_WIRE_API', 'COPILOT_PROVIDER_WIRE_MODEL', 'COPILOT_PROVIDER_MODEL_ID', 'COPILOT_PROVIDER_AZURE_API_VERSION', 'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS'],
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
        agentPickerIconName: 'code',
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

const CODERABBIT_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 24 24',
    `
        <path fill="${theme.colors.text.primary}" fill-rule="evenodd" d="M6 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-1 4h2v8H5Zm1 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm12-2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM12 2 8 6l4 4V7h2a3 3 0 0 1 3 3v6h2v-6a5 5 0 0 0-5-5h-2Z"/>
    `,
);

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
        agentPickerIconName: 'git-pull-request',
        cliGlyphScale: 0.9,
        profileCompatibilityGlyphScale: 0.9,
    },
};

const CODERABBIT_UI: AgentUiConfig = {
    id: 'coderabbit',
    icon: null,
    svgIconXml: CODERABBIT_SVG_ICON_XML,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'CR',
};

const DEEPSEC_SVG_ICON_XML: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(
    '0 0 24 24',
    `
        <path fill="${theme.colors.text.primary}" fill-rule="evenodd" d="M12 2 3 5v6c0 5 3 8 9 11 6-3 9-6 9-11V5Zm0 2.1L19 6.4V11c0 4-2.4 6.6-7 8.8C7.4 17.6 5 15 5 11V6.4ZM9 10l-1.4 1.4L11 15l6-6-1.4-1.4L11 12.2Z"/>
    `,
);

const DEEPSEC_CORE: AgentCoreConfig = {
    id: 'deepsec',
    displayNameKey: 'agentInput.agent.deepsec',
    subtitleKey: 'profiles.aiBackend.deepsecSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'deepsec' }),
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.deepsec', connectRoute: null },
    flavorAliases: ['deepsec'],
    providerOwnedEnvironmentKeys: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
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
        agentPickerIconName: 'shield-check',
        cliGlyphScale: 0.9,
        profileCompatibilityGlyphScale: 0.9,
    },
};

const DEEPSEC_UI: AgentUiConfig = {
    id: 'deepsec',
    icon: null,
    svgIconXml: DEEPSEC_SVG_ICON_XML,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'DS',
};

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-antigravity",
  "@happier-dev/plugins-app-context",
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-backup-destinations",
  "@happier-dev/plugins-channel-discord",
  "@happier-dev/plugins-channel-email",
  "@happier-dev/plugins-channel-slack",
  "@happier-dev/plugins-channel-telegram",
  "@happier-dev/plugins-channels",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-cliproxyapi",
  "@happier-dev/plugins-cloudflare-ai-gateway",
  "@happier-dev/plugins-codebuddy",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-custom-acp",
  "@happier-dev/plugins-deepseek",
  "@happier-dev/plugins-deploy-cloudflare",
  "@happier-dev/plugins-deploy-vercel",
  "@happier-dev/plugins-deployment-neon",
  "@happier-dev/plugins-deployment-supabase",
  "@happier-dev/plugins-deployment-templates",
  "@happier-dev/plugins-devin",
  "@happier-dev/plugins-droid",
  "@happier-dev/plugins-elevenlabs",
  "@happier-dev/plugins-fx",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-google",
  "@happier-dev/plugins-grok",
  "@happier-dev/plugins-inspector",
  "@happier-dev/plugins-jira",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-kiro",
  "@happier-dev/plugins-lang-markdown",
  "@happier-dev/plugins-lang-typescript",
  "@happier-dev/plugins-lang-web",
  "@happier-dev/plugins-linear",
  "@happier-dev/plugins-lmstudio",
  "@happier-dev/plugins-machine-agent37",
  "@happier-dev/plugins-machine-boat",
  "@happier-dev/plugins-machine-crabbox",
  "@happier-dev/plugins-machine-cua",
  "@happier-dev/plugins-machine-daytona",
  "@happier-dev/plugins-machine-digitalocean",
  "@happier-dev/plugins-machine-docker-sandboxes",
  "@happier-dev/plugins-machine-e2b",
  "@happier-dev/plugins-machine-fly",
  "@happier-dev/plugins-machine-freestyle",
  "@happier-dev/plugins-machine-hetzner",
  "@happier-dev/plugins-machine-lima",
  "@happier-dev/plugins-machine-lume",
  "@happier-dev/plugins-machine-maritime",
  "@happier-dev/plugins-machine-modal",
  "@happier-dev/plugins-machine-railway",
  "@happier-dev/plugins-machine-recipes",
  "@happier-dev/plugins-machine-services",
  "@happier-dev/plugins-machine-superserve",
  "@happier-dev/plugins-machine-upstash-box",
  "@happier-dev/plugins-machine-vercel",
  "@happier-dev/plugins-minimax",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-ollama",
  "@happier-dev/plugins-onepassword",
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
  "@happier-dev/plugins-vercel-ai-gateway",
  "@happier-dev/plugins-xai",
  "@happier-dev/plugins-zai",
]);

/** First-party manifest presentation only; no installation or execution authority. */
export const BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION: Readonly<Record<string, Readonly<{ displayName: PluginLocalizedStringV2; description?: PluginLocalizedStringV2 }>>> = Object.freeze({
  "happier.agent.antigravity": Object.freeze({
  "displayName": "Antigravity"
}),
  "happier.app-context": Object.freeze({
  "description": "Attach captured app context and transcript annotations to an Agent message.",
  "displayName": "App context"
}),
  "happier.agent.auggie": Object.freeze({
  "displayName": "Auggie"
}),
  "happier.backup.destinations": Object.freeze({
  "displayName": "Backup destinations"
}),
  "happier.channel.discord": Object.freeze({
  "description": "Connects Discord conversations to Happier Channels.",
  "displayName": "Discord Channels"
}),
  "happier.channel.email": Object.freeze({
  "description": "Connects authenticated mailbox conversations to Happier Channels.",
  "displayName": "Email Channels"
}),
  "happier.channel.slack": Object.freeze({
  "description": "Connects Slack conversations to Happier Channels.",
  "displayName": "Slack Channels"
}),
  "happier.channel.telegram": Object.freeze({
  "description": "Connects Telegram bot conversations to Happier Channels.",
  "displayName": "Telegram Channels"
}),
  "happier.channels": Object.freeze({
  "description": "Connects external conversations to Happier sessions and workflows.",
  "displayName": "Conversation Channels"
}),
  "happier.agent.claude": Object.freeze({
  "description": "Claude Code coding agent.",
  "displayName": "Claude"
}),
  "happier.provider.cliproxyapi": Object.freeze({
  "description": "Use models served by an external or locally detected CLIProxyAPI gateway.",
  "displayName": "CLIProxyAPI"
}),
  "happier.provider.cloudflare-ai-gateway": Object.freeze({
  "description": "Use Cloudflare AI Gateway with an account gateway token; Claude pass-through also uses your own Anthropic API key.",
  "displayName": "Cloudflare AI Gateway"
}),
  "happier.agent.codebuddy": Object.freeze({
  "displayName": "CodeBuddy"
}),
  "happier.agent.codex": Object.freeze({
  "description": "OpenAI Codex coding agent.",
  "displayName": "Codex"
}),
  "happier.agent.copilot": Object.freeze({
  "displayName": "GitHub Copilot"
}),
  "happier.agent.cursor": Object.freeze({
  "displayName": "Cursor"
}),
  "happier.agent.custom-acp": Object.freeze({
  "displayName": "Custom ACP Agent"
}),
  "happier.provider.deepseek": Object.freeze({
  "description": "Use DeepSeek models through Anthropic- or OpenAI-compatible agents.",
  "displayName": "DeepSeek"
}),
  "happier.deploy.cloudflare": Object.freeze({
  "displayName": "Cloudflare deployments"
}),
  "happier.deploy.vercel": Object.freeze({
  "displayName": "Vercel deployments"
}),
  "happier.deploy.neon": Object.freeze({
  "displayName": "Neon deployments"
}),
  "happier.deploy.supabase": Object.freeze({
  "displayName": "Supabase deployments"
}),
  "happier.deployment.templates": Object.freeze({
  "displayName": "Deployment templates"
}),
  "happier.agent.devin": Object.freeze({
  "displayName": "Devin"
}),
  "happier.agent.droid": Object.freeze({
  "displayName": "Factory Droid"
}),
  "happier.voice.elevenlabs": Object.freeze({
  "displayName": "ElevenLabs Voice"
}),
  "happier.agent.fx": Object.freeze({
  "displayName": "FX"
}),
  "happier.agent.gemini": Object.freeze({
  "displayName": "Gemini"
}),
  "happier.voice.google": Object.freeze({
  "description": "Google Gemini speech-to-text and Google Cloud text-to-speech.",
  "displayName": "Google Voice"
}),
  "happier.agent.grok": Object.freeze({
  "displayName": "Grok"
}),
  "happier.inspector": Object.freeze({
  "description": "First-party Plugin SDK inspector for installed plugin state and reload diagnostics.",
  "displayName": "Plugin Inspector"
}),
  "happier.jira": Object.freeze({
  "description": "Jira Cloud issues, native workflows and linked work in PRs, Issues & Tasks.",
  "displayName": "Jira"
}),
  "happier.agent.kilo": Object.freeze({
  "displayName": "Kilo"
}),
  "happier.agent.kimi": Object.freeze({
  "displayName": "Kimi"
}),
  "happier.agent.kiro": Object.freeze({
  "displayName": "Kiro"
}),
  "happier.language.markdown": Object.freeze({
  "description": "Markdown links, headings, references and diagnostics on the workspace Machine.",
  "displayName": "Markdown"
}),
  "happier.language.typescript": Object.freeze({
  "description": "TypeScript and JavaScript language intelligence on the workspace Machine.",
  "displayName": "TypeScript"
}),
  "happier.language.web": Object.freeze({
  "description": "JSON, CSS, SCSS, Less and HTML language intelligence on the workspace Machine.",
  "displayName": "Web languages"
}),
  "happier.linear": Object.freeze({
  "description": "Live Linear team issues in PRs, Issues & Tasks.",
  "displayName": "Linear"
}),
  "happier.provider.lmstudio": Object.freeze({
  "description": "Use models served locally by LM Studio 0.4.1 or newer.",
  "displayName": "LM Studio"
}),
  "happier.machine.agent37": Object.freeze({
  "description": "Persistent Agent37 Ubuntu VMs, coding containers or dedicated Performance machines, connected as ordinary Happier Machines.",
  "displayName": "Agent37 Machines"
}),
  "happier.machine.boat": Object.freeze({
  "description": "Create and manage Boat sandboxes as ordinary Happier Machines.",
  "displayName": "Boat Machines"
}),
  "happier.machine.crabbox": Object.freeze({
  "description": "Native Crabbox leases with exact resource custody and host-owned SSH enrollment.",
  "displayName": "Crabbox Machines"
}),
  "happier.machine.cua": Object.freeze({
  "description": "Exact Cua local and BYOC resources with private native bootstrap IO.",
  "displayName": "Cua Machines"
}),
  "happier.machine.daytona": Object.freeze({
  "description": "Create and manage Daytona sandboxes as ordinary Happier Machines.",
  "displayName": "Daytona Machines"
}),
  "happier.machine.digitalocean": Object.freeze({
  "description": "Manage exact reviewed DigitalOcean resources through captured cloud credentials.",
  "displayName": "DigitalOcean Machines"
}),
  "happier.machine.docker-sandboxes": Object.freeze({
  "description": "Native local Docker Sandboxes with retained names and private bootstrap IO.",
  "displayName": "Docker Sandbox Machines"
}),
  "happier.machine.e2b": Object.freeze({
  "description": "A Linux sandbox on E2B, connected as an ordinary Happier Machine.",
  "displayName": "E2B Machines"
}),
  "happier.machine.fly": Object.freeze({
  "description": "Native Fly Machine control and private buffered bootstrap IO.",
  "displayName": "Fly Machines"
}),
  "happier.machine.freestyle": Object.freeze({
  "description": "Create and manage Freestyle VMs as ordinary Happier Machines.",
  "displayName": "Freestyle Machines"
}),
  "happier.machine.hetzner": Object.freeze({
  "description": "Manage exact reviewed Hetzner resources through captured cloud credentials.",
  "displayName": "Hetzner Machines"
}),
  "happier.machine.lima": Object.freeze({
  "description": "Managed local Lima guests using native, private bootstrap IO.",
  "displayName": "Lima Machines"
}),
  "happier.machine.lume": Object.freeze({
  "description": "Managed Lume guests on the selected Apple silicon Mac.",
  "displayName": "Lume Machines"
}),
  "happier.machine.maritime": Object.freeze({
  "description": "A persistent Linux machine. Idle machines may sleep; Happier resumes them before work.",
  "displayName": "Maritime Machines"
}),
  "happier.machine.modal": Object.freeze({
  "description": "Finite Modal Sandboxes with private native bootstrap IO.",
  "displayName": "Modal Machines"
}),
  "happier.machine.railway": Object.freeze({
  "description": "Create and manage Railway sandboxes as ordinary Happier Machines.",
  "displayName": "Railway Machines"
}),
  "happier.machine.recipes": Object.freeze({
  "description": "Declarative software choices for machine setup.",
  "displayName": "Machine recipes"
}),
  "happier.machine.services": Object.freeze({
  "description": "Observe and control existing native services on the selected Machine.",
  "displayName": "Machine services"
}),
  "happier.machine.superserve": Object.freeze({
  "description": "Create and manage Superserve sandboxes as ordinary Happier Machines.",
  "displayName": "Superserve Machines"
}),
  "happier.machine.upstash-box": Object.freeze({
  "description": "Create and manage Upstash Box sandboxes as ordinary Happier Machines.",
  "displayName": "Upstash Box Machines"
}),
  "happier.machine.vercel": Object.freeze({
  "description": {
    "fallback": "Sandboxes that keep their files between runs.",
    "key": "machineVercel.description"
  },
  "displayName": "Vercel Machines"
}),
  "happier.provider.minimax": Object.freeze({
  "description": "Use MiniMax models through compatible agents on the global or China endpoint.",
  "displayName": "MiniMax"
}),
  "happier.agent.ohmypi": Object.freeze({
  "displayName": "Oh My Pi"
}),
  "happier.provider.ollama": Object.freeze({
  "description": "Use models served locally by Ollama.",
  "displayName": "Ollama"
}),
  "happier.secret-source.onepassword": Object.freeze({
  "description": "Link, read and store Saved Secret fields using 1Password CLI on this Machine.",
  "displayName": "1Password"
}),
  "happier.voice.openai": Object.freeze({
  "displayName": "OpenAI Realtime Voice"
}),
  "happier.voice.openai-compat": Object.freeze({
  "description": "Batch speech-to-text and text-to-speech through a selected-machine OpenAI-compatible endpoint.",
  "displayName": "OpenAI-compatible Speech"
}),
  "happier.provider.openai": Object.freeze({
  "description": "Use OpenAI API models through a SavedSecret-backed provider connection.",
  "displayName": "OpenAI"
}),
  "happier.agent.opencode": Object.freeze({
  "displayName": "OpenCode"
}),
  "happier.provider.openrouter": Object.freeze({
  "description": "Use OpenRouter models through one provider connection.",
  "displayName": "OpenRouter"
}),
  "happier.agent.pi": Object.freeze({
  "displayName": "Pi"
}),
  "happier.posthog": Object.freeze({
  "description": "Brings PostHog error issues into PRs & Issues with their own detail body.",
  "displayName": "PostHog"
}),
  "happier.agent.qwen": Object.freeze({
  "displayName": "Qwen Code"
}),
  "happier.review.coderabbit": Object.freeze({
  "description": "Runs CodeRabbit as a review-only execution engine.",
  "displayName": "CodeRabbit review engine"
}),
  "happier.review.deepsec": Object.freeze({
  "description": "Runs DeepSec as a review and security-review execution engine.",
  "displayName": "DeepSec review engine"
}),
  "happier.scm.forge.azure-devops": Object.freeze({
  "description": "Detects Azure DevOps remotes, provides Azure Repos operations, and brings its pull requests into PRs & Issues.",
  "displayName": "Azure DevOps SCM hosting provider"
}),
  "happier.scm.forge.bitbucket": Object.freeze({
  "description": "Detects Bitbucket Cloud remotes, provides repository operations, and brings its pull requests into PRs & Issues.",
  "displayName": "Bitbucket SCM hosting provider"
}),
  "happier.scm.backend.git": Object.freeze({
  "description": "First-party local Git SCM backend.",
  "displayName": "Git SCM backend"
}),
  "happier.scm.forge.github": Object.freeze({
  "description": "Detects GitHub remotes and provides GitHub repository operations.",
  "displayName": "GitHub SCM hosting provider"
}),
  "happier.scm.forge.gitlab": Object.freeze({
  "description": "Detects GitLab remotes and provides GitLab repository operations.",
  "displayName": "GitLab SCM hosting provider"
}),
  "happier.scm.backend.sapling": Object.freeze({
  "description": "Provides the first-party local Sapling SCM backend with audited limited capabilities.",
  "displayName": "Sapling SCM backend"
}),
  "happier.sentry": Object.freeze({
  "description": "Brings Sentry error issues into PRs & Issues with their own detail body.",
  "displayName": "Sentry"
}),
  "happier.triage": Object.freeze({
  "description": "Aggregates pull requests, issues and error groups from configured sources into one reviewable surface.",
  "displayName": "PRs, Issues & Tasks"
}),
  "happier.provider.vercel-ai-gateway": Object.freeze({
  "description": "Use Vercel AI Gateway models through one provider connection.",
  "displayName": "Vercel AI Gateway"
}),
  "happier.voice.xai": Object.freeze({
  "displayName": "xAI Grok Voice"
}),
  "happier.provider.zai": Object.freeze({
  "description": "Use Z.AI Coding Plan models through compatible agents.",
  "displayName": "Z.AI"
}),
});

export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Partial<Record<CanonicalAgentId, AgentCoreConfig>>> = Object.freeze({
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
} satisfies Readonly<Partial<Record<CanonicalAgentId, AgentCoreConfig>>>);

export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Partial<Record<CanonicalAgentId, AgentUiConfig>>> = Object.freeze({
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
} satisfies Readonly<Partial<Record<CanonicalAgentId, AgentUiConfig>>>);

/** Admitted bundled declarations only; no installed version, runtime generation or activation authority. */
export type BundledAgentDeclaration = Readonly<{
    identity: PluginContributionIdentityV1;
    acpStderrRules: PluginAgentAcpDefinitionV2['stderrRules'] | null;
    cli: PluginAgentCliMetadata | null;
    acpRegistryIds?: readonly string[];
    connectedAccounts: NonNullable<PluginAgentContributionV2['connectedAccounts']>;
    providerStateSharing: PluginAgentContributionV2['capabilities']['providerStateSharing'] | null;
    accountSettings: readonly PluginSettingsContributionV2[];
    providerRequirements: PluginAgentContributionV2['providerRequirements'] | null;
}>;
export const BUNDLED_CANONICAL_AGENT_DECLARATIONS: Readonly<Partial<Record<CanonicalAgentId, BundledAgentDeclaration>>> = Object.freeze({
    'antigravity': {"identity":{"pluginId":"happier.agent.antigravity","localId":"antigravity"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":[],"kind":"primary","target":"agent_acp"}],"machineLoginKey":"antigravity-cli","support":"login_terminal"},"displayName":"Antigravity CLI","executable":{"binaryName":"agy","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://antigravity.google/docs/cli-install","guideUrl":"https://antigravity.google/docs/cli-install","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://antigravity.google/cli/install.sh | bash"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://antigravity.google/cli/install.sh | bash"],"cmd":"bash"}],"win32":[{"args":["-NoProfile","-ExecutionPolicy","Bypass","-Command","irm https://antigravity.google/cli/install.ps1 | iex"],"cmd":"powershell.exe"}]}}}},"acpRegistryIds":["antigravity-acp"],"connectedAccounts":[{"credentialKinds":["oauth"],"materializationKinds":["files","environment"],"purpose":"model_upstream","required":false,"service":"antigravity-account"}],"providerStateSharing":{"config":{"modes":["linked","copied","isolated"],"supported":true},"state":{"modes":["isolated","shared"],"sharedStatePrivacyRiskAcknowledgementRequired":true,"supported":true}},"accountSettings":[],"providerRequirements":null},
    'auggie': {"identity":{"pluginId":"happier.agent.auggie","localId":"auggie"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":["login"],"kind":"primary"}],"support":"login_terminal"},"displayName":"Auggie CLI","executable":{"binaryName":"auggie","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://augmentcode.com","managed":{"binaryName":"auggie","kind":"managed_package","packageName":"@augmentcode/auggie"},"manual":{"kind":"command"}}},"acpRegistryIds":["auggie"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[{"actions":[],"fields":[],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"green"},"ionName":"sparkle"},"sections":[],"subagentSections":[]},"scope":"account","target":{"agent":"auggie","kind":"agent"},"title":{"fallback":"Auggie","key":"settingsAgents.plugins.auggie.title"},"version":1}],"providerRequirements":null},
    'claude': {"identity":{"pluginId":"happier.agent.claude","localId":"claude"},"acpStderrRules":null,"cli":{"auth":{"credentialPaths":["~/.claude/.credentials.json","~/.claude/.claude.json"],"environmentVariables":["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN"],"loginLaunches":[{"args":[],"initialInput":"/login\r","kind":"primary"}],"machineLoginKey":"claude-code","nonInteractiveStatusProbe":true,"support":"login_terminal"},"displayName":"Claude Code CLI","executable":{"acceptsJavaScriptFileOverride":true,"binaryName":"claude","knownUserBinDirSuffixes":[".local/bin"],"sourcePreference":"system-first","systemCommandResolutionStrategy":"known-user-first-runnable"},"install":{"docsUrl":"https://claude.ai","guideUrl":"https://code.claude.com/docs/en/setup","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://claude.ai/install.sh | bash"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://claude.ai/install.sh | bash"],"cmd":"bash"}],"win32":[{"args":["-NoProfile","-ExecutionPolicy","Bypass","-Command","irm https://claude.ai/install.ps1 | iex"],"cmd":"powershell.exe"}]}},"nativeUpdate":{"args":["update"],"installPaths":[".local/share/claude",".local/bin/claude.exe"]},"npmPackageName":"@anthropic-ai/claude-code","recommendationOrder":10}},"acpRegistryIds":["claude-acp"],"connectedAccounts":[{"credentialKinds":["oauth","token"],"materializationKinds":["environment","files","httpHeaders"],"purpose":"model_upstream","required":false,"service":"claude-subscription"},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"model_upstream_api_key","required":false,"service":"anthropic"}],"providerStateSharing":{"config":{"modes":["linked","copied","isolated"],"supported":true},"state":{"modes":["isolated","shared"],"sharedStatePrivacyRiskAcknowledgementRequired":true,"supported":true}},"accountSettings":[{"actions":[],"fields":[{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":true,"description":{"fallback":"Query Anthropic for the models available to the selected connected account or native Claude Code login.","key":"settingsAgents.plugins.claude.fields.claudeDynamicModelProbeEnabled.subtitle"},"id":"claudeDynamicModelProbeEnabled","presentation":{"control":"switch"},"schema":{"description":"Enable dynamic Claude model discovery","type":"boolean"},"title":{"fallback":"Discover models dynamically","key":"settingsAgents.plugins.claude.fields.claudeDynamicModelProbeEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":true,"description":{"fallback":"Use the Claude Agent SDK runtime for remote mode.","key":"settingsAgents.plugins.claude.fields.claudeRemoteAgentSdkEnabled.subtitle"},"id":"claudeRemoteAgentSdkEnabled","presentation":{"control":"switch"},"schema":{"description":"Use Claude Agent SDK in remote mode","type":"boolean"},"title":{"fallback":"Use Agent SDK (remote)","key":"settingsAgents.plugins.claude.fields.claudeRemoteAgentSdkEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Keep Claude Code as the canonical terminal session and send supported Happier prompts into that session.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalEnabled.subtitle"},"id":"claudeUnifiedTerminalEnabled","presentation":{"control":"switch"},"schema":{"description":"Enable Claude unified terminal runtime","type":"boolean"},"title":{"fallback":"Use unified terminal mode","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Use Happier attribution for new Claude sessions, including Agent SDK runs. Off keeps runtime defaults.","key":"settingsAgents.plugins.claude.fields.claudeCodeIncludeInNativeHistory.subtitle"},"id":"claudeCodeIncludeInNativeHistory","presentation":{"control":"switch"},"schema":{"description":"Use Happier attribution for Claude session history","type":"boolean"},"title":{"fallback":"Show sessions in Claude Code","key":"settingsAgents.plugins.claude.fields.claudeCodeIncludeInNativeHistory.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Enable Claude Code experimental Agent Teams in every Claude session started by Happier.","key":"settingsAgents.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.subtitle"},"id":"claudeCodeExperimentalAgentTeamsEnabled","presentation":{"control":"switch"},"schema":{"description":"Force-enable Claude experimental agent teams","type":"boolean"},"title":{"fallback":"Force-enable Agent Teams","key":"settingsAgents.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":"auto","description":{"fallback":"Choose which terminal host Happier uses for unified Claude sessions.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.subtitle"},"id":"claudeUnifiedTerminalHost","presentation":{"control":"select","options":[{"description":{"fallback":"Prefer the best supported host on this machine.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.subtitle"},"title":{"fallback":"Auto","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title"},"value":"auto"},{"description":{"fallback":"Use tmux when it is available.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.subtitle"},"title":{"fallback":"tmux","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title"},"value":"tmux"},{"description":{"fallback":"Use Zellij when it is available and supported.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.subtitle"},"title":{"fallback":"Zellij","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title"},"value":"zellij"},{"description":{"fallback":"Use Herdr for terminal sessions on this machine.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.herdr.subtitle"},"title":{"fallback":"Herdr","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.herdr.title"},"value":"herdr"}]},"schema":{"description":"Claude unified terminal host adapter preference","enum":["auto","tmux","zellij","herdr"],"type":"string"},"title":{"fallback":"Terminal host","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":"ask_every_time","description":{"fallback":"Choose how Happier responds when Claude asks how to resume a large session.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.subtitle"},"id":"claudeUnifiedTerminalResumeChoice","presentation":{"control":"select","options":[{"description":{"fallback":"Show a user action in the session whenever Claude asks.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.ask_every_time.subtitle"},"title":{"fallback":"Ask every time","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.ask_every_time.title"},"value":"ask_every_time"},{"description":{"fallback":"Use Claude's summary so large sessions resume faster.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_from_summary.subtitle"},"title":{"fallback":"Resume from summary","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_from_summary.title"},"value":"resume_from_summary"},{"description":{"fallback":"Load the full session context when Claude offers the choice.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_full_session.subtitle"},"title":{"fallback":"Resume full session","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_full_session.title"},"value":"resume_full_session"}]},"schema":{"description":"Default action for Claude heavy-session resume choice prompts","enum":["ask_every_time","resume_from_summary","resume_full_session"],"type":"string"},"title":{"fallback":"Large-session resume","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":"app_and_terminal","description":{"fallback":"Choose where to answer questions during unified terminal sessions.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.subtitle"},"id":"claudeUnifiedTerminalQuestionResponseLocation","presentation":{"control":"select","options":[{"description":{"fallback":"Respond in the Happier app or Claude Code terminal.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.options.app_and_terminal.subtitle"},"title":{"fallback":"App and terminal","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.options.app_and_terminal.title"},"value":"app_and_terminal"},{"description":{"fallback":"Use the existing app request flow. Claude may still accept responses in its terminal.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.options.app_only.subtitle"},"title":{"fallback":"App prompts","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.options.app_only.title"},"value":"app_only"},{"description":{"fallback":"Respond in the Claude Code terminal.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.options.terminal_only.subtitle"},"title":{"fallback":"Terminal only","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.options.terminal_only.title"},"value":"terminal_only"}]},"schema":{"enum":["app_and_terminal","app_only","terminal_only"],"type":"string"},"title":{"fallback":"Answer questions","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":"app_and_terminal","description":{"fallback":"Choose where to approve permission requests during unified terminal sessions.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.subtitle"},"id":"claudeUnifiedTerminalPermissionResponseLocation","presentation":{"control":"select","options":[{"description":{"fallback":"Respond in the Happier app or Claude Code terminal.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.options.app_and_terminal.subtitle"},"title":{"fallback":"App and terminal","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.options.app_and_terminal.title"},"value":"app_and_terminal"},{"description":{"fallback":"Use the existing app request flow. Claude may still accept responses in its terminal.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.options.app_only.subtitle"},"title":{"fallback":"App prompts","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.options.app_only.title"},"value":"app_only"},{"description":{"fallback":"Respond in the Claude Code terminal.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.options.terminal_only.subtitle"},"title":{"fallback":"Terminal only","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.options.terminal_only.title"},"value":"terminal_only"}]},"schema":{"enum":["app_and_terminal","app_only","terminal_only"],"type":"string"},"title":{"fallback":"Approve permission requests","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":"ask_every_time","description":{"fallback":"Choose how Happier responds when Claude asks whether to trust a workspace.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.subtitle"},"id":"claudeUnifiedTerminalWorkspaceTrust","presentation":{"control":"select","options":[{"description":{"fallback":"Show the exact workspace trust question in the session.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.ask_every_time.subtitle"},"title":{"fallback":"Ask every time","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.ask_every_time.title"},"value":"ask_every_time"},{"description":{"fallback":"Trust the current recaptured Claude prompt for workspaces opened by Happier.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_trust_happier_workspaces.subtitle"},"title":{"fallback":"Always trust Happier workspaces","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_trust_happier_workspaces.title"},"value":"always_trust_happier_workspaces"},{"description":{"fallback":"Reject the current recaptured Claude prompt for workspaces opened by Happier.","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_reject_happier_workspaces.subtitle"},"title":{"fallback":"Always reject Happier workspaces","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_reject_happier_workspaces.title"},"value":"always_reject_happier_workspaces"}]},"schema":{"description":"Default action for Claude workspace trust prompts opened by Happier","enum":["ask_every_time","always_trust_happier_workspaces","always_reject_happier_workspaces"],"type":"string"},"title":{"fallback":"Workspace trust","key":"settingsAgents.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.title"}},{"default":"user_project","description":{"fallback":"Legacy Claude settings source mode.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.subtitle"},"id":"claudeRemoteSettingSources","presentation":{"control":"select","options":[{"description":{"fallback":"Load project settings only.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.project.subtitle"},"title":{"fallback":"Project","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.project.title"},"value":"project"},{"description":{"fallback":"Load user and project settings.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.user_project.subtitle"},"title":{"fallback":"User and project","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.user_project.title"},"value":"user_project"},{"description":{"fallback":"Do not load Claude settings.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.none.subtitle"},"title":{"fallback":"None","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.none.title"},"value":"none"}]},"schema":{"description":"Legacy Claude settings source mode","enum":["project","user_project","none"],"type":"string"},"title":{"fallback":"Legacy setting sources","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.title"}},{"analytics":{"identityScope":"person","privacy":"safe","serializeCurrentRule":"orderedEnumArrayJoin","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":["user","project","local"],"description":{"fallback":"Controls which Claude settings are loaded.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.subtitle"},"id":"claudeRemoteSettingSourcesV2","presentation":{"control":"multiSelect","options":[{"description":{"fallback":"Loads user-global Claude config.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.subtitle"},"title":{"fallback":"User","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.title"},"value":"user"},{"description":{"fallback":"Loads repo settings (including CLAUDE.md).","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.subtitle"},"title":{"fallback":"Project","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.title"},"value":"project"},{"description":{"fallback":"Loads local-only overrides.","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.subtitle"},"title":{"fallback":"Local","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title"},"value":"local"}]},"schema":{"description":"Claude settings sources","items":{"enum":["user","project","local"],"type":"string"},"maxItems":3,"type":"array"},"title":{"fallback":"Setting sources","key":"settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":true,"description":{"fallback":"Forward permission prompts from classic local Claude sessions to Happier.","key":"settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.subtitle"},"id":"claudeLocalPermissionBridgeEnabled","presentation":{"control":"switch"},"schema":{"description":"Enable local Claude permission bridge","type":"boolean"},"title":{"fallback":"Experimental: local permission bridge","key":"settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":true,"description":{"fallback":"When enabled, Happier keeps Claude local permission requests pending until you approve or deny them from the app UI.","key":"settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.subtitle"},"id":"claudeLocalPermissionBridgeWaitIndefinitely","presentation":{"control":"switch"},"schema":{"description":"Keep local permission requests open until the user responds","type":"boolean"},"title":{"fallback":"Keep requests open until answered","key":"settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.title"}},{"default":600,"description":{"fallback":"Only used when indefinite waiting is turned off. After this delay, Happier falls back to Claude's terminal prompt.","key":"settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.subtitle"},"id":"claudeLocalPermissionBridgeTimeoutSeconds","presentation":{"control":"number","placeholder":{"fallback":"Default","key":"common.default"},"step":30},"schema":{"description":"Local permission bridge timeout in seconds","minimum":1,"type":"integer"},"title":{"fallback":"Optional permission timeout (seconds)","key":"settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Enables file checkpoints and /rewind (files-only; does not rewind the conversation). Use /checkpoints to list and /rewind --confirm to apply (higher overhead).","key":"settingsAgents.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.subtitle"},"id":"claudeRemoteEnableFileCheckpointing","presentation":{"control":"switch"},"schema":{"description":"Enable Claude file checkpointing","type":"boolean"},"title":{"fallback":"File checkpointing + /rewind","key":"settingsAgents.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.title"}},{"default":null,"description":{"fallback":"Limit Claude's internal thinking budget (null = default).","key":"settingsAgents.plugins.claude.fields.claudeRemoteMaxThinkingTokens.subtitle"},"id":"claudeRemoteMaxThinkingTokens","presentation":{"control":"number","placeholder":{"fallback":"Default","key":"common.default"},"step":100},"schema":{"anyOf":[{"minimum":1,"type":"integer"},{"type":"null"}],"description":"Maximum Claude thinking tokens override"},"title":{"fallback":"Max thinking tokens","key":"settingsAgents.plugins.claude.fields.claudeRemoteMaxThinkingTokens.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Prevent Claude from creating TODO items in remote mode.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDisableTodos.subtitle"},"id":"claudeRemoteDisableTodos","presentation":{"control":"switch"},"schema":{"description":"Disable TODO generation in Claude remote mode","type":"boolean"},"title":{"fallback":"Disable TODOs","key":"settingsAgents.plugins.claude.fields.claudeRemoteDisableTodos.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Fail if any MCP server config is invalid.","key":"settingsAgents.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.subtitle"},"id":"claudeRemoteStrictMcpServerConfig","presentation":{"control":"switch"},"schema":{"description":"Fail if Claude MCP server config is invalid","type":"boolean"},"title":{"fallback":"Strict MCP server config","key":"settingsAgents.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Enables Claude Code debug logs (same as passing --debug).","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugEnabled.subtitle"},"id":"claudeRemoteDebugEnabled","presentation":{"control":"switch"},"schema":{"description":"Enable Claude Code debug mode (remote)","type":"boolean"},"title":{"fallback":"Debug mode","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"boolean"},"default":false,"description":{"fallback":"Enables verbose logging (same as passing --verbose).","key":"settingsAgents.plugins.claude.fields.claudeRemoteVerboseEnabled.subtitle"},"id":"claudeRemoteVerboseEnabled","presentation":{"control":"switch"},"schema":{"description":"Enable Claude Code verbose logging (remote)","type":"boolean"},"title":{"fallback":"Verbose","key":"settingsAgents.plugins.claude.fields.claudeRemoteVerboseEnabled.title"}},{"analytics":{"identityScope":"person","privacy":"safe","serializeCurrentRule":"orderedEnumArrayJoin","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":[],"description":{"fallback":"Optional debug category filter. When empty, Claude logs all debug categories.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.subtitle"},"id":"claudeRemoteDebugCategories","presentation":{"control":"multiSelect","options":[{"description":{"fallback":"HTTP/API requests and responses.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.api.subtitle"},"title":{"fallback":"API","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.api.title"},"value":"api"},{"description":{"fallback":"MCP server connections and tool traffic.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.subtitle"},"title":{"fallback":"MCP","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.title"},"value":"mcp"},{"description":{"fallback":"Hook lifecycle and hook command execution.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.subtitle"},"title":{"fallback":"Hooks","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title"},"value":"hooks"},{"description":{"fallback":"Filesystem operations and file helpers.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.file.subtitle"},"title":{"fallback":"Files","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.file.title"},"value":"file"},{"description":{"fallback":"First-party internal debug category.","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.subtitle"},"title":{"fallback":"1p","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title"},"value":"1p"}]},"schema":{"description":"Claude Code debug categories filter (remote)","items":{"enum":["api","mcp","hooks","file","1p"],"type":"string"},"maxItems":5,"type":"array"},"title":{"fallback":"Debug categories","key":"settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.title"}},{"analytics":{"identityScope":"person","privacy":"presence_only","serializeCurrentRule":"jsonObjectStringPresence","trackChanges":true,"trackCurrentState":true,"valueKind":"presence"},"default":"","description":{"fallback":"Power-user Claude Agent SDK overrides. The value must be empty or a JSON object.","key":"settingsAgents.plugins.claude.fields.claudeRemoteAdvancedOptionsJson.subtitle"},"id":"claudeRemoteAdvancedOptionsJson","presentation":{"control":"textarea"},"schema":{"description":"Advanced Claude remote options JSON","maxLength":16384,"type":"string"},"title":{"fallback":"Advanced options (JSON)","key":"settingsAgents.plugins.claude.fields.claudeRemoteAdvancedOptionsJson.title"}}],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"orange"},"ionName":"sparkle"},"sections":[{"description":{"fallback":"These settings apply to both terminal and Agent SDK sessions started by Happier.","key":"settingsAgents.plugins.claude.sections.claudeCodeExperiments.footer"},"fields":["claudeCodeIncludeInNativeHistory","claudeCodeExperimentalAgentTeamsEnabled"],"id":"claude-code-experiments","title":{"fallback":"Claude Code experiments","key":"settingsAgents.plugins.claude.sections.claudeCodeExperiments.title"}},{"description":{"fallback":"Remote mode runs Claude on your machine, but controlled from the Happier UI. Local mode is the Claude Code TUI in your terminal. These settings affect remote mode only.","key":"settingsAgents.plugins.claude.sections.claudeRemoteSdk.footer"},"fields":["claudeDynamicModelProbeEnabled","claudeRemoteAgentSdkEnabled","claudeRemoteDebugEnabled","claudeRemoteVerboseEnabled","claudeRemoteDebugCategories","claudeRemoteAdvancedOptionsJson","claudeRemoteSettingSourcesV2","claudeLocalPermissionBridgeEnabled","claudeLocalPermissionBridgeWaitIndefinitely","claudeLocalPermissionBridgeTimeoutSeconds","claudeRemoteEnableFileCheckpointing","claudeRemoteMaxThinkingTokens","claudeRemoteDisableTodos","claudeRemoteStrictMcpServerConfig"],"id":"claude-remote-sdk","title":{"fallback":"Claude Agent SDK (remote mode)","key":"settingsAgents.plugins.claude.sections.claudeRemoteSdk.title"}},{"description":{"fallback":"Runs Claude Code in a terminal-hosted session and lets Happier deliver supported prompts through the terminal host.","key":"settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.footer"},"fields":["claudeUnifiedTerminalEnabled","claudeUnifiedTerminalHost","claudeUnifiedTerminalResumeChoice","claudeUnifiedTerminalQuestionResponseLocation","claudeUnifiedTerminalPermissionResponseLocation","claudeUnifiedTerminalWorkspaceTrust"],"id":"claude-unified-terminal","title":{"fallback":"Claude unified terminal","key":"settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.title"}}],"subagentSections":[{"description":{"fallback":"Agent-specific subagent behavior stays owned by the agent settings screen.","key":"subAgentGuidance.settings.agents.claude.footer"},"id":"claude-teams","items":[{"description":{"fallback":"Manage Agent Teams and other Claude-specific subagent behavior.","key":"subAgentGuidance.settings.agents.claude.openSubtitle"},"iconIonName":"sparkle","id":"claude-teams-agent-settings","title":{"fallback":"Claude subagent options","key":"subAgentGuidance.settings.agents.claude.openTitle"}}],"title":{"fallback":"Claude team agents","key":"subAgentGuidance.settings.agents.claude.title"}}]},"scope":"account","target":{"agent":"claude","kind":"agent"},"title":{"fallback":"Claude (remote)","key":"settingsAgents.plugins.claude.title"},"version":1}],"providerRequirements":{"acceptsProtocols":["anthropic"],"applyPolicy":"live","authIsolation":{"optionalOwnedEnvKeys":["ANTHROPIC_DEFAULT_HAIKU_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL"],"ownedEnvKeys":["ANTHROPIC_BASE_URL","ANTHROPIC_CUSTOM_HEADERS","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_OAUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_OAUTH_REFRESH_TOKEN","CLAUDE_CODE_OAUTH_SCOPES","CLAUDE_CODE_SETUP_TOKEN","CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"],"suppressConnectedServiceIds":["claude-subscription","anthropic"]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["raw","bearer"],"kind":"httpHeader","names":"anyValidated"},"protocol":"anthropic"}],"requiredApiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"anthropic"},{"destination":{"formats":["raw"],"kind":"httpHeader","names":["x-api-key"]},"protocol":"anthropic"}],"supportsAdditionalCredentials":true,"supportsNoAuth":true},"materialization":"spawnEnv","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true,"supportsReasoningEffort":true}},
    'codebuddy': {"identity":{"pluginId":"happier.agent.codebuddy","localId":"codebuddy"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["CODEBUDDY_API_KEY"],"loginLaunches":[{"args":[],"initialInput":"/login\r","kind":"primary"}],"missingCredentialState":"unknown","support":"login_terminal"},"displayName":"CodeBuddy Code CLI","executable":{"binaryName":"codebuddy","sourcePreference":"system-first","systemCommandResolutionStrategy":"path-first"},"install":{"docsUrl":"https://www.codebuddy.ai/docs/cli/acp","guideUrl":"https://www.codebuddy.ai/docs/cli/quickstart","managed":{"binaryName":"codebuddy","kind":"managed_package","packageName":"@tencent-ai/codebuddy-code"},"manual":{"kind":"command"}}},"acpRegistryIds":["codebuddy-code"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[{"actions":[],"fields":[],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"green"},"ionName":"code-slash-outline"},"sections":[],"subagentSections":[]},"scope":"account","target":{"agent":"codebuddy","kind":"agent"},"title":{"fallback":"CodeBuddy","key":"settingsAgents.plugins.codebuddy.title"},"version":1}],"providerRequirements":null},
    'codex': {"identity":{"pluginId":"happier.agent.codex","localId":"codex"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["OPENAI_API_KEY","CODEX_API_KEY"],"loginLaunches":[{"args":["login"],"kind":"primary"}],"nonInteractiveStatusProbe":true,"support":"login_terminal"},"commandPolicy":{"daemonAutostartDefault":"preferLocalTui"},"displayName":"OpenAI Codex CLI","executable":{"binaryName":"codex","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://github.com/openai/codex","guideUrl":null,"managed":{"archiveEntriesByPlatform":{"darwin":[{"archivePath":"bin/codex","destinationPath":"bin/codex"},{"archivePath":"bin/codex-code-mode-host","destinationPath":"bin/codex-code-mode-host"}],"linux":[{"archivePath":"bin/codex","destinationPath":"bin/codex"},{"archivePath":"bin/codex-code-mode-host","destinationPath":"bin/codex-code-mode-host"},{"archivePath":"codex-resources/bwrap","destinationPath":"codex-resources/bwrap"}],"win32":[{"archivePath":"bin/codex.exe","destinationPath":"bin/codex.exe"},{"archivePath":"bin/codex-code-mode-host.exe","destinationPath":"bin/codex-code-mode-host.exe"},{"archivePath":"codex-resources/codex-command-runner.exe","destinationPath":"codex-resources/codex-command-runner.exe"},{"archivePath":"codex-resources/codex-windows-sandbox-setup.exe","destinationPath":"codex-resources/codex-windows-sandbox-setup.exe"}]},"archiveExtractionLimits":{"maxExpandedBytes":536870912,"maxFileBytes":402653184},"assetNameByPlatform":{"darwin":{"arm64":"codex-package-aarch64-apple-darwin.tar.gz","x64":"codex-package-x86_64-apple-darwin.tar.gz"},"linux":{"arm64":"codex-package-aarch64-unknown-linux-musl.tar.gz","x64":"codex-package-x86_64-unknown-linux-musl.tar.gz"},"win32":{"arm64":"codex-package-aarch64-pc-windows-msvc.tar.gz","x64":"codex-package-x86_64-pc-windows-msvc.tar.gz"}},"binaryName":"codex","githubRepo":"openai/codex","kind":"github_release_binary","releaseTag":"rust-v0.162.1"},"manual":{"kind":"command"},"nativeUpdate":{"args":["update"],"installPaths":[".codex/packages/standalone"]},"npmPackageName":"@openai/codex","recommendationOrder":20}},"acpRegistryIds":["codex-acp"],"connectedAccounts":[{"credentialKinds":["oauth"],"materializationKinds":["files"],"purpose":"primary","required":false,"service":"openai-codex"}],"providerStateSharing":{"config":{"modes":["linked","copied","isolated"],"supported":true},"state":{"modes":["isolated","shared"],"sharedStatePrivacyRiskAcknowledgementRequired":true,"supported":true}},"accountSettings":[{"actions":[],"fields":[{"analytics":{"identityScope":"person","privacy":"safe","trackChanges":true,"trackCurrentState":true,"valueKind":"enum"},"default":"appServer","description":{"fallback":"Select App Server, ACP, or MCP.","key":"settingsAgents.plugins.codex.fields.codexBackendMode.subtitle"},"id":"codexBackendMode","presentation":{"control":"select","options":[{"description":{"fallback":"Recommended official Codex app-server mode","key":"settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.subtitle"},"title":{"fallback":"App Server","key":"settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.title"},"value":"appServer"},{"description":{"fallback":"Route Codex through ACP (codex-acp)","key":"settingsAgents.plugins.codex.fields.codexBackendMode.options.acp.subtitle"},"title":{"fallback":"ACP","key":"settingsAgents.plugins.codex.fields.codexBackendMode.options.acp.title"},"value":"acp"}]},"schema":{"description":"Preferred Codex backend mode","enum":["acp","appServer","mcp","mcp_resume"],"type":"string"},"title":{"fallback":"Codex routing mode","key":"settingsAgents.plugins.codex.fields.codexBackendMode.title"}}],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"blue"},"ionName":"terminal"},"sections":[{"description":{"fallback":"Choose how Codex is routed. App Server is the recommended default. Local/remote switching and resume work with App Server; ACP remains available as a legacy fallback.","key":"settingsAgents.plugins.codex.sections.backendMode.footer"},"fields":["codexBackendMode"],"id":"codex-mode","title":{"fallback":"Routing mode","key":"settingsAgents.plugins.codex.sections.backendMode.title"}}],"subagentSections":[]},"scope":"account","target":{"agent":"codex","kind":"agent"},"title":{"fallback":"Codex","key":"settingsAgents.plugins.codex.title"},"version":1}],"providerRequirements":{"acceptsProtocols":["openai-responses"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["HAPPIER_CODEX_PROVIDER_API_KEY","OPENAI_API_KEY","CODEX_API_KEY"],"suppressConnectedServiceIds":["openai-codex","openai"]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["raw","bearer"],"kind":"httpHeader","names":"anyValidated"},"protocol":"openai-responses"}],"supportsNoAuth":true},"materialization":"engineConfig","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true,"supportsReasoningEffort":true}},
    'copilot': {"identity":{"pluginId":"happier.agent.copilot","localId":"copilot"},"acpStderrRules":null,"cli":{"auth":{"credentialPaths":["~/.copilot/config.json"],"environmentVariables":["COPILOT_GITHUB_TOKEN","GH_TOKEN","GITHUB_TOKEN"],"loginLaunches":[{"args":["login"],"kind":"primary"}],"missingCredentialState":"unknown","support":"login_terminal"},"displayName":"GitHub Copilot CLI","executable":{"binaryName":"copilot","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli","guideUrl":null,"managed":{"binaryName":"copilot","kind":"managed_package","packageName":"@github/copilot"},"manual":{"kind":"command"}}},"acpRegistryIds":["github-copilot-cli"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[{"actions":[],"fields":[],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"blue"},"ionName":"github-logo"},"sections":[],"subagentSections":[]},"scope":"account","target":{"agent":"copilot","kind":"agent"},"title":{"fallback":"Copilot","key":"settingsAgents.plugins.copilot.title"},"version":1}],"providerRequirements":{"acceptsProtocols":["openai-chat","anthropic"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["COPILOT_PROVIDER_BASE_URL","COPILOT_PROVIDER_TYPE","COPILOT_MODEL","COPILOT_PROVIDER_API_KEY","COPILOT_PROVIDER_BEARER_TOKEN","COPILOT_PROVIDER_WIRE_API","COPILOT_PROVIDER_WIRE_MODEL","COPILOT_PROVIDER_MODEL_ID","COPILOT_PROVIDER_AZURE_API_VERSION","COPILOT_PROVIDER_MAX_PROMPT_TOKENS","COPILOT_PROVIDER_MAX_OUTPUT_TOKENS"],"suppressConnectedServiceIds":[]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-chat"},{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"anthropic"},{"destination":{"formats":["raw"],"kind":"httpHeader","names":["x-api-key"]},"protocol":"anthropic"}],"supportsNoAuth":true},"materialization":"spawnEnv","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
    'cursor': {"identity":{"pluginId":"happier.agent.cursor","localId":"cursor"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["CURSOR_API_KEY"],"loginLaunches":[],"nonInteractiveStatusProbe":true,"support":"status_only"},"displayName":"Cursor Agent CLI","executable":{"alternativeBinaryFallbackEnabledEnvVar":"HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED","alternativeBinaryNames":["agent"],"binaryName":"cursor-agent","knownUserBinDirSuffixes":[".local/bin"],"sourcePreference":"system-first"},"install":{"docsUrl":"https://cursor.com/docs/cli","guideUrl":"https://cursor.com/docs/cli/installation","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://cursor.com/install | bash"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://cursor.com/install | bash"],"cmd":"bash"}],"win32":[{"args":["-NoProfile","-ExecutionPolicy","Bypass","-Command","irm 'https://cursor.com/install?win32=true' | iex"],"cmd":"powershell.exe"}]}},"nativeUpdate":{"args":["update"],"installPaths":[".local/share/cursor-agent"]}}},"acpRegistryIds":["cursor"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":null},
    'custom-acp': {"identity":{"pluginId":"happier.agent.custom-acp","localId":"custom-acp"},"acpStderrRules":null,"cli":null,"acpRegistryIds":[],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":null},
    'devin': {"identity":{"pluginId":"happier.agent.devin","localId":"devin"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":["auth","login"],"kind":"primary"}],"nonInteractiveStatusProbe":true,"support":"login_terminal"},"displayName":"Devin CLI","executable":{"binaryName":"devin","knownUserBinDirSuffixes":[".local/bin"],"sourcePreference":"system-first","systemCommandResolutionStrategy":"path-first"},"install":{"docsUrl":"https://docs.devin.ai/work-with-devin/devin-cli","guideUrl":"https://docs.devin.ai/work-with-devin/devin-cli","managed":null,"manual":{"kind":"command"}}},"acpRegistryIds":["devin"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[{"actions":[],"fields":[],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"blue"},"ionName":"cpu"},"sections":[],"subagentSections":[]},"scope":"account","target":{"agent":"devin","kind":"agent"},"title":{"fallback":"Devin","key":"settingsAgents.plugins.devin.title"},"version":1}],"providerRequirements":null},
    'droid': {"identity":{"pluginId":"happier.agent.droid","localId":"droid"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["FACTORY_API_KEY"],"loginLaunches":[{"args":[],"initialInput":"/login","kind":"primary"}],"missingCredentialState":"unknown","support":"login_terminal"},"displayName":"Factory Droid CLI","executable":{"binaryName":"droid","knownUserBinDirSuffixes":[".local/bin"],"sourcePreference":"system-first","systemCommandResolutionStrategy":"path-first"},"install":{"docsUrl":"https://docs.factory.ai/droid-cli/cli-reference","guideUrl":"https://docs.factory.ai/droid-cli/overview","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://app.factory.ai/cli | sh"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://app.factory.ai/cli | sh"],"cmd":"bash"}],"win32":[{"args":["-NoProfile","-ExecutionPolicy","Bypass","-Command","Invoke-RestMethod https://app.factory.ai/cli/windows | Invoke-Expression"],"cmd":"powershell.exe"}]}}}},"acpRegistryIds":["factory-droid"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":{"acceptsProtocols":["openai-chat","openai-responses","anthropic"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["HAPPIER_DROID_PROVIDER_API_KEY","FACTORY_API_KEY"],"suppressConnectedServiceIds":[]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-chat"},{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-responses"},{"destination":{"formats":["raw"],"kind":"httpHeader","names":["x-api-key"]},"protocol":"anthropic"},{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"anthropic"}],"supportsNoAuth":true},"materialization":"configFile","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
    'fx': {"identity":{"pluginId":"happier.agent.fx","localId":"fx"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":["login"],"kind":"primary"}],"nonInteractiveStatusProbe":true,"support":"login_terminal"},"displayName":"FX CLI","executable":{"binaryName":"fx","knownUserBinDirSuffixes":[".local/bin"],"sourcePreference":"system-first","systemCommandResolutionStrategy":"path-first"},"install":{"docsUrl":"https://github.com/vercel-labs/fx","guideUrl":"https://github.com/vercel-labs/fx","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://fx.sh/setup.sh | bash"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://fx.sh/setup.sh | bash"],"cmd":"bash"}]}}}},"acpRegistryIds":[],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":{"acceptsProtocols":["openai-chat"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["AI_GATEWAY_API_KEY","VERCEL_OIDC_TOKEN","FX_PROVIDER","FX_MODEL","FX_AUTH_MODE","FX_GATEWAY_BASE_URL","FX_E2E_GATEWAY_CHAT_URL","FX_E2E_GATEWAY_MODELS_URL","FX_E2E_GATEWAY_CREDITS_URL"],"suppressConnectedServiceIds":[]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-chat"}],"supportsNoAuth":false},"materialization":"spawnEnv","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
    'gemini': {"identity":{"pluginId":"happier.agent.gemini","localId":"gemini"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_GENAI_USE_VERTEXAI","GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_LOCATION"],"loginLaunches":[],"support":"unsupported"},"displayName":"Google Gemini CLI","executable":{"binaryName":"gemini","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://goo.gle/gemini-cli-auth-docs","guideUrl":null,"managed":{"binaryName":"gemini","kind":"managed_package","packageName":"@google/gemini-cli"},"manual":{"kind":"command"},"recommendationOrder":30}},"acpRegistryIds":["gemini"],"connectedAccounts":[{"credentialKinds":["token"],"materializationKinds":["files","environment"],"purpose":"model_upstream","required":false,"service":"gemini-account"}],"providerStateSharing":{"config":{"modes":["isolated"],"supported":false,"unavailableReason":"not_implemented"},"state":{"modes":["isolated"],"supported":false,"unavailableReason":"not_implemented"}},"accountSettings":[],"providerRequirements":{"acceptsProtocols":["gemini"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["GEMINI_API_KEY","GEMINI_MODEL","GOOGLE_GEMINI_BASE_URL","GEMINI_CLI_CUSTOM_HEADERS","GEMINI_API_KEY_AUTH_MECHANISM","GOOGLE_API_KEY","GOOGLE_GENAI_USE_VERTEXAI","GOOGLE_GENAI_USE_GCA","GEMINI_CLI_AUTH_OVERRIDE","GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_PROJECT_ID","GOOGLE_CLOUD_LOCATION","GOOGLE_VERTEX_BASE_URL","GOOGLE_APPLICATION_CREDENTIALS","HAPPIER_GEMINI_ACP_AUTH_METHOD","HAPPIER_GEMINI_ACP_AUTH_META"],"suppressConnectedServiceIds":["gemini"]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["raw"],"kind":"httpHeader","names":["x-goog-api-key"]},"protocol":"gemini"}],"supportsNoAuth":false},"materialization":"spawnEnv","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
    'grok': {"identity":{"pluginId":"happier.agent.grok","localId":"grok"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["XAI_API_KEY"],"loginLaunches":[{"args":["login"],"kind":"primary"},{"args":["login","--device-auth"],"kind":"device_code"}],"missingCredentialState":"unknown","support":"login_terminal"},"executable":{"binaryName":"grok","knownUserBinDirSuffixes":[".grok/bin",".local/bin"],"sourcePreference":"system-first","systemCommandResolutionStrategy":"path-first"},"install":{"docsUrl":"https://x.ai","guideUrl":"https://x.ai/cli","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://x.ai/cli/install.sh | bash"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://x.ai/cli/install.sh | bash"],"cmd":"bash"}],"win32":[{"args":["-NoProfile","-ExecutionPolicy","Bypass","-Command","irm https://x.ai/cli/install.ps1 | iex"],"cmd":"powershell.exe"}]}}}},"acpRegistryIds":["grok-build"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":null},
    'kilo': {"identity":{"pluginId":"happier.agent.kilo","localId":"kilo"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":[],"initialInput":"/connect\r","kind":"primary"}],"support":"login_terminal"},"displayName":"Kilo CLI","executable":{"binaryName":"kilo","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://kilo.ai/docs/cli","guideUrl":null,"managed":{"binaryName":"kilo","kind":"managed_package","packageName":"@kilocode/cli"},"manual":{"kind":"command"}}},"acpRegistryIds":["kilo"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[{"actions":[],"fields":[],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"orange"},"ionName":"lightning"},"sections":[],"subagentSections":[]},"scope":"account","target":{"agent":"kilo","kind":"agent"},"title":{"fallback":"Kilo","key":"settingsAgents.plugins.kilo.title"},"version":1}],"providerRequirements":{"acceptsProtocols":["openai-chat","openai-responses","anthropic"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["HAPPIER_KILO_PROVIDER_API_KEY","KILO_CONFIG_CONTENT","KILO_AUTH_CONTENT","OPENAI_API_KEY","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN"],"suppressConnectedServiceIds":[]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-chat"},{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-responses"},{"destination":{"formats":["raw"],"kind":"httpHeader","names":["x-api-key"]},"protocol":"anthropic"}],"noAuthProtocols":["openai-chat"],"supportsNoAuth":true},"materialization":"spawnEnv","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
    'kimi': {"identity":{"pluginId":"happier.agent.kimi","localId":"kimi"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":["login"],"kind":"primary"}],"support":"login_terminal"},"displayName":"Kimi Code CLI","executable":{"binaryName":"kimi","knownUserBinDirSuffixes":[".local/bin"],"sourcePreference":"system-first","systemCommandResolutionStrategy":"path-first"},"install":{"docsUrl":"https://moonshotai.github.io/kimi-code/","guideUrl":"https://moonshotai.github.io/kimi-code/docs/en/reference/kimi-command.html","managed":null,"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["-lc","curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],"cmd":"bash"}],"linux":[{"args":["-lc","curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],"cmd":"bash"}],"win32":[{"args":["-NoProfile","-ExecutionPolicy","Bypass","-Command","Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression"],"cmd":"powershell.exe"}]}}}},"acpRegistryIds":["kimi"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":null},
    'kiro': {"identity":{"pluginId":"happier.agent.kiro","localId":"kiro"},"acpStderrRules":{"suppress":[{"includes":["error handling notification","_kiro.dev/","method not found"]}]},"cli":{"auth":{"loginLaunches":[{"args":["login"],"kind":"primary"}],"nonInteractiveStatusProbe":true,"support":"login_terminal"},"displayName":"Kiro CLI","executable":{"binaryName":"kiro-cli","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":"https://kiro.dev/docs/cli/acp/","managed":null,"manual":{"kind":"command"}}},"acpRegistryIds":[],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[{"actions":[],"fields":[],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"orange"},"ionName":"lightning"},"sections":[],"subagentSections":[]},"scope":"account","target":{"agent":"kiro","kind":"agent"},"title":{"fallback":"Kiro","key":"settingsAgents.plugins.kiro.title"},"version":1}],"providerRequirements":null},
    'ohmypi': {"identity":{"pluginId":"happier.agent.ohmypi","localId":"ohmypi"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["OPENAI_CODEX_OAUTH_TOKEN","OPENAI_API_KEY","ANTHROPIC_OAUTH_TOKEN","ANTHROPIC_API_KEY","GEMINI_API_KEY"],"loginLaunches":[],"machineLoginKey":"oh-my-pi","support":"manual_only"},"displayName":"oh-my-pi CLI","executable":{"acceptsJavaScriptFileOverride":true,"binaryName":"omp","knownUserBinDirSuffixes":[".bun/bin"],"sourcePreference":"system-first"},"install":{"docsUrl":"https://github.com/can1357/oh-my-pi","guideUrl":"https://github.com/can1357/oh-my-pi#via-bun-recommended","managed":{"binaryName":"omp","githubRepo":"can1357/oh-my-pi","kind":"github_release_binary"},"manual":{"kind":"vendor_recipe","recipes":{"darwin":[{"args":["install","-g","@oh-my-pi/pi-coding-agent"],"cmd":"bun"}],"linux":[{"args":["install","-g","@oh-my-pi/pi-coding-agent"],"cmd":"bun"}],"win32":[{"args":["install","-g","@oh-my-pi/pi-coding-agent"],"cmd":"bun"}]}}}},"acpRegistryIds":[],"connectedAccounts":[{"credentialKinds":["oauth"],"materializationKinds":["environment"],"purpose":"openai-codex","required":false,"service":{"localId":"openai-codex","pluginId":"happier.agent.codex"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"openai","required":false,"service":{"localId":"openai","pluginId":"happier.voice.openai"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"claude-subscription","required":false,"service":{"localId":"claude-subscription","pluginId":"happier.agent.claude"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"anthropic","required":false,"service":{"localId":"anthropic","pluginId":"happier.agent.claude"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"gemini","required":false,"service":{"localId":"gemini-account","pluginId":"happier.agent.gemini"}}],"providerStateSharing":{"config":{"modes":["isolated"],"supported":false,"unavailableReason":"not_implemented"},"state":{"modes":["isolated","shared"],"sharedStatePrivacyRiskAcknowledgementRequired":true,"supported":true}},"accountSettings":[{"actions":[],"fields":[{"default":"","description":{"fallback":"Optional Oh My Pi data root. Leave empty to use ~/.omp/agent.","key":"settingsAgents.plugins.ohmypi.fields.ohMyPiAgentDir.subtitle"},"id":"ohMyPiAgentDir","presentation":{"control":"text"},"schema":{"maxLength":10000,"type":"string"},"title":{"fallback":"Agent directory","key":"settingsAgents.plugins.ohmypi.fields.ohMyPiAgentDir.title"}}],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"orange"},"ionName":"code"},"sections":[{"description":{"fallback":"This directory is used only for Oh My Pi sessions started or discovered by Happier.","key":"settingsAgents.plugins.ohmypi.sections.storage.footer"},"fields":["ohMyPiAgentDir"],"id":"ohmypi-storage","title":{"fallback":"Storage","key":"settingsAgents.plugins.ohmypi.sections.storage.title"}}],"subagentSections":[]},"scope":"account","target":{"agent":"ohmypi","kind":"agent"},"title":{"fallback":"Oh My Pi","key":"settingsAgents.plugins.ohmypi.title"},"version":1}],"providerRequirements":null},
    'opencode': {"identity":{"pluginId":"happier.agent.opencode","localId":"opencode"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":["auth","login"],"kind":"primary"}],"nonInteractiveStatusProbe":true,"support":"login_terminal"},"displayName":"OpenCode CLI","executable":{"binaryName":"opencode","knownUserBinDirSuffixes":[".opencode/bin",".local/bin","AppData/Roaming/npm"],"sourcePreference":"system-first"},"install":{"docsUrl":"https://opencode.ai","guideUrl":"https://dev.opencode.ai/v2/docs/","managed":{"allowBuild":true,"binaryName":"opencode","kind":"managed_package","packageName":"@opencode/cli"},"manual":{"kind":"command"},"nativeUpdate":{"args":["upgrade"],"installPaths":[".opencode/bin"]},"npmPackageName":"opencode-ai","recommendationOrder":40}},"acpRegistryIds":["opencode"],"connectedAccounts":[{"credentialKinds":["oauth","token"],"materializationKinds":["environment","httpHeaders"],"purpose":"anthropic-model-request","service":{"localId":"claude-subscription","pluginId":"happier.agent.claude"}},{"credentialKinds":["oauth"],"materializationKinds":["httpHeaders"],"purpose":"openai-codex-model-request","service":{"localId":"openai-codex","pluginId":"happier.agent.codex"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"openai-api-key","service":{"localId":"openai","pluginId":"happier.voice.openai"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"anthropic-api-key","service":{"localId":"anthropic","pluginId":"happier.agent.claude"}}],"providerStateSharing":{"config":{"modes":["isolated"],"supported":false,"unavailableReason":"not_implemented"},"state":{"modes":["isolated"],"supported":false,"unavailableReason":"not_implemented"}},"accountSettings":[{"actions":[],"fields":[{"default":"auto","description":{"fallback":"Choose which installed OpenCode command Happier launches.","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.subtitle"},"id":"opencodeCliGeneration","presentation":{"control":"select","options":[{"description":{"fallback":"Prefer stable OpenCode, then use V2 when stable is unavailable.","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.auto.subtitle"},"title":{"fallback":"Auto (recommended)","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.auto.title"},"value":"auto"},{"description":{"fallback":"Always launch the opencode command.","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.stable.subtitle"},"title":{"fallback":"Stable","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.stable.title"},"value":"stable"},{"description":{"fallback":"Prefer the opencode2 preview command, then the released opencode command.","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.v2.subtitle"},"title":{"fallback":"V2","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.v2.title"},"value":"v2"}]},"schema":{"description":"Preferred OpenCode CLI generation","enum":["auto","stable","v2"],"type":"string"},"title":{"fallback":"OpenCode version","key":"settingsAgents.plugins.opencode.fields.opencodeCliGeneration.title"}},{"default":"server","description":{"fallback":"Choose the integration backend.","key":"settingsAgents.plugins.opencode.fields.opencodeBackendMode.subtitle"},"id":"opencodeBackendMode","presentation":{"control":"select","options":[{"description":{"fallback":"Uses OpenCode server APIs for richer features and reliability.","key":"settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.server.subtitle"},"title":{"fallback":"Server (recommended)","key":"settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.server.title"},"value":"server"},{"description":{"fallback":"Routes OpenCode through ACP; fewer features.","key":"settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.acp.subtitle"},"title":{"fallback":"ACP (legacy)","key":"settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.acp.title"},"value":"acp"}]},"schema":{"description":"Preferred OpenCode backend mode","enum":["server","acp"],"type":"string"},"title":{"fallback":"OpenCode backend mode","key":"settingsAgents.plugins.opencode.fields.opencodeBackendMode.title"}},{"default":"","description":{"fallback":"Optional override for a server you run yourself. HTTPS may use any host; HTTP is limited to localhost.","key":"settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.subtitle"},"id":"opencodeServerBaseUrl","presentation":{"binding":{"byServerIdSettingId":"opencodeServerBaseUrlByServerIdV1","fallbackSettingId":"opencodeServerBaseUrl","kind":"perActiveServer"},"control":"text"},"schema":{"description":"Optional override for a user-managed OpenCode server URL","type":"string"},"title":{"fallback":"Existing OpenCode server URL","key":"settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.title"}},{"description":{"fallback":"Set this only if your OpenCode server runs with OPENCODE_SERVER_PASSWORD. Stored encrypted on this machine and never synced.","key":"settingsAgents.plugins.opencode.fields.opencodeServerPassword.subtitle"},"id":"opencodeServerPassword","schema":{"description":"OPENCODE_SERVER_PASSWORD of a user-managed OpenCode server","type":"string"},"secret":{"custody":"daemon","managedServiceOrigin":{"endpointSettingId":"opencodeServerBaseUrl"}},"title":{"fallback":"Existing OpenCode server password","key":"settingsAgents.plugins.opencode.fields.opencodeServerPassword.title"}},{"default":{},"id":"opencodeServerBaseUrlByServerIdV1","presentation":{"hidden":true},"schema":{"additionalProperties":{"type":"string"},"description":"Per-server overrides for user-managed OpenCode server URLs","type":"object"},"title":"Per-server OpenCode server URLs"}],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"blue"},"ionName":"code"},"sections":[{"description":{"fallback":"Auto prefers stable OpenCode. V2 selects the V2 API even when the released command is named opencode. Happier MCP tools work in ACP mode; the V2 server API does not expose dynamic registration.","key":"settingsAgents.plugins.opencode.sections.cliGeneration.footer"},"fields":["opencodeCliGeneration"],"id":"opencode-cli-generation","title":{"fallback":"OpenCode version","key":"settingsAgents.plugins.opencode.sections.cliGeneration.title"}},{"description":{"fallback":"Server mode unlocks questions. Native forking is offered only when the connected server supports it; ACP mode is a legacy fallback.","key":"settingsAgents.plugins.opencode.sections.backendMode.footer"},"fields":["opencodeBackendMode"],"id":"opencode-backend-mode","title":{"fallback":"Backend mode","key":"settingsAgents.plugins.opencode.sections.backendMode.title"}},{"description":{"fallback":"Leave empty to use Happier-managed OpenCode server lifecycle. Set an absolute HTTPS URL for any server you run yourself, or HTTP only for localhost. Put the password in the field below, never in the URL.","key":"settingsAgents.plugins.opencode.sections.server.footer"},"fields":["opencodeServerBaseUrl","opencodeServerPassword"],"id":"opencode-server","title":{"fallback":"Server connection","key":"settingsAgents.plugins.opencode.sections.server.title"}}],"subagentSections":[]},"scope":"account","target":{"agent":"opencode","kind":"agent"},"title":{"fallback":"OpenCode","key":"settingsAgents.plugins.opencode.title"},"version":1}],"providerRequirements":{"acceptsProtocols":["openai-responses","openai-chat"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["HAPPIER_OPENCODE_PROVIDER_API_KEY","OPENCODE_AUTH_CONTENT","OPENCODE_CONFIG_CONTENT","OPENAI_API_KEY","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN"],"suppressConnectedServiceIds":["openai-codex","openai","claude-subscription","anthropic"]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-responses"},{"destination":{"formats":["raw","bearer"],"kind":"httpHeader","names":"anyValidated"},"protocol":"openai-chat"}],"noAuthProtocols":["openai-chat"],"supportsNoAuth":true},"materialization":"configFile","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
    'pi': {"identity":{"pluginId":"happier.agent.pi","localId":"pi"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["OPENAI_API_KEY","ANTHROPIC_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","KIMI_API_KEY"],"loginLaunches":[],"support":"status_only"},"displayName":"Pi Coding Agent CLI","executable":{"binaryName":"pi","knownEnvironmentBinDirs":[{"envVar":"PI_CODING_AGENT_DIR","relativeDir":"bin"}],"knownUserBinDirSuffixes":[".pi/agent/bin"],"sourcePreference":"system-first"},"install":{"docsUrl":null,"guideUrl":"https://github.com/badlogic/pi-mono","managed":{"binaryName":"pi","kind":"managed_package","packageName":"@earendil-works/pi-coding-agent"},"manual":{"kind":"command"}}},"acpRegistryIds":["pi-acp"],"connectedAccounts":[{"credentialKinds":["oauth","token"],"materializationKinds":["httpHeaders","environment"],"purpose":"anthropic-model-request","service":{"localId":"claude-subscription","pluginId":"happier.agent.claude"}},{"credentialKinds":["oauth"],"materializationKinds":["httpHeaders"],"purpose":"openai-codex-model-request","service":{"localId":"openai-codex","pluginId":"happier.agent.codex"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"openai-api-key","service":{"localId":"openai","pluginId":"happier.voice.openai"}},{"credentialKinds":["token"],"materializationKinds":["environment"],"purpose":"anthropic-api-key","service":{"localId":"anthropic","pluginId":"happier.agent.claude"}}],"providerStateSharing":{"config":{"modes":["isolated"],"supported":false,"unavailableReason":"not_implemented"},"state":{"modes":["isolated","shared"],"sharedStatePrivacyRiskAcknowledgementRequired":true,"supported":true}},"accountSettings":[{"actions":[],"fields":[{"default":"","description":{"fallback":"Optional Pi data root. Leave empty to use ~/.pi/agent.","key":"settingsAgents.plugins.pi.fields.piAgentDir.subtitle"},"id":"piAgentDir","presentation":{"control":"text"},"schema":{"maxLength":10000,"type":"string"},"title":{"fallback":"Agent directory","key":"settingsAgents.plugins.pi.fields.piAgentDir.title"}}],"id":"agent-settings","presentation":{"icon":{"color":{"kind":"theme","token":"green"},"ionName":"code"},"sections":[{"description":{"fallback":"This directory is used only for Pi sessions started or discovered by Happier.","key":"settingsAgents.plugins.pi.sections.storage.footer"},"fields":["piAgentDir"],"id":"pi-storage","title":{"fallback":"Storage","key":"settingsAgents.plugins.pi.sections.storage.title"}}],"subagentSections":[]},"scope":"account","target":{"agent":"pi","kind":"agent"},"title":{"fallback":"Pi","key":"settingsAgents.plugins.pi.title"},"version":1}],"providerRequirements":null},
    'qwen': {"identity":{"pluginId":"happier.agent.qwen","localId":"qwen"},"acpStderrRules":null,"cli":{"auth":{"loginLaunches":[{"args":[],"initialInput":"/auth\r","kind":"primary"}],"support":"login_terminal"},"displayName":"Qwen CLI","executable":{"binaryName":"qwen","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":null,"guideUrl":"https://qwenlm.github.io/qwen-code-docs/","managed":{"binaryName":"qwen","kind":"managed_package","packageName":"@qwen-code/qwen-code"},"manual":{"kind":"command"}}},"acpRegistryIds":["qwen-code"],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":null},
    'coderabbit': {"identity":{"pluginId":"happier.review.coderabbit","localId":"coderabbit"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["CODERABBIT_API_KEY"],"loginLaunches":[],"missingCredentialState":"unknown","support":"status_only"},"executable":{"binaryName":"coderabbit","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":null,"guideUrl":null,"managed":null,"manual":{"kind":"command"}}},"acpRegistryIds":[],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":null},
    'deepsec': {"identity":{"pluginId":"happier.review.deepsec","localId":"deepsec"},"acpStderrRules":null,"cli":{"auth":{"environmentVariables":["AI_GATEWAY_API_KEY"],"loginLaunches":[],"missingCredentialState":"unknown","support":"status_only"},"executable":{"binaryName":"deepsec","knownUserBinDirSuffixes":null,"sourcePreference":"system-first"},"install":{"docsUrl":null,"guideUrl":null,"managed":null,"manual":{"kind":"command"}}},"acpRegistryIds":[],"connectedAccounts":[],"providerStateSharing":null,"accountSettings":[],"providerRequirements":{"acceptsProtocols":["openai-responses"],"applyPolicy":"restart_session","authIsolation":{"ownedEnvKeys":["AI_GATEWAY_API_KEY","VERCEL_OIDC_TOKEN","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL","ANTHROPIC_CUSTOM_HEADERS","CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","OPENAI_BASE_URL"],"suppressConnectedServiceIds":[]},"credentialSupport":{"apiKeyTransports":[{"destination":{"formats":["bearer"],"kind":"httpHeader","names":["authorization"]},"protocol":"openai-responses"}],"supportsNoAuth":false},"materialization":"spawnEnv","required":{"streaming":true,"toolRoundTrips":true},"supportsFreeformModelIds":true}},
});

/** Provider declarations from the same admitted bundled manifests; no activation or Machine facts. */
export const BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS: Readonly<Record<string, Readonly<{ contributionKey: string; definition: ProviderContributionV1; provenance: 'first_party' }>>> = Object.freeze<Record<string, Readonly<{ contributionKey: string; definition: ProviderContributionV1; provenance: 'first_party' }>>>({
    'happier.agent.claude/anthropic': {"contributionKey":"happier.agent.claude/anthropic","definition":{"catalog":{"manualModelPolicy":"allowed","membershipPolicy":"probe-authoritative","probes":[{"endpointTemplateId":"anthropic","parser":"anthropic-models","path":"/v1/models?limit=1000"}],"source":"static+probe","staticModels":[{"contextWindowTokens":1000000,"description":"Latest Claude model for demanding reasoning and long-running agentic work.","id":"claude-fable-5-1","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Fable 5.1"},{"contextWindowTokens":1000000,"description":"Latest Opus model for long-running agentic coding and knowledge work.","id":"claude-opus-5-5","modelOptions":[{"currentValue":"medium","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Opus 5.5"},{"contextWindowTokens":1000000,"description":"Prior Opus model for complex coding and reasoning tasks.","id":"claude-opus-5","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Opus 5"},{"contextWindowTokens":1000000,"description":"Latest balanced Claude model for coding, agentic work, editing, and analysis.","id":"claude-sonnet-5","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Sonnet 5"},{"contextWindowTokens":1000000,"description":"Prior Fable model for demanding coding and reasoning tasks.","id":"claude-fable-5","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Fable 5"},{"contextWindowTokens":1000000,"description":"Limited-availability Claude model for approved Project Glasswing customers.","id":"claude-mythos-5","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Mythos 5"},{"contextWindowTokens":1000000,"description":"Earlier Opus model for complex coding and reasoning tasks.","id":"claude-opus-4-8","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Opus 4.8"},{"contextWindowTokens":1000000,"description":"Prior highest-capability Claude model for hard coding and reasoning tasks.","id":"claude-opus-4-7","modelOptions":[{"currentValue":"xhigh","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"},{"currentValue":"false","description":"Maximum coding effort. Forces XHigh Thinking effort while enabled.","id":"ultracode","name":"Ultracode","overridesWhenOn":{"forcedValue":"xhigh","optionIds":["reasoning_effort"]},"type":"boolean"}],"name":"Opus 4.7"},{"description":"Highest-capability Claude model for the hardest coding and reasoning tasks.","extendedContextModelId":"claude-opus-4-6[1m]","id":"claude-opus-4-6","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"Max","value":"max"}],"type":"select"}],"name":"Opus 4.6"},{"description":"Balanced Claude model for everyday coding, editing, and analysis.","extendedContextModelId":"claude-sonnet-4-6[1m]","id":"claude-sonnet-4-6","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"Max","value":"max"}],"type":"select"}],"name":"Sonnet 4.6"},{"costTier":"low","description":"Claude Haiku model for lighter tasks and lower-latency replies.","id":"claude-haiku-5-5","name":"Haiku 5.5"},{"aliases":["claude-haiku-4-5-20251001"],"costTier":"low","description":"Fastest Claude option for lighter tasks and lower-latency replies.","id":"claude-haiku-4-5","name":"Haiku 4.5"},{"description":"Prior Opus generation alias for compatibility with existing Claude setups.","id":"claude-opus-4-5","modelOptions":[{"currentValue":"high","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"}],"type":"select"}],"name":"Opus 4.5"},{"description":"Prior Sonnet generation alias for compatibility with existing Claude setups.","id":"claude-sonnet-4-5","name":"Sonnet 4.5"}]},"credential":{"keyUrl":"https://console.anthropic.com/settings/keys","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"raw","kind":"httpHeader","name":"x-api-key"},"id":"anthropic-x-api-key","protocols":["anthropic"],"uses":["probe","runtime"]}]},"endpointTemplates":[{"baseUrl":"https://api.anthropic.com/","capabilities":{"reasoningControls":"supported","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"anthropic","protocol":"anthropic","publicHeaders":{"anthropic-version":"2023-06-01"}}],"id":"anthropic","kind":"frontier","name":"Anthropic","v":1,"websiteUrl":"https://www.anthropic.com"},"provenance":"first_party"},
    'happier.provider.cliproxyapi/cliproxyapi': {"contributionKey":"happier.provider.cliproxyapi/cliproxyapi","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"cliproxyapi-openai-responses","parser":"openai-models","path":"/v1/models"}],"source":"probe","sourceRegistryVersion":"v7.2.95:reasoning-image-capabilities-v2"},"credential":{"kind":"apiKey","required":false,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"cliproxyapi-http-bearer","protocols":["openai-chat","openai-responses","anthropic"],"uses":["probe","runtime"]}]},"discovery":{"availabilityProbe":{"endpointTemplateId":"cliproxyapi-openai-responses","parser":"openai-models","path":"/v1/models"},"listener":{"defaultPorts":[8317],"executableBasenames":["CLIProxyAPI","CLIProxyAPI.exe","cli-proxy-api","cli-proxy-api.exe"]},"v":1},"endpointTemplates":[{"capabilities":{"reasoningControls":"supported","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"cliproxyapi-openai-responses","localUrlCandidates":["http://127.0.0.1:8317/v1","http://localhost:8317/v1"],"protocol":"openai-responses"},{"capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"cliproxyapi-openai-chat","localUrlCandidates":["http://127.0.0.1:8317/v1","http://localhost:8317/v1"],"protocol":"openai-chat"},{"capabilities":{"reasoningControls":"supported","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"cliproxyapi-anthropic","localUrlCandidates":["http://127.0.0.1:8317/","http://localhost:8317/"],"protocol":"anthropic"}],"id":"cliproxyapi","kind":"aggregator","managedRuntime":{"connectedAccountPurposeBindingPolicy":{"minimumBound":1},"connectedAccounts":[{"endpointTemplateIds":["cliproxyapi-openai-chat","cliproxyapi-openai-responses","cliproxyapi-anthropic"],"materializationKinds":["httpHeaders"],"purpose":"openai-upstream","required":false,"service":{"localId":"openai-codex","pluginId":"happier.agent.codex"},"staticModels":[{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"codex-auto-review","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"}],"type":"select"}],"name":"codex-auto-review"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.3-codex-spark","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"}],"type":"select"}],"name":"gpt-5.3-codex-spark"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.4","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"}],"type":"select"}],"name":"gpt-5.4"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.4-mini","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"}],"type":"select"}],"name":"gpt-5.4-mini"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.5","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"}],"type":"select"}],"name":"gpt-5.5"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.6-luna","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"gpt-5.6-luna"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.6-sol","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"gpt-5.6-sol"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"gpt-5.6-terra","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"gpt-5.6-terra"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unsupported"},"id":"gpt-image-1.5","name":"gpt-image-1.5"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unsupported"},"id":"gpt-image-2","name":"gpt-image-2"}],"title":{"fallback":"ChatGPT account or pool","key":"managedPurpose.openai.title"}},{"endpointTemplateIds":["cliproxyapi-openai-chat","cliproxyapi-openai-responses","cliproxyapi-anthropic"],"materializationKinds":["httpHeaders"],"purpose":"anthropic-upstream","required":false,"service":{"localId":"claude-subscription","pluginId":"happier.agent.claude"},"staticModels":[{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-3-5-haiku-20241022","name":"claude-3-5-haiku-20241022"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-3-7-sonnet-20250219","name":"claude-3-7-sonnet-20250219"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-fable-5","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"claude-fable-5"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-haiku-4-5-20251001","name":"claude-haiku-4-5-20251001"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-opus-4-1-20250805","name":"claude-opus-4-1-20250805"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-opus-4-20250514","name":"claude-opus-4-20250514"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-opus-4-5-20251101","name":"claude-opus-4-5-20251101"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-opus-4-6","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"Max","value":"max"}],"type":"select"}],"name":"claude-opus-4-6"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-opus-4-7","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"claude-opus-4-7"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-opus-4-8","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"claude-opus-4-8"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-sonnet-4-20250514","name":"claude-sonnet-4-20250514"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-sonnet-4-5-20250929","name":"claude-sonnet-4-5-20250929"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-sonnet-4-6","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"Max","value":"max"}],"type":"select"}],"name":"claude-sonnet-4-6"},{"capabilities":{"reasoningControls":"unknown","toolRoundTrips":"unknown"},"id":"claude-sonnet-5","modelOptions":[{"currentValue":"low","id":"reasoning_effort","name":"Thinking","options":[{"name":"Low","value":"low"},{"name":"Medium","value":"medium"},{"name":"High","value":"high"},{"name":"XHigh","value":"xhigh"},{"name":"Max","value":"max"}],"type":"select"}],"name":"claude-sonnet-5"}],"title":{"fallback":"Claude account or pool","key":"managedPurpose.anthropic.title"}}],"endpointTemplateIds":["cliproxyapi-openai-chat","cliproxyapi-openai-responses","cliproxyapi-anthropic"],"kind":"managed","requestAuthUses":[{"materialization":{"headerNames":["authorization","chatgpt-account-id"],"kind":"httpHeaders","origin":"https://chatgpt.com"},"purpose":"openai-upstream"},{"materialization":{"headerNames":["authorization"],"kind":"httpHeaders","origin":"https://api.anthropic.com"},"purpose":"anthropic-upstream"}],"sharing":"connectionMachine","sourceEnvelopeTransport":"cpx-v1"},"name":"CLIProxyAPI","v":1,"websiteUrl":"https://github.com/router-for-me/CLIProxyAPI"},"provenance":"first_party"},
    'happier.provider.cloudflare-ai-gateway/cloudflare-ai-gateway': {"contributionKey":"happier.provider.cloudflare-ai-gateway/cloudflare-ai-gateway","definition":{"catalog":{"manualModelPolicy":"allowed","source":"manual"},"credential":{"authorityDescription":"AI Gateway Run tokens are account-wide: they can use every gateway in that Cloudflare account, including stored BYOK credentials. Claude pass-through also requires your own Anthropic API key. Account Chat requires Workers AI Read; a token for all endpoint families needs both permissions.","keyUrl":"https://dash.cloudflare.com/profile/api-tokens","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"additionalCredentials":[{"destination":{"format":"raw","kind":"httpHeader","name":"x-api-key"},"label":"Anthropic API key","slotId":"anthropicApiKey"}],"destination":{"format":"bearer","kind":"httpHeader","name":"cf-aig-authorization"},"id":"cloudflare-anthropic-gateway","protocols":["anthropic"],"uses":["probe","runtime"]},{"destination":{"format":"bearer","kind":"httpHeader","name":"cf-aig-authorization"},"id":"cloudflare-responses-gateway","protocols":["openai-responses"],"uses":["probe","runtime"]},{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"cloudflare-chat-account","protocols":["openai-chat"],"uses":["probe","runtime"]}]},"endpointTemplates":[{"addressConstraint":{"origin":"https://gateway.ai.cloudflare.com","pathSegments":["v1",null,null,"anthropic"]},"capabilities":{"reasoningControls":"unknown","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"unknown"},"id":"cloudflare-anthropic","modelIdPattern":"^claude-[^/\\s]+$","protocol":"anthropic","publicHeaderHints":{"cf-aig-collect-log":"False suppresses stored gateway logs; upstream retention and exports are separate.","cf-aig-no-wholesale":"True prevents third-party prepaid credit fallback.","cf-aig-skip-cache":"True bypasses response caching; upstream prompt caching is separate."},"publicHeaders":{"cf-aig-collect-log":"false","cf-aig-no-wholesale":"true","cf-aig-skip-cache":"true"},"requiresEndpointOverride":true},{"addressConstraint":{"origin":"https://gateway.ai.cloudflare.com","pathSegments":["v1",null,null,"openai"]},"capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"unknown"},"id":"cloudflare-responses","modelIdPattern":"^(?!claude-)[^/\\s]+$","protocol":"openai-responses","publicHeaderHints":{"cf-aig-collect-log":"False suppresses stored gateway logs; upstream retention and exports are separate.","cf-aig-no-wholesale":"True prevents third-party prepaid credit fallback.","cf-aig-skip-cache":"True bypasses response caching; upstream prompt caching is separate."},"publicHeaders":{"cf-aig-collect-log":"false","cf-aig-no-wholesale":"true","cf-aig-skip-cache":"true"},"requiresEndpointOverride":true},{"addressConstraint":{"origin":"https://api.cloudflare.com","pathSegments":["client","v4","accounts",null,"ai","v1"]},"capabilities":{"reasoningControls":"unknown","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"unknown"},"id":"cloudflare-chat","modelIdPattern":"^[^/\\s]+/[^\\s]+$","protocol":"openai-chat","publicHeaderHints":{"cf-aig-collect-log":"False suppresses stored gateway logs; upstream retention and exports are separate.","cf-aig-gateway-id":"The gateway id is required for account Chat routing; no default gateway is selected.","cf-aig-no-wholesale":"True prevents third-party prepaid credit fallback.","cf-aig-skip-cache":"True bypasses response caching; upstream prompt caching is separate."},"publicHeaders":{"cf-aig-collect-log":"false","cf-aig-no-wholesale":"true","cf-aig-skip-cache":"true"},"requiredPublicHeaders":["cf-aig-gateway-id"],"requiresEndpointOverride":true}],"id":"cloudflare-ai-gateway","kind":"aggregator","name":"Cloudflare AI Gateway","v":1,"websiteUrl":"https://developers.cloudflare.com/ai-gateway/"},"provenance":"first_party"},
    'happier.provider.deepseek/deepseek': {"contributionKey":"happier.provider.deepseek/deepseek","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"deepseek-openai-chat","parser":"openai-models","path":"/v1/models"}],"source":"static+probe","staticModels":[{"aliases":["deepseek-chat","deepseek-reasoner"],"contextWindowTokens":1000000,"id":"deepseek-v4-flash","name":"DeepSeek V4 Flash"},{"contextWindowTokens":1000000,"id":"deepseek-v4-pro","inlineCompletion":{"maxOutputTokens":4096,"operationId":"native-fim","outputTokens":4096,"promptOverheadTokens":3,"tokenAccounting":"utf8-bytes"},"name":"DeepSeek V4 Pro"}]},"credential":{"keyUrl":"https://platform.deepseek.com/api_keys","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"raw","kind":"httpHeader","name":"x-api-key"},"id":"deepseek-anthropic-x-api-key","protocols":["anthropic"],"uses":["runtime"]},{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"deepseek-openai-bearer","protocols":["openai-chat","openai-completions"],"uses":["probe","runtime"]}]},"endpointTemplates":[{"baseUrl":"https://api.deepseek.com/beta","capabilities":{"reasoningControls":"unsupported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"unsupported"},"id":"deepseek-fim","protocol":"openai-completions"},{"baseUrl":"https://api.deepseek.com/anthropic","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"deepseek-anthropic","protocol":"anthropic"},{"baseUrl":"https://api.deepseek.com/v1","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"deepseek-openai-chat","protocol":"openai-chat"}],"id":"deepseek","inlineCompletion":[{"endpointTemplateId":"deepseek-fim","id":"native-fim","mode":"native-fim","path":"/beta/completions","wireFormat":"openai-text-completions"}],"kind":"frontier","legacyProfileMigrations":[{"credentialBinding":{"credentialSlotId":"apiKey","legacyEnvVarName":"DEEPSEEK_AUTH_TOKEN"},"descriptorRevision":2,"implicitModelAliasReplacements":[{"legacyModelId":"deepseek-chat","replacementModelId":"deepseek-v4-flash"},{"legacyModelId":"deepseek-reasoner","replacementModelId":"deepseek-v4-flash"}],"migratedEnvironmentVariables":[{"name":"ANTHROPIC_BASE_URL","value":"${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}"},{"name":"ANTHROPIC_AUTH_TOKEN","value":"${DEEPSEEK_AUTH_TOKEN}"},{"name":"ANTHROPIC_MODEL","value":"${DEEPSEEK_MODEL:-deepseek-v4-flash}"}],"primaryModel":{"agentTargetKey":"agent:claude","defaultModelId":"deepseek-v4-flash","legacyEnvVarName":"ANTHROPIC_MODEL","legacyProcessEnvAlias":"DEEPSEEK_MODEL"},"retainedEnvironmentVariables":[{"name":"API_TIMEOUT_MS","value":"${DEEPSEEK_API_TIMEOUT_MS:-600000}"},{"name":"ANTHROPIC_SMALL_FAST_MODEL","value":"${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-v4-flash}"},{"name":"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","value":"${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"}],"sourceProfileId":"deepseek"}],"name":"DeepSeek","usageSources":[{"endpointTemplateId":"deepseek-openai-chat","id":"balance","parser":"deepseek-balance","path":"/user/balance"}],"v":1,"websiteUrl":"https://www.deepseek.com"},"provenance":"first_party"},
    'happier.provider.lmstudio/lmstudio': {"contributionKey":"happier.provider.lmstudio/lmstudio","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"lmstudio-openai-responses","parser":"lmstudio-native-models","path":"/api/v1/models"},{"endpointTemplateId":"lmstudio-openai-responses","parser":"openai-models","path":"/v1/models"}],"source":"probe"},"credential":{"keyUrl":"https://lmstudio.ai/docs/app/api/tools/auth","kind":"apiKey","required":false,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"lmstudio-http-bearer","protocols":["openai-chat","openai-responses","anthropic"],"uses":["probe","runtime","management"]}]},"discovery":{"availabilityProbe":{"endpointTemplateId":"lmstudio-openai-responses","parser":"lmstudio-native-models","path":"/api/v1/models"},"installedCheck":{"lookupNames":["lms"]},"listener":{"defaultPorts":[1234],"executableBasenames":["llmster"]},"presenceCheck":{"fixedArgs":["daemon","status","--json"],"lookupNames":["lms"],"parser":"lms-status-json"},"v":1},"endpointTemplates":[{"capabilities":{"reasoningControls":"supported","statefulResponses":"supported","streaming":"supported","toolRoundTrips":"supported"},"id":"lmstudio-openai-responses","localUrlCandidates":["http://127.0.0.1:1234/v1","http://localhost:1234/v1"],"protocol":"openai-responses"},{"capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"lmstudio-openai-chat","localUrlCandidates":["http://127.0.0.1:1234/v1","http://localhost:1234/v1"],"protocol":"openai-chat"},{"capabilities":{"reasoningControls":"supported","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"lmstudio-anthropic","localUrlCandidates":["http://127.0.0.1:1234/","http://localhost:1234/"],"protocol":"anthropic"}],"id":"lmstudio","kind":"local","modelLoad":{"confirmation":"refresh-catalog-load-state","endpointTemplateId":"lmstudio-openai-responses","path":"/api/v1/models/load","preflightPolicy":"advisory","request":"json-model-id-v1"},"name":"LM Studio","v":1,"websiteUrl":"https://lmstudio.ai"},"provenance":"first_party"},
    'happier.provider.minimax/minimax': {"contributionKey":"happier.provider.minimax/minimax","definition":{"catalog":{"manualModelPolicy":"allowed","source":"static","staticModels":[{"aliases":["MiniMax-M3.1-Flash[1m]"],"capabilities":{"toolRoundTrips":"supported"},"contextWindowTokens":1000000,"extendedContextModelId":"MiniMax-M3.1-Flash[1m]","id":"MiniMax-M3.1-Flash","name":"MiniMax M3.1 Flash"},{"aliases":["MiniMax-M3[1m]"],"capabilities":{"toolRoundTrips":"supported"},"contextWindowTokens":1000000,"extendedContextModelId":"MiniMax-M3[1m]","id":"MiniMax-M3","name":"MiniMax M3"},{"capabilities":{"toolRoundTrips":"supported"},"contextWindowTokens":204800,"id":"MiniMax-M2.7","name":"MiniMax M2.7"}]},"credential":{"keyUrl":"https://platform.minimax.io/user-center/payment/token-plan","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"minimax-http-bearer","protocols":["anthropic","openai-responses"],"uses":["runtime"]}]},"endpointTemplates":[{"baseUrl":"https://api.minimax.io/anthropic","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"minimax-anthropic","protocol":"anthropic"},{"baseUrl":"https://api.minimax.io/v1","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"minimax-openai-responses","protocol":"openai-responses"}],"id":"minimax","kind":"frontier","legacyProfileMigrations":[{"credentialBinding":{"credentialSlotId":"apiKey","legacyEnvVarName":"MINIMAX_AUTH_TOKEN"},"descriptorRevision":1,"implicitModelAliasReplacements":[{"legacyModelId":"MiniMax-M3[1m]","replacementModelId":"MiniMax-M3"}],"migratedEnvironmentVariables":[{"name":"ANTHROPIC_BASE_URL","value":"${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}"},{"name":"ANTHROPIC_AUTH_TOKEN","value":"${MINIMAX_AUTH_TOKEN}"},{"name":"ANTHROPIC_MODEL","value":"${MINIMAX_MODEL:-MiniMax-M3[1m]}"}],"primaryModel":{"agentTargetKey":"agent:claude","defaultModelId":"MiniMax-M3.1-Flash","legacyEnvVarName":"ANTHROPIC_MODEL","legacyProcessEnvAlias":"MINIMAX_MODEL"},"retainedEnvironmentVariables":[{"name":"API_TIMEOUT_MS","value":"${MINIMAX_API_TIMEOUT_MS:-600000}"},{"name":"CLAUDE_CODE_AUTO_COMPACT_WINDOW","value":"${MINIMAX_AUTO_COMPACT_WINDOW:-1000000}"},{"name":"ANTHROPIC_DEFAULT_OPUS_MODEL","value":"${MINIMAX_OPUS_MODEL:-MiniMax-M3.1-Flash}"},{"name":"ANTHROPIC_DEFAULT_SONNET_MODEL","value":"${MINIMAX_SONNET_MODEL:-MiniMax-M3.1-Flash}"},{"name":"ANTHROPIC_DEFAULT_HAIKU_MODEL","value":"${MINIMAX_HAIKU_MODEL:-MiniMax-M3.1-Flash}"},{"name":"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","value":"${MINIMAX_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"}],"sourceProfileId":"minimax"}],"name":"MiniMax","v":1,"websiteUrl":"https://platform.minimax.io"},"provenance":"first_party"},
    'happier.provider.minimax/minimax-cn': {"contributionKey":"happier.provider.minimax/minimax-cn","definition":{"catalog":{"manualModelPolicy":"allowed","source":"static","staticModels":[{"aliases":["MiniMax-M3.1-Flash[1m]"],"capabilities":{"toolRoundTrips":"supported"},"contextWindowTokens":1000000,"extendedContextModelId":"MiniMax-M3.1-Flash[1m]","id":"MiniMax-M3.1-Flash","name":"MiniMax M3.1 Flash"},{"aliases":["MiniMax-M3[1m]"],"capabilities":{"toolRoundTrips":"supported"},"contextWindowTokens":1000000,"extendedContextModelId":"MiniMax-M3[1m]","id":"MiniMax-M3","name":"MiniMax M3"},{"capabilities":{"toolRoundTrips":"supported"},"contextWindowTokens":204800,"id":"MiniMax-M2.7","name":"MiniMax M2.7"}]},"credential":{"keyUrl":"https://platform.minimaxi.com/user-center/payment/token-plan","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"minimax-cn-http-bearer","protocols":["anthropic","openai-responses"],"uses":["runtime"]}]},"endpointTemplates":[{"baseUrl":"https://api.minimaxi.com/anthropic","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"minimax-cn-anthropic","protocol":"anthropic"},{"baseUrl":"https://api.minimaxi.com/v1","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"minimax-cn-openai-responses","protocol":"openai-responses"}],"id":"minimax-cn","kind":"frontier","legacyProfileMigrations":[{"credentialBinding":{"credentialSlotId":"apiKey","legacyEnvVarName":"MINIMAX_CN_AUTH_TOKEN"},"descriptorRevision":1,"implicitModelAliasReplacements":[{"legacyModelId":"MiniMax-M3[1m]","replacementModelId":"MiniMax-M3"}],"migratedEnvironmentVariables":[{"name":"ANTHROPIC_BASE_URL","value":"${MINIMAX_CN_BASE_URL:-https://api.minimaxi.com/anthropic}"},{"name":"ANTHROPIC_AUTH_TOKEN","value":"${MINIMAX_CN_AUTH_TOKEN}"},{"name":"ANTHROPIC_MODEL","value":"${MINIMAX_CN_MODEL:-MiniMax-M3[1m]}"}],"primaryModel":{"agentTargetKey":"agent:claude","defaultModelId":"MiniMax-M3.1-Flash","legacyEnvVarName":"ANTHROPIC_MODEL","legacyProcessEnvAlias":"MINIMAX_CN_MODEL"},"retainedEnvironmentVariables":[{"name":"API_TIMEOUT_MS","value":"${MINIMAX_CN_API_TIMEOUT_MS:-600000}"},{"name":"CLAUDE_CODE_AUTO_COMPACT_WINDOW","value":"${MINIMAX_CN_AUTO_COMPACT_WINDOW:-1000000}"},{"name":"ANTHROPIC_DEFAULT_OPUS_MODEL","value":"${MINIMAX_CN_OPUS_MODEL:-MiniMax-M3.1-Flash}"},{"name":"ANTHROPIC_DEFAULT_SONNET_MODEL","value":"${MINIMAX_CN_SONNET_MODEL:-MiniMax-M3.1-Flash}"},{"name":"ANTHROPIC_DEFAULT_HAIKU_MODEL","value":"${MINIMAX_CN_HAIKU_MODEL:-MiniMax-M3.1-Flash}"},{"name":"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","value":"${MINIMAX_CN_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"}],"sourceProfileId":"minimax-cn"}],"name":"MiniMax (China)","v":1,"websiteUrl":"https://platform.minimaxi.com"},"provenance":"first_party"},
    'happier.provider.ollama/ollama': {"contributionKey":"happier.provider.ollama/ollama","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"ollama-native","parser":"ollama-tags","path":"/api/tags"}],"source":"static+probe","sourceRegistryVersion":"ollama-tags/v1","staticModels":[{"contextWindowTokens":32768,"id":"qwen2.5-coder:1.5b-base","inlineCompletion":{"operationId":"native-fim","promptOverheadTokens":3,"tokenAccounting":"utf8-bytes"},"name":"Qwen2.5 Coder 1.5B Base"},{"contextWindowTokens":8192,"id":"hf.co/sweepai/sweep-next-edit-1.5B:latest","name":"Sweep Next Edit 1.5B","nextEdit":{"operationId":"next-edit","promptOverheadTokens":0,"tokenAccounting":"utf8-bytes"}}]},"discovery":{"availabilityProbe":{"endpointTemplateId":"ollama-native","parser":"ollama-tags","path":"/api/tags"},"catalogFallback":{"endpointEnvName":"OLLAMA_HOST","endpointTemplateId":"ollama-native","fixedArgs":["list"],"lookupNames":["ollama"],"parser":"ollama-list-table"},"installedCheck":{"lookupNames":["ollama"]},"listener":{"argvMatch":{"mode":"containsAll","tokens":["serve"]},"defaultPorts":[11434],"executableBasenames":["ollama","ollama.exe"]},"v":1},"endpointTemplates":[{"capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"ollama-native","localUrlCandidates":["http://127.0.0.1:11434/","http://localhost:11434/"],"protocol":"ollama-native"},{"capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"ollama-openai-chat","localUrlCandidates":["http://127.0.0.1:11434/v1","http://localhost:11434/v1"],"protocol":"openai-chat"},{"capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"ollama-openai-responses","localUrlCandidates":["http://127.0.0.1:11434/v1","http://localhost:11434/v1"],"protocol":"openai-responses"}],"id":"ollama","inlineCompletion":[{"endpointTemplateId":"ollama-native","id":"native-fim","mode":"native-fim","path":"/api/generate","wireFormat":"ollama-generate"},{"codec":"rewrite-window-v1","endpointTemplateId":"ollama-native","id":"next-edit","mode":"next-edit-codec","path":"/api/generate","wireFormat":"ollama-generate"}],"kind":"local","managedRuntime":{"endpointTemplateIds":["ollama-native","ollama-openai-chat","ollama-openai-responses"],"kind":"managed"},"name":"Ollama","v":1,"websiteUrl":"https://ollama.com"},"provenance":"first_party"},
    'happier.provider.openai/openai': {"contributionKey":"happier.provider.openai/openai","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"openai-responses","parser":"openai-models","path":"/v1/models"}],"source":"probe"},"credential":{"keyUrl":"https://platform.openai.com/api-keys","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"openai-http-bearer","protocols":["openai-chat","openai-responses"],"uses":["probe","runtime"]}]},"endpointTemplates":[{"baseUrl":"https://api.openai.com/v1","capabilities":{"reasoningControls":"supported","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"openai-chat","protocol":"openai-chat"},{"baseUrl":"https://api.openai.com/v1","capabilities":{"reasoningControls":"supported","statefulResponses":"supported","streaming":"supported","toolRoundTrips":"supported"},"id":"openai-responses","protocol":"openai-responses"}],"id":"openai","kind":"frontier","legacyProfileMigrations":[{"credentialBinding":{"credentialSlotId":"apiKey","legacyEnvVarName":"OPENAI_API_KEY"},"descriptorRevision":1,"implicitModelAliasReplacements":[],"migratedEnvironmentVariables":[{"name":"OPENAI_BASE_URL","value":"https://api.openai.com/v1"},{"name":"OPENAI_MODEL","value":"gpt-5-codex-high"}],"primaryModel":{"agentTargetKey":"agent:codex","defaultModelId":"gpt-5-codex-high","legacyEnvVarName":"OPENAI_MODEL"},"retainedEnvironmentVariables":[{"name":"OPENAI_API_TIMEOUT_MS","value":"600000"},{"name":"OPENAI_SMALL_FAST_MODEL","value":"gpt-5-codex-low"},{"name":"API_TIMEOUT_MS","value":"600000"},{"name":"CODEX_SMALL_FAST_MODEL","value":"gpt-5-codex-low"}],"sourceProfileId":"openai"}],"name":"OpenAI","v":1,"websiteUrl":"https://openai.com"},"provenance":"first_party"},
    'happier.provider.openrouter/openrouter': {"contributionKey":"happier.provider.openrouter/openrouter","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"openrouter-openai-responses","parser":"openai-models","path":"/api/v1/models"}],"source":"probe"},"credential":{"keyUrl":"https://openrouter.ai/keys","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"openrouter-http-bearer","protocols":["openai-chat","openai-responses"],"uses":["probe","runtime"]}]},"endpointTemplates":[{"baseUrl":"https://openrouter.ai/api/v1","capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"openrouter-openai-chat","protocol":"openai-chat"},{"baseUrl":"https://openrouter.ai/api/v1","capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"openrouter-openai-responses","protocol":"openai-responses"}],"id":"openrouter","kind":"aggregator","name":"OpenRouter","requestCost":{"endpointTemplateIds":["openrouter-openai-chat"]},"usageSources":[{"endpointTemplateId":"openrouter-openai-chat","id":"key-usage","parser":"openrouter-key-usage","path":"/api/v1/key"},{"billingCredential":{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"keyUrl":"https://openrouter.ai/settings/management-keys","slotId":"managementKey","title":"Management key"},"endpointTemplateId":"openrouter-openai-chat","id":"account-credits","parser":"openrouter-account-credits","path":"/api/v1/credits"}],"v":1,"websiteUrl":"https://openrouter.ai"},"provenance":"first_party"},
    'happier.provider.vercel-ai-gateway/vercel-ai-gateway': {"contributionKey":"happier.provider.vercel-ai-gateway/vercel-ai-gateway","definition":{"catalog":{"manualModelPolicy":"allowed","probes":[{"endpointTemplateId":"vercel-chat","parser":"vercel-ai-gateway-models","path":"/v1/models"}],"source":"probe"},"credential":{"keyUrl":"https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"vercel-bearer","protocols":["anthropic","openai-responses","openai-chat"],"uses":["probe","runtime"]}]},"endpointTemplates":[{"baseUrl":"https://ai-gateway.vercel.sh/claude-code","capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"vercel-anthropic","protocol":"anthropic","publicHeaders":{"http-referer":"https://happier.dev","x-title":"Happier"}},{"baseUrl":"https://ai-gateway.vercel.sh/codex/v1","capabilities":{"reasoningControls":"supported","statefulResponses":"supported","streaming":"supported","toolRoundTrips":"supported"},"id":"vercel-responses","protocol":"openai-responses","publicHeaders":{"http-referer":"https://happier.dev","x-title":"Happier"}},{"baseUrl":"https://ai-gateway.vercel.sh/coding-agent/v1","capabilities":{"reasoningControls":"supported","statefulResponses":"unsupported","streaming":"supported","toolRoundTrips":"supported"},"id":"vercel-chat","protocol":"openai-chat","publicHeaders":{"http-referer":"https://happier.dev","x-title":"Happier"}}],"id":"vercel-ai-gateway","kind":"aggregator","name":"Vercel AI Gateway","usageSources":[{"endpointTemplateId":"vercel-chat","id":"credits","parser":"vercel-credits","path":"/v1/credits"}],"v":1,"websiteUrl":"https://vercel.com/ai-gateway"},"provenance":"first_party"},
    'happier.provider.zai/zai': {"contributionKey":"happier.provider.zai/zai","definition":{"catalog":{"manualModelPolicy":"allowed","source":"static","staticModels":[{"id":"glm-5.2","name":"GLM-5.2"},{"id":"glm-5-turbo","name":"GLM-5 Turbo"},{"id":"glm-4.7","name":"GLM-4.7"}]},"credential":{"keyUrl":"https://z.ai/manage-apikey/apikey-list","kind":"apiKey","required":true,"slotId":"apiKey","transports":[{"destination":{"format":"bearer","kind":"httpHeader","name":"authorization"},"id":"zai-http-bearer","protocols":["anthropic","openai-chat"],"uses":["runtime"]}]},"endpointTemplates":[{"baseUrl":"https://api.z.ai/api/anthropic","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"zai-anthropic","protocol":"anthropic"},{"baseUrl":"https://api.z.ai/api/coding/paas/v4","capabilities":{"reasoningControls":"unknown","statefulResponses":"unknown","streaming":"supported","toolRoundTrips":"supported"},"id":"zai-openai-chat","protocol":"openai-chat"}],"id":"zai","kind":"frontier","legacyProfileMigrations":[{"credentialBinding":{"credentialSlotId":"apiKey","legacyEnvVarName":"Z_AI_AUTH_TOKEN"},"descriptorRevision":1,"implicitModelAliasReplacements":[],"migratedEnvironmentVariables":[{"name":"ANTHROPIC_BASE_URL","value":"${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}"},{"name":"ANTHROPIC_AUTH_TOKEN","value":"${Z_AI_AUTH_TOKEN}"},{"name":"ANTHROPIC_MODEL","value":"${Z_AI_MODEL:-GLM-4.6}"}],"primaryModel":{"agentTargetKey":"agent:claude","defaultModelId":"GLM-4.6","legacyEnvVarName":"ANTHROPIC_MODEL","legacyProcessEnvAlias":"Z_AI_MODEL"},"retainedEnvironmentVariables":[{"name":"API_TIMEOUT_MS","value":"${Z_AI_API_TIMEOUT_MS:-3000000}"},{"name":"ANTHROPIC_DEFAULT_OPUS_MODEL","value":"${Z_AI_OPUS_MODEL:-GLM-4.6}"},{"name":"ANTHROPIC_DEFAULT_SONNET_MODEL","value":"${Z_AI_SONNET_MODEL:-GLM-4.6}"},{"name":"ANTHROPIC_DEFAULT_HAIKU_MODEL","value":"${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}"}],"sourceProfileId":"zai"}],"name":"Z.AI","v":1,"websiteUrl":"https://z.ai"},"provenance":"first_party"},
});

export const BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS: Readonly<Record<string, Readonly<{ service: PluginContributionIdentityV1; descriptor: PluginConnectedAccountDescriptorContributionV2 }>>> = Object.freeze({
    'happier.agent.antigravity/antigravity-account': {"service":{"pluginId":"happier.agent.antigravity","localId":"antigravity-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"oauth-personal","modes":[{"allowRawAuthorizationCode":true,"callbackUrl":"https://antigravity.google/oauth-callback","id":"oauth-personal","kind":"oauthAuthorizationCode","outcomeReconciliation":"none","pkce":"required","scopes":["https://www.googleapis.com/auth/cloud-platform","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/aicode"],"title":"Sign in with Google"},{"credentialOrigin":"native_import","fields":[{"default":"acp","description":"Importing shares this native login with Happier. The native app may ask you to sign in again when Happier renews it. On macOS, ACP import reads the Keychain without testing write availability.","id":"source","presentation":{"control":"select","options":[{"title":"Antigravity ACP","value":"acp"},{"title":"Antigravity CLI (macOS and Linux)","value":"cli"},{"title":"Antigravity CLI credential file","value":"cli-file"}]},"schema":{"enum":["acp","cli","cli-file"],"type":"string"},"secret":false,"title":"Native login source"}],"id":"native-import","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Sign in to Antigravity on the computer you will import from.","Choose the matching native login source and that computer in Happier."],"createKeyTitle":"Read Antigravity sign-in instructions","url":"https://antigravity.google/docs/cli/install/"},"title":"Import native login"}]},"id":"antigravity-account","title":"Google Antigravity"}},
    'happier.channel.discord/discord-bot': {"service":{"pluginId":"happier.channel.discord","localId":"discord-bot"},"descriptor":{"authentication":{"defaultModeId":"bot-token","modes":[{"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"Token issued by the Discord Developer Portal for this bot.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Bot token"}],"id":"bot-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create or select an application in the Discord Developer Portal and open its Bot settings.","Copy its bot token; if it is no longer visible, Reset Token creates a replacement and invalidates the old token.","Paste the bot token here."],"createKeyTitle":"Open Discord applications","url":"https://discord.com/developers/applications"},"title":"Bot token"}]},"description":"Discord bot account used for Channel setup, delivery, and Gateway observation.","id":"discord-bot","title":"Discord bot"}},
    'happier.channel.email/email-imap-smtp': {"service":{"pluginId":"happier.channel.email","localId":"email-imap-smtp"},"descriptor":{"authentication":{"defaultModeId":"password","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"mailbox","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Mailbox address"},{"description":"Defaults to the mailbox address.","id":"username","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Username"},{"id":"imapHost","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"IMAP TLS host"},{"default":993,"id":"imapPort","schema":{"maximum":65535,"minimum":1,"type":"integer"},"secret":false,"title":"IMAP TLS port"},{"id":"smtpHost","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"SMTP submission host"},{"default":587,"id":"smtpPort","schema":{"maximum":65535,"minimum":1,"type":"integer"},"secret":false,"title":"SMTP submission port"},{"description":"Port 465 uses TLS; other ports use STARTTLS.","id":"smtpSecurity","presentation":{"control":"select","options":[{"title":"STARTTLS","value":"starttls"},{"title":"TLS","value":"tls"}]},"required":false,"schema":{"enum":["starttls","tls"],"type":"string"},"secret":false,"title":"SMTP security"},{"default":"INBOX","id":"inboxFolder","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Inbox folder"},{"description":"Found automatically when left empty.","id":"sentFolder","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Sent folder"},{"description":"Trust this certificate authority for both IMAP and SMTP. Leave empty to use the standard trusted authorities.","id":"tlsCaPem","presentation":{"control":"textarea"},"required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Custom TLS CA certificate (PEM)"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"password","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Password or app password"}],"id":"password","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Check your mail provider instructions for IMAP and SMTP access and the required server settings.","If your provider requires an app password, create one in that provider account; otherwise use the mailbox password it supports.","Enter that password and the matching mailbox and server settings here."],"createKeyTitle":"Read manual mailbox setup guidance","url":"https://support.mozilla.org/en-US/kb/manual-account-configuration"},"title":"App password"},{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"mailbox","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Mailbox address"},{"description":"Defaults to the mailbox address.","id":"username","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Username"},{"id":"imapHost","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"IMAP TLS host"},{"default":993,"id":"imapPort","schema":{"maximum":65535,"minimum":1,"type":"integer"},"secret":false,"title":"IMAP TLS port"},{"id":"smtpHost","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"SMTP submission host"},{"default":587,"id":"smtpPort","schema":{"maximum":65535,"minimum":1,"type":"integer"},"secret":false,"title":"SMTP submission port"},{"description":"Port 465 uses TLS; other ports use STARTTLS.","id":"smtpSecurity","presentation":{"control":"select","options":[{"title":"STARTTLS","value":"starttls"},{"title":"TLS","value":"tls"}]},"required":false,"schema":{"enum":["starttls","tls"],"type":"string"},"secret":false,"title":"SMTP security"},{"default":"INBOX","id":"inboxFolder","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Inbox folder"},{"description":"Found automatically when left empty.","id":"sentFolder","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Sent folder"},{"description":"Trust this certificate authority for both IMAP and SMTP. Leave empty to use the standard trusted authorities.","id":"tlsCaPem","presentation":{"control":"textarea"},"required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Custom TLS CA certificate (PEM)"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"tenantId","schema":{"minLength":1,"type":"string"},"secret":false,"title":"Entra tenant ID or domain"},{"id":"clientId","schema":{"minLength":1,"type":"string"},"secret":false,"title":"Application client ID"},{"id":"clientSecret","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Application client secret"}],"id":"microsoft-app-only","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Register an application in Microsoft Entra and create a client secret.","Grant the Exchange Online application permissions IMAP.AccessAsApp and SMTP.SendAsApp, obtain admin consent, and register its service principal in Exchange.","Grant access to the mailbox, then enter the tenant ID, application client ID, client secret, and mailbox server settings here."],"createKeyTitle":"Read Microsoft mailbox application setup","url":"https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth/"},"title":"Microsoft app-only"}]},"description":"Mailbox credentials for secure IMAP receiving and SMTP submission.","id":"email-imap-smtp","title":"Email IMAP + SMTP"}},
    'happier.channel.slack/slack-bot': {"service":{"pluginId":"happier.channel.slack","localId":"slack-bot"},"descriptor":{"authentication":{"defaultModeId":"bot-tokens","modes":[{"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"Install the app and copy its xoxb- bot token. See https://api.slack.com/apps for the app configuration.","id":"botToken","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Bot token"},{"description":"Generate an xapp- token with connections:write and enable Socket Mode for the same app.","id":"appToken","schema":{"minLength":1,"type":"string"},"secret":true,"title":"App-level token"}],"id":"bot-tokens","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create or select your Slack app, add the bot scopes and event subscriptions you need, and install it to your workspace.","Copy its Bot User OAuth Token from OAuth & Permissions.","Enable Socket Mode and generate an app-level token with connections:write for the same app, then paste both tokens here."],"createKeyTitle":"Open Slack apps","url":"https://api.slack.com/apps"},"title":"Bot and app tokens"}]},"description":"Bot and app-level credentials for one Slack workspace using Socket Mode.","id":"slack-bot","title":"Slack bot"}},
    'happier.channel.telegram/telegram-bot': {"service":{"pluginId":"happier.channel.telegram","localId":"telegram-bot"},"descriptor":{"authentication":{"defaultModeId":"bot-token","modes":[{"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"Token issued by Telegram BotFather for this bot.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Bot token"}],"id":"bot-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open Telegram BotFather and send /newbot to create a bot, or select an existing bot.","Copy the bot API token issued by BotFather and paste it here."],"createKeyTitle":"Open Telegram BotFather","url":"https://t.me/BotFather"},"title":"Bot token"}]},"description":"Telegram bot account used for Channel setup and delivery.","id":"telegram-bot","title":"Telegram bot"}},
    'happier.agent.claude/claude-subscription': {"service":{"pluginId":"happier.agent.claude","localId":"claude-subscription"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"setup-token","modes":[{"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Claude setup token"}],"id":"setup-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Run claude setup-token in a terminal and complete the Claude subscription sign-in.","Paste the generated token here."],"createKeyTitle":"Read Claude setup-token instructions","url":"https://code.claude.com/docs/en/cli-reference"},"title":"Setup token"},{"browserReachability":"unreachable","callbackUrl":"https://platform.claude.com/oauth/code/callback","id":"oauth","kind":"oauthAuthorizationCode","outcomeReconciliation":"none","pkce":"required","scopes":["org:create_api_key","user:profile","user:inference","user:sessions:claude_code","user:mcp_servers","user:file_upload"],"title":"Sign in with Claude"},{"credentialOrigin":"native_import","fields":[{"default":"native","description":"Importing shares this native login with Happier. The native app may ask you to sign in again when Happier renews it.","id":"source","presentation":{"control":"select","options":[{"title":"Claude Code login","value":"native"}]},"schema":{"enum":["native"],"type":"string"},"secret":false,"title":"Native login source"}],"id":"native-import","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["On the computer you will import from, run claude auth login and sign in with your Claude subscription.","Choose that computer in Happier to import its saved Claude Code login."],"createKeyTitle":"Read Claude Code login instructions","url":"https://code.claude.com/docs/en/cli-reference"},"title":"Import native login"}]},"billingUrl":"https://claude.ai/settings/billing","id":"claude-subscription","metadata":{"planLabels":{"enterprise":"Claude Enterprise","max":"Claude Max","max_20x":"Claude Max 20x","max_5x":"Claude Max 5x","pro":"Claude Pro","team":"Claude Team"}},"recoveryCredits":{"supported":true},"title":"Claude","usageIdentity":{"providerId":"claude","requiredContext":"organization"}}},
    'happier.agent.claude/anthropic': {"service":{"pluginId":"happier.agent.claude","localId":"anthropic"},"descriptor":{"authentication":{"defaultModeId":"api-key","modes":[{"accountDirectSave":true,"credentialOrigin":"authentication","fields":[{"id":"token","schema":{"minLength":1,"pattern":"^\\s*sk-ant-[A-Za-z0-9_-]+\\s*$","type":"string"},"secret":true,"title":"Anthropic API key"}],"id":"api-key","kind":"manual","outcomeReconciliation":"none","setup":{"billingNote":{"fallback":"API usage is billed separately from a Claude subscription.","key":"connectedServicesSettings.keyBillingAnthropic"},"checklist":[{"fallback":"Create an API key in the Anthropic Console, then paste it here.","key":"connectedServicesSettings.keyCreateAnthropic"}],"createKeyTitle":{"fallback":"Create an API key in the Anthropic Console, then paste it here.","key":"connectedServicesSettings.keyCreateAnthropic"},"shapeHint":{"fallback":"This looks like an Anthropic API key.","key":"connectedServicesSettings.keyShapeAnthropic"},"url":"https://platform.claude.com/settings/keys"}}]},"billingUrl":"https://platform.claude.com/settings/billing","id":"anthropic","title":"Anthropic API key"}},
    'happier.agent.codex/openai-codex': {"service":{"pluginId":"happier.agent.codex","localId":"openai-codex"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"oauth","modes":[{"callbackUrl":"http://localhost:1455/auth/callback","id":"oauth","kind":"oauthAuthorizationCode","outcomeReconciliation":"none","pkce":"required","scopes":["openid","profile","email","offline_access"],"title":"Sign in with ChatGPT"},{"id":"device","kind":"oauthDeviceCode","outcomeReconciliation":"none","scopes":["openid","profile","email","offline_access"]},{"credentialOrigin":"native_import","fields":[{"default":"native","description":"Importing shares this native login with Happier. The native app may ask you to sign in again when Happier renews it.","id":"source","presentation":{"control":"select","options":[{"title":"Codex login","value":"native"}]},"schema":{"enum":["native"],"type":"string"},"secret":false,"title":"Source"}],"id":"native-import","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["On the computer you will import from, run codex login and complete the ChatGPT sign-in.","Choose that computer in Happier to import its saved Codex login."],"createKeyTitle":"Read Codex login instructions","url":"https://developers.openai.com/codex/auth"},"title":"Import native login"}]},"id":"openai-codex","metadata":{"planLabels":{"business":"ChatGPT Business","edu":"ChatGPT Edu","edu_plus":"ChatGPT Edu Plus","edu_pro":"ChatGPT Edu Pro","education":"ChatGPT Edu","ent26":"ChatGPT Enterprise","enterprise":"ChatGPT Enterprise","enterprise_cbp_automation":"ChatGPT Enterprise (Automation)","enterprise_cbp_usage_based":"ChatGPT Enterprise CBP Usage Based","free":"ChatGPT Free","go":"ChatGPT Go","hc":"ChatGPT Enterprise","plus":"ChatGPT Plus","pro":"ChatGPT Pro (More)","prolite":"ChatGPT Pro","promax":"ChatGPT Pro (Max)","self_serve_business_prolite":"ChatGPT Self Serve Business ProLite","self_serve_business_usage_based":"ChatGPT Self Serve Business Usage Based","team":"ChatGPT Team"}},"recoveryCredits":{"supported":true},"title":"ChatGPT","usageIdentity":{"providerId":"openai-codex"}}},
    'happier.deploy.cloudflare/cloudflare': {"service":{"pluginId":"happier.deploy.cloudflare","localId":"cloudflare"},"descriptor":{"id":"cloudflare","title":"Cloudflare","description":"Connect Cloudflare to deploy Workers and Pages or manage tunnels and DNS.","authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"oauth","modes":[{"id":"oauth","kind":"oauthAuthorizationCode","title":"Sign in with Cloudflare","callbackUrl":"https://app.happier.dev/oauth/connected-account/callback","scopes":["openid","offline_access"],"pkce":"required","postAuthenticationFieldIds":["accountId"],"setup":{"url":"https://dash.cloudflare.com/?to=/:account/oauth-clients","checklist":["Register an OAuth client in Cloudflare","Choose Authorization Code with PKCE and no client secret.","Add the redirect URL below, grant the scopes below, then paste the client ID and scope IDs."],"permissions":[{"feature":"Workers","items":["Workers Scripts Write","Workers CI Write"]},{"feature":"Pages","items":["Pages Write"]},{"feature":"Tunnel","items":["Cloudflare Tunnel Write"]},{"feature":"DNS","items":["DNS Write for the selected zone"]}]},"outcomeReconciliation":"none","configuration":{"scope":"account","changeBehavior":"reconnect","fields":[{"id":"accountId","title":"Account ID","description":"The Cloudflare account that owns your resources.","schema":{"type":"string","pattern":"^[a-fA-F0-9]{32}$"},"secret":false,"required":false},{"id":"clientId","title":"OAuth client ID","schema":{"type":"string","minLength":1},"presentation":{"advanced":true},"secret":false,"required":false},{"id":"registeredScopes","title":"Registered API scope IDs","description":"The scope IDs you registered, separated by spaces.","schema":{"type":"string","minLength":1},"presentation":{"advanced":true},"secret":false,"required":false}]},"clientConfiguration":{"clientIdFieldId":"clientId","scopesFieldId":"registeredScopes"}},{"id":"token","kind":"manual","title":"API token","outcomeReconciliation":"none","fields":[{"id":"token","title":"API token","description":"Happier checks the selected account and read access for the features you choose.","schema":{"type":"string","minLength":1},"secret":true}],"setup":{"url":"https://dash.cloudflare.com/profile/api-tokens","checklist":["Open API tokens in Cloudflare","Create a token with the permissions below for what you’ll use.","Copy it, then paste it below."],"permissions":[{"feature":"Workers","items":["User-owned token","Workers Scripts Write","Workers CI Write"]},{"feature":"Pages","items":["Pages Write"]},{"feature":"Tunnel","items":["Cloudflare Tunnel Write"]},{"feature":"DNS","items":["DNS Write for the selected zone"]}]},"configuration":{"scope":"account","changeBehavior":"reconnect","fields":[{"id":"accountId","title":"Account ID","description":"The Cloudflare account that owns your resources.","schema":{"type":"string","pattern":"^[a-fA-F0-9]{32}$"},"secret":false,"required":true},{"id":"features","title":"Features","description":"Check read access for the features you plan to use. Cloudflare checks write permissions when you use each feature.","schema":{"type":"array","items":{"type":"string","enum":["Workers","Pages","Tunnel","DNS"]}},"secret":false,"default":[],"required":false},{"id":"tokenOwner","title":"Token owner","description":"Account tokens support Pages, Tunnel and DNS. Workers Builds requires a user token.","schema":{"type":"string","enum":["user","account"]},"secret":false,"default":"user","required":false},{"id":"zoneId","title":"DNS zone ID","description":"Optional zone for DNS record changes.","schema":{"type":"string","pattern":"^[a-fA-F0-9]{32}$"},"presentation":{"advanced":true},"secret":false,"required":false}]},"directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"credentialOrigin":"authentication"}]}}},
    'happier.deploy.neon/neon': {"service":{"pluginId":"happier.deploy.neon","localId":"neon"},"descriptor":{"authentication":{"account":{"artifactId":"account-runtime","exportName":"activateAccount"},"defaultModeId":"token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"organizationId","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Organization ID"},{"description":"Optional exact project for a project-scoped key.","id":"projectId","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Project ID"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open API keys in your Neon account settings or the selected organization settings and create a management API key.","Choose access for the organization or project you want to manage.","Copy the key when it is shown and enter the matching organization ID and optional project ID here."],"createKeyTitle":"Open Neon Console","url":"https://console.neon.tech"},"title":"Management API key"}]},"description":"Create a management API key at https://console.neon.tech: open Settings > API keys in your profile or selected organization. Choose its organization and optionally one existing project. Project-scoped keys cannot create organization projects. Setup verifies the selected scope; Neon checks permission for each operation.","id":"neon","title":"Neon"}},
    'happier.deploy.supabase/supabase': {"service":{"pluginId":"happier.deploy.supabase","localId":"supabase"},"descriptor":{"authentication":{"account":{"artifactId":"account-runtime","exportName":"activateAccount"},"defaultModeId":"token","modes":[{"browserReachability":"unreachable","configuration":{"changeBehavior":"reconnect","fields":[{"id":"organizationSlug","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Organization slug"},{"description":"Optional exact project reference for a project-scoped token.","id":"projectRef","required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Project reference"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Personal access token"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create a personal access token in your Supabase account access-token settings.","Choose the organizations, projects, and permissions needed for the actions you want to use.","Copy the management token and enter the matching organization slug and optional project reference here."],"createKeyTitle":"Open Supabase access tokens","url":"https://supabase.com/dashboard/account/tokens"},"title":"Personal access token"}]},"description":"Use a Supabase management personal access token, not an application anon or service-role key. Choose the organization and optionally one existing project. Setup verifies that exact scope; Supabase checks permission for each operation. Project-scoped access cannot create organization projects.","id":"supabase","title":"Supabase"}},
    'happier.agent.gemini/gemini-account': {"service":{"pluginId":"happier.agent.gemini","localId":"gemini-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"api-key","modes":[{"accountDirectSave":{"fieldKeys":{"token":"apiKey"}},"directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Gemini API key"}],"id":"api-key","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create a Gemini API key in Google AI Studio for the project you want to use.","Copy the key and paste it here."],"createKeyTitle":"Open Google AI Studio API keys","url":"https://aistudio.google.com/apikey"}},{"directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"credentialsJson","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Service-account JSON"}],"id":"service-account","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Select your Google Cloud project and a service account with the Vertex AI access you need.","Open its Keys tab, choose Add key > Create new key, and select JSON.","Paste the full downloaded JSON file here."],"createKeyTitle":"Open Google Cloud service accounts","url":"https://console.cloud.google.com/iam-admin/serviceaccounts"},"title":"Google service account"}]},"id":"gemini-account","title":"Gemini"}},
    'happier.jira/jira-account': {"service":{"pluginId":"happier.jira","localId":"jira-account"},"descriptor":{"authentication":{"account":{"artifactId":"jira-account-runtime","exportName":"activate"},"defaultModeId":"api-token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"site","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountOrigin","title":"Jira Cloud site"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"email","schema":{"minLength":1,"type":"string"},"secret":false,"title":"Atlassian account email"},{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API token"}],"id":"api-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create an API token without scopes in your Atlassian account; this connection uses your Jira site URL.","Copy the token and enter the email address of the Atlassian account that created it.","Enter the Jira Cloud site that account can access."],"createKeyTitle":"Open Atlassian API tokens","url":"https://id.atlassian.com/manage-profile/security/api-tokens"},"title":"Personal API token (without scopes)"}]},"description":"A Jira Cloud site and a personal Atlassian API token.","id":"jira-account","title":"Jira Cloud account"}},
    'happier.linear/linear-account': {"service":{"pluginId":"happier.linear","localId":"linear-account"},"descriptor":{"authentication":{"account":{"artifactId":"linear-account-runtime","exportName":"activate"},"defaultModeId":"personal-api-key","modes":[{"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A key with Read access and the issue/comment write permissions you want to use.","id":"personal-api-key","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Linear personal API key"}],"id":"personal-api-key","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["In Linear, open Settings > Account > Security & Access and create a personal API key.","Give it Read access, the teams you need, and the write permissions for the issue and comment actions you want to use.","Copy the key and paste it here."],"createKeyTitle":"Open Linear","url":"https://linear.app"},"title":"Personal API key"}]},"description":"Personal API key for the Linear teams you can access.","id":"linear-account","title":"Linear account"}},
    'happier.machine.agent37/agent37-account': {"service":{"pluginId":"happier.machine.agent37","localId":"agent37-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"browserReachability":"unreachable","credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open API keys in the Agent37 dashboard.","Choose an existing Saved Secret for the API key, or enter a new key."],"createKeyTitle":"Open Agent37 API keys","shapeHint":"Use an Agent37 API key.","url":"https://www.agent37.com/dashboard"},"title":"API key"}]},"id":"agent37-account","title":"Agent37 account","ui":{"category":"cloud-machines"}}},
    'happier.machine.boat/boat-account': {"service":{"pluginId":"happier.machine.boat","localId":"boat-account"},"descriptor":{"authentication":{"defaultModeId":"token","modes":[{"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Select the account or organization that should own the sandboxes in the Boat dashboard.","Create an API key with sandbox.create, sandbox.read, sandbox.update, sandbox.stop, sandbox.resume, sandbox.fork, sandbox.delete (or sandbox.delete-own for sandboxes created by this key), ssh, snapshot.read, and account.read.","Ensure the key can access the selected source sandboxes and snapshots. Older ci keys may lack resume or ssh; verify account.read explicitly. Copy and paste the key here."],"createKeyTitle":"Open Boat dashboard","shapeHint":"New Boat API keys start with boat_. Existing box_ keys are also supported.","url":"https://boat.dev/dashboard"},"title":"API key"}]},"id":"boat-account","title":"Boat account","ui":{"category":"cloud-machines"}}},
    'happier.machine.crabbox/coordinator': {"service":{"pluginId":"happier.machine.crabbox","localId":"coordinator"},"descriptor":{"authentication":{"defaultModeId":"token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"endpoint","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountBase","title":"Coordinator URL"},{"id":"namespace","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Namespace"}],"scope":"account"},"credentialFieldKeys":{"token":"token"},"directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Coordinator token"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Ask your Crabbox coordinator operator for its URL, organization namespace and a coordinator bearer token.","Enter that coordinator URL and namespace, then paste the token here."],"createKeyTitle":"Read coordinator sign-in instructions","shapeHint":"Use a coordinator user or shared operator token, not a cloud-provider API key.","url":"https://crabbox.sh/commands/login.html"}}]},"id":"coordinator","title":"Crabbox coordinator","ui":{"category":"cloud-machines"}}},
    'happier.machine.cua/cloud-native': {"service":{"pluginId":"happier.machine.cua","localId":"cloud-native"},"descriptor":{"authentication":{"defaultModeId":"native","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"nativeHome","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Native Cua home directory"}],"scope":"account"},"fields":[],"id":"native","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["On the Machine running Cua, configure your AWS, Google Cloud or Modal credentials and connect that provider with cua cloud connect.","Use cua cloud status to check the connection, then enter the absolute CUA_HOME directory used for that setup."],"createKeyTitle":"Read Cua cloud setup instructions","shapeHint":"This selects existing cloud-provider setup in a native Cua home directory; no API key is pasted here.","url":"https://cua.ai/docs/cua-sdk/guides/your-cloud"},"title":"Existing native setup"}]},"id":"cloud-native","title":"Cua cloud account","ui":{"category":"cloud-machines"}}},
    'happier.machine.cua/cua-account': {"service":{"pluginId":"happier.machine.cua","localId":"cua-account"},"descriptor":{"authentication":{"defaultModeId":"native","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"nativeHome","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Native Cua home directory"}],"scope":"account"},"fields":[],"id":"native","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["On the Machine running Cua, sign in with cua auth login using CUA_CREDENTIAL_STORE=file and the CUA_HOME directory you want to connect.","Enter that absolute CUA_HOME directory here, matching the directory selected for the cloud account."],"createKeyTitle":"Read Cua sign-in instructions","shapeHint":"This selects an existing native Cua sign-in; no API key is pasted here.","url":"https://cua.ai/docs/cua-cli/guides/authentication"},"title":"Existing native setup"}]},"id":"cua-account","title":"Cua login","ui":{"category":"cloud-machines"}}},
    'happier.machine.daytona/daytona-account': {"service":{"pluginId":"happier.machine.daytona","localId":"daytona-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A Daytona organization key with sandbox write and delete permissions.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Select your organization in the Daytona dashboard and choose Create Key.","Name the key and enable sandbox write and delete permissions, then create it.","Copy the new API key and paste it here."],"createKeyTitle":"Open Daytona API keys","url":"https://app.daytona.io/dashboard/keys"},"title":"API key"}]},"id":"daytona-account","title":"Daytona account","ui":{"category":"cloud-machines"}}},
    'happier.machine.digitalocean/digitalocean-account': {"service":{"pluginId":"happier.machine.digitalocean","localId":"digitalocean-account"},"descriptor":{"authentication":{"defaultModeId":"token","modes":[{"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":{"fallback":"Use a DigitalOcean personal access token. Create one in the control panel under Account → API → Tokens.","key":"machineDigitalOcean.account.tokenHint"},"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API token"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["In the DigitalOcean Control Panel, open Account → API → Tokens and choose Generate New Token.","Choose a name, expiration and permissions for managing Droplets, SSH keys and tags, and reading sizes, images and regions.","Generate the personal access token, then copy and paste it here."],"createKeyTitle":"Open DigitalOcean API tokens","url":"https://cloud.digitalocean.com/account/api/tokens"},"title":"API token"}]},"id":"digitalocean-account","title":"DigitalOcean cloud account","ui":{"category":"cloud-machines"}}},
    'happier.machine.e2b/e2b-account': {"service":{"pluginId":"happier.machine.e2b","localId":"e2b-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open the API keys tab in the E2B dashboard for the team that will own your sandboxes.","Copy an API key and paste it here."],"createKeyTitle":"Open E2B API keys","shapeHint":"E2B API keys start with e2b_.","url":"https://console.e2b.dev/?tab=keys"},"title":"API key"}]},"id":"e2b-account","title":"E2B account","ui":{"category":"cloud-machines"}}},
    'happier.machine.fly/fly-account': {"service":{"pluginId":"happier.machine.fly","localId":"fly-account"},"descriptor":{"authentication":{"defaultModeId":"token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"organizationSlug","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":"Organization"}],"scope":"account"},"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API token"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Sign in to Fly.io with fly auth login.","Run fly tokens create org --org YOUR_ORGANIZATION to create a token for the organization that will own your Machines.","Paste the token here and enter the same organization slug below."],"createKeyTitle":"Read Fly.io token instructions","shapeHint":"Use an organization token that can manage apps and Machines.","url":"https://docs.fly.io/security/tokens"},"title":"API token"}]},"id":"fly-account","title":"Fly cloud account","ui":{"category":"cloud-machines"}}},
    'happier.machine.freestyle/freestyle-account': {"service":{"pluginId":"happier.machine.freestyle","localId":"freestyle-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"browserReachability":"unreachable","credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A Freestyle API key for VM create, exec, filesystem and deletion.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Sign in to Freestyle and select the team that will own your VMs.","Create an API key in the dashboard, or use freestyle tokens create after signing in with freestyle login.","Copy the API key and paste it here."],"createKeyTitle":"Open Freestyle dashboard","shapeHint":"Use a team API key, not an end-user identity token.","url":"https://dash.freestyle.sh/"},"title":"API key"}]},"id":"freestyle-account","title":"Freestyle account","ui":{"category":"cloud-machines"}}},
    'happier.machine.hetzner/hetzner-account': {"service":{"pluginId":"happier.machine.hetzner","localId":"hetzner-account"},"descriptor":{"authentication":{"account":{"artifactId":"account-runtime","exportName":"activateAccount"},"defaultModeId":"token","modes":[{"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API token"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open your project in Hetzner Console, then choose Security → API tokens.","Generate a token with Read & Write access, then paste it here."],"createKeyTitle":"Open Hetzner Console","url":"https://console.hetzner.com/"},"title":"API token"}]},"description":"Run coding sessions on Hetzner Cloud servers.","id":"hetzner-account","title":"Hetzner cloud account","ui":{"category":"cloud-machines"}}},
    'happier.machine.maritime/maritime-account': {"service":{"pluginId":"happier.machine.maritime","localId":"maritime-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"browserReachability":"unreachable","credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Use one API key with manage scope: deleting agent boxes requires manage, beyond deploy and computers.","Select an existing Saved Secret for the API key, or enter a new key."],"createKeyTitle":"Maritime API key setup","shapeHint":"Maritime API keys start with mk_.","url":"https://maritime.sh/docs/sdk/authentication"},"title":"API key"}]},"id":"maritime-account","title":"Maritime account","ui":{"category":"cloud-machines"}}},
    'happier.machine.modal/modal-account': {"service":{"pluginId":"happier.machine.modal","localId":"modal-account"},"descriptor":{"authentication":{"defaultModeId":"token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"id":"serverUrl","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountOrigin","title":"Modal API origin"},{"id":"environment","required":false,"schema":{"type":"string"},"secret":false,"title":"Modal environment"}],"scope":"account"},"credentialFieldKeys":{"tokenId":"tokenId","tokenSecret":"tokenSecret"},"directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"tokenId","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Token ID"},{"id":"tokenSecret","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Token secret"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open your workspace settings in the Modal Dashboard.","Create an API token, then paste its token ID and token secret here."],"createKeyTitle":"Open Modal API tokens","shapeHint":"Use the API token ID (ak-…) and secret (as-…), not a Web Function proxy token.","url":"https://modal.com/settings/tokens"}}]},"description":"Run coding sessions in Modal Sandboxes.","id":"modal-account","title":"Modal","ui":{"category":"cloud-machines"}}},
    'happier.machine.railway/railway-account': {"service":{"pluginId":"happier.machine.railway","localId":"railway-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"browserReachability":"unreachable","credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A Railway Account API token with access to the selected environment. Project tokens are not supported.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Account API token"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open Tokens in your Railway account settings and create a token.","Select No workspace to create an account token, then copy and paste it here."],"createKeyTitle":"Open Railway account tokens","shapeHint":"Use an account API token. Project and workspace tokens cannot perform the account check used here.","url":"https://railway.com/account/tokens"},"title":"Account API token"}]},"id":"railway-account","title":"Railway account","ui":{"category":"cloud-machines"}}},
    'happier.machine.superserve/superserve-account': {"service":{"pluginId":"happier.machine.superserve","localId":"superserve-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"browserReachability":"unreachable","credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"An API key from the Superserve dashboard.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Select your team in the Superserve console, then open Settings → API keys.","Choose Create key, then copy the new key and paste it here."],"createKeyTitle":"Open Superserve console","shapeHint":"Superserve API keys start with ss_live_ and belong to one team.","url":"https://console.superserve.ai/"},"title":"API key"}]},"id":"superserve-account","title":"Superserve account","ui":{"category":"cloud-machines"}}},
    'happier.machine.upstash-box/upstash-box-account': {"service":{"pluginId":"happier.machine.upstash-box","localId":"upstash-box-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"An Upstash Box API key.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API key"}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open Upstash Box in the Upstash Console and create a Box API key.","Copy the Box API key and paste it here."],"createKeyTitle":"Open Upstash Console","shapeHint":"Use a Box API key starting with box_, not a Redis REST token or Developer API key.","url":"https://console.upstash.com/"},"title":"API key"}]},"id":"upstash-box-account","title":"Upstash Box account","ui":{"category":"cloud-machines"}}},
    'happier.machine.vercel/vercel-account': {"service":{"pluginId":"happier.machine.vercel","localId":"vercel-account"},"descriptor":{"authentication":{"account":{"artifactId":"connected-account-authentication","exportName":"activate"},"defaultModeId":"token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"description":{"fallback":"Find it in Vercel, under Team settings.","key":"machineVercel.teamIdDescription"},"id":"teamId","presentation":{"order":1,"placeholder":"team_…"},"required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"title":{"fallback":"Team ID","key":"machineVercel.teamId"}},{"description":{"fallback":"Required for sandboxes and project-scoped tokens. Find it in Vercel, under Project settings.","key":"machineVercel.projectIdDescription"},"id":"projectId","presentation":{"order":2,"placeholder":"prj_…"},"required":false,"schema":{"minLength":1,"type":"string"},"secret":false,"title":{"fallback":"Project ID","key":"machineVercel.projectId"}}],"scope":"account"},"credentialFieldKeys":{"token":"token"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":{"fallback":"Use a personal access token for the selected team or project. Sandboxes also require team plan access.","key":"machineVercel.tokenDescription"},"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":{"fallback":"Access token","key":"machineVercel.token"}}],"id":"token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open Tokens in your Vercel account settings and enter a name for the token.","Choose a scope with access to the team and projects where you will create sandboxes, then choose an expiration and create the token.","Copy the token and paste it here; enter the matching Team ID below."],"createKeyTitle":"Open Vercel access tokens","url":"https://vercel.com/account/tokens"},"title":{"fallback":"Access token","key":"machineVercel.token"}}]},"id":"vercel-account","title":{"fallback":"Vercel account","key":"machineVercel.account"},"ui":{"category":"cloud-machines"}}},
    'happier.voice.openai/openai': {"service":{"pluginId":"happier.voice.openai","localId":"openai"},"descriptor":{"authentication":{"defaultModeId":"api-key","modes":[{"accountDirectSave":true,"directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"OpenAI API key"}],"id":"api-key","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Choose the OpenAI API project you want to use and create a secret API key.","Copy the key when it is shown and paste it here."],"createKeyTitle":"Open OpenAI API keys","url":"https://platform.openai.com/api-keys"}}]},"id":"openai","title":"OpenAI API key"}},
    'happier.posthog/posthog-api': {"service":{"pluginId":"happier.posthog","localId":"posthog-api"},"descriptor":{"authentication":{"account":{"artifactId":"posthog-account-runtime","exportName":"activate"},"defaultModeId":"personal-api-key","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"description":{"fallback":"The API origin of your PostHog deployment, for example https://eu.posthog.com, https://us.posthog.com, or your self-hosted URL.","key":"plugins.posthog.auth.origin.description"},"id":"api-origin","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountOrigin","title":{"fallback":"PostHog URL","key":"plugins.posthog.auth.origin.title"}}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":{"fallback":"A personal API key scoped to error_tracking:read, organization:read, project:read and activity_log:read. Issue writes additionally need error_tracking:write.","key":"plugins.posthog.auth.personalApiKey.description"},"id":"personal-api-key","schema":{"minLength":1,"type":"string"},"secret":true,"title":{"fallback":"PostHog personal API key","key":"plugins.posthog.auth.personalApiKey.title"}}],"id":"personal-api-key","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Open Personal API keys in the account settings of the PostHog deployment you will connect.","Create a personal API key with the scopes needed for the projects and actions you want to use.","Copy the key and enter the matching deployment URL here."],"createKeyTitle":"Read PostHog API key instructions","url":"https://posthog.com/docs/api/personal-api-keys"},"title":{"fallback":"Personal API key","key":"plugins.posthog.auth.personalApiKey.mode"}}]},"description":{"fallback":"PostHog deployment and personal API key used to read organizations, environments and Error Tracking issues.","key":"plugins.posthog.account.description"},"id":"posthog-api","title":{"fallback":"PostHog account","key":"plugins.posthog.account.title"}}},
    'happier.scm.forge.azure-devops/azure-devops-account': {"service":{"pluginId":"happier.scm.forge.azure-devops","localId":"azure-devops-account"},"descriptor":{"authentication":{"account":{"artifactId":"azure-devops-account-runtime","exportName":"activate"},"defaultModeId":"manual","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"description":{"fallback":"https://dev.azure.com/your-organization for Azure DevOps Services, or your Azure DevOps Server collection URL.","key":"plugins.azureDevops.auth.base.description"},"id":"base","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountBase","title":{"fallback":"Azure DevOps URL","key":"plugins.azureDevops.auth.base.title"}}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":{"fallback":"Use Code (read) to browse. Actions that change Azure DevOps require Code (read & write).","key":"plugins.azureDevops.auth.token.description"},"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":{"fallback":"Personal access token","key":"plugins.azureDevops.auth.token.title"}}],"id":"manual","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["In the Azure DevOps deployment you will connect, open User settings > Personal access tokens and create a token.","Select the organization, expiration, and Code and Work Items permissions needed for the actions you want to use.","Copy the token and enter the matching organization or collection URL here."],"createKeyTitle":"Read Azure DevOps token instructions","url":"https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops"},"title":{"fallback":"Azure DevOps personal access token","key":"plugins.azureDevops.auth.manual.title"}}]},"capabilities":["scmHostingBasicAuth"],"description":{"fallback":"Azure DevOps deployment and personal access token used to read pull requests.","key":"plugins.azureDevops.account.description"},"id":"azure-devops-account","title":{"fallback":"Azure DevOps account","key":"plugins.azureDevops.account.title"}}},
    'happier.scm.forge.bitbucket/bitbucket-account': {"service":{"pluginId":"happier.scm.forge.bitbucket","localId":"bitbucket-account"},"descriptor":{"authentication":{"account":{"artifactId":"bitbucket-account-runtime","exportName":"activate"},"defaultModeId":"manual","modes":[{"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"The email address of the Atlassian account this API token belongs to.","id":"identity","schema":{"minLength":1,"type":"string"},"secret":false,"title":"Atlassian account email"},{"description":"A Bitbucket API token with read:user:bitbucket, read:workspace:bitbucket, read:repository:bitbucket, read:pullrequest:bitbucket, and write:pullrequest:bitbucket scopes. Add write:repository:bitbucket when Sessions will push changes.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"API token"}],"id":"manual","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create an API token with scopes in your Atlassian account and select Bitbucket as the app.","Grant the repository, pull request, and issue permissions needed for the actions you want to use.","Copy the token and enter the email address of the Atlassian account that created it."],"createKeyTitle":"Open Atlassian API tokens","url":"https://id.atlassian.com/manage-profile/security/api-tokens"}}]},"capabilities":["scmHostingBasicAuth"],"description":"Bitbucket account used for repository and pull-request operations.","id":"bitbucket-account","title":"Bitbucket account"}},
    'happier.scm.forge.github/github-account': {"service":{"pluginId":"happier.scm.forge.github","localId":"github-account"},"descriptor":{"authentication":{"account":{"artifactId":"github-account-runtime","exportName":"activate"},"defaultModeId":"fine-grained-pat","modes":[{"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A GitHub fine-grained personal access token with access to the repositories you use in Happier.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Fine-grained personal access token"}],"id":"fine-grained-pat","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Generate a fine-grained personal access token and choose its resource owner, repositories, and expiration.","Grant the repository and organization permissions needed for the actions you want to use; an organization may require approval.","Copy the generated token and paste it here."],"createKeyTitle":"Open GitHub fine-grained tokens","url":"https://github.com/settings/personal-access-tokens/new"},"title":"Fine-grained personal access token"},{"credentialOrigin":"native_import","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"default":"native","description":"Save this machine’s GitHub CLI login as a connected GitHub account in Happier.","id":"source","presentation":{"control":"select","options":[{"title":"GitHub CLI login","value":"native"}]},"schema":{"enum":["native"],"type":"string"},"secret":false,"title":"Source"}],"id":"native-import","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["On the computer you will import from, run gh auth login and complete the GitHub sign-in.","Choose that computer in Happier to import its saved GitHub CLI login."],"createKeyTitle":"Read GitHub CLI login instructions","url":"https://cli.github.com/manual/gh_auth_login"},"title":"Import GitHub CLI login"}],"native":{"systemTool":"gh"}},"capabilities":["scmHostingToken"],"description":"GitHub account used for repository and pull-request operations.","id":"github-account","title":"GitHub account"}},
    'happier.scm.forge.gitlab/gitlab-account': {"service":{"pluginId":"happier.scm.forge.gitlab","localId":"gitlab-account"},"descriptor":{"authentication":{"account":{"artifactId":"gitlab-account-runtime","exportName":"activate"},"defaultModeId":"personal-access-token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"description":"Connect to GitLab.com.","id":"baseUrl","originByValue":{"https://gitlab.com":"https://gitlab.com"},"required":true,"schema":{"enum":["https://gitlab.com"],"type":"string"},"secret":false,"semantic":"connectedAccountFixedOrigin","title":"GitLab deployment"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A GitLab personal access token. Reading needs read_api; mutations need api.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Personal access token"}],"id":"personal-access-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create a legacy personal access token in your GitLab.com profile settings.","Select read_api for reads or api for mutations, and choose an expiration.","Copy the generated token and paste it here."],"createKeyTitle":"Open GitLab.com access tokens","url":"https://gitlab.com/-/user_settings/personal_access_tokens"},"title":"GitLab.com personal access token"},{"configuration":{"changeBehavior":"reconnect","fields":[{"description":"The exact HTTPS base URL of your GitLab deployment, including any path prefix.","id":"baseUrl","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountBase","title":"Self-managed GitLab URL"}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":"A GitLab personal access token. Reading needs read_api; mutations need api.","id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":"Personal access token"}],"id":"self-hosted-personal-access-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["On your own GitLab deployment, open your profile settings and create a personal access token.","Select read_api for reads or api for mutations, and choose an expiration.","Paste the token here and enter the URL of that same deployment, including any path prefix."],"createKeyTitle":"Read GitLab access token instructions","url":"https://docs.gitlab.com/user/profile/personal_access_tokens/"},"title":"Self-managed GitLab personal access token"}]},"description":"GitLab deployment and personal access token used to read merge requests and issues.","id":"gitlab-account","title":"GitLab account"}},
    'happier.sentry/sentry-account': {"service":{"pluginId":"happier.sentry","localId":"sentry-account"},"descriptor":{"authentication":{"account":{"artifactId":"sentry-account-runtime","exportName":"activate"},"defaultModeId":"auth-token","modes":[{"configuration":{"changeBehavior":"reconnect","fields":[{"description":{"fallback":"Choose the region that stores this organization’s data. A connection serves one region; add a second connection for the other.","key":"plugins.sentry.auth.region.description"},"id":"region","originByValue":{"de":"https://de.sentry.io","us":"https://us.sentry.io"},"required":true,"schema":{"enum":["us","de"],"type":"string"},"secret":false,"semantic":"connectedAccountFixedOrigin","title":{"fallback":"Sentry Cloud region","key":"plugins.sentry.auth.region.title"}}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":{"fallback":"An internal-integration or personal token with org:read and event:read. Issue writes additionally need event:write.","key":"plugins.sentry.auth.token.description"},"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":{"fallback":"Sentry auth token","key":"plugins.sentry.auth.token.title"}}],"id":"auth-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["In your Sentry organization settings, create an internal integration and its auth token, or use a personal auth token.","Give the token org:read and event:read; issue updates also need event:write.","Copy the token and select the region that stores your organization data."],"createKeyTitle":"Open Sentry","url":"https://sentry.io"},"title":{"fallback":"Sentry Cloud token","key":"plugins.sentry.auth.cloud.title"}},{"configuration":{"changeBehavior":"reconnect","fields":[{"description":{"fallback":"The origin of your self-hosted Sentry, for example https://sentry.example.com.","key":"plugins.sentry.auth.origin.description"},"id":"origin","required":true,"schema":{"minLength":1,"type":"string"},"secret":false,"semantic":"connectedAccountOrigin","title":{"fallback":"Sentry URL","key":"plugins.sentry.auth.origin.title"}}],"scope":"account"},"credentialOrigin":"authentication","directExport":{"contractVersion":"happier.team-credential-manual-connected-account-direct.v1"},"fields":[{"description":{"fallback":"An internal-integration or personal token with org:read and event:read. Issue writes additionally need event:write.","key":"plugins.sentry.auth.token.description"},"id":"token","schema":{"minLength":1,"type":"string"},"secret":true,"title":{"fallback":"Sentry auth token","key":"plugins.sentry.auth.token.title"}}],"id":"self-hosted-auth-token","kind":"manual","outcomeReconciliation":"none","setup":{"checklist":["Create an internal-integration or personal auth token on your own Sentry deployment.","Give the token org:read and event:read; issue updates also need event:write.","Paste the token and enter the URL of that same deployment."],"createKeyTitle":"Read Sentry authentication instructions","url":"https://docs.sentry.io/api/auth/"},"title":{"fallback":"Self-hosted Sentry token","key":"plugins.sentry.auth.selfHosted.title"}}]},"description":{"fallback":"Sentry deployment and auth token used to read organizations and issues.","key":"plugins.sentry.account.description"},"id":"sentry-account","title":{"fallback":"Sentry account","key":"plugins.sentry.account.title"}}},
});

/** Declared machine kinds and billing; these facts do not grant controller availability or execution. */
export const BUNDLED_MACHINE_PROVISIONER_DECLARATIONS: Readonly<Record<string, Readonly<{ contribution: PluginContributionIdentityV1; descriptor: MachineProvisionerContributionV1 }>>> = Object.freeze<Record<string, Readonly<{ contribution: PluginContributionIdentityV1; descriptor: MachineProvisionerContributionV1 }>>>({
    'happier.machine.agent37/agent37': {"contribution":{"pluginId":"happier.machine.agent37","localId":"agent37"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed","storageCharges":[{"amount":"0.09","currency":"USD","label":"Retained disk, including while stopped","observedAt":1793836800000,"source":"https://www.agent37.com/docs/agents-api/instance-sizing","unit":"GB-month"}]},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":"Persistent Agent37 Ubuntu VMs, coding containers or dedicated Performance machines, connected as ordinary Happier Machines.","enrollmentRole":"sandbox","icon":"cloud","id":"agent37","kindTitle":"Linux machine","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"vm"},"region":{"anyOf":[{"const":"us"},{"const":"eu"},{"const":"ap-south"}]},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["kind","size","region"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"default"},"region":{"const":"us"},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["kind","size","region"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"performance"},"region":{"anyOf":[{"const":"us"},{"const":"eu"},{"const":"ap-south"}]},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["kind","size","region"],"type":"object"}]},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"kind":{"const":"acquire"},"launch":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"vm"},"region":{"anyOf":[{"const":"us"},{"const":"eu"},{"const":"ap-south"}]},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["kind","size","region"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"default"},"region":{"const":"us"},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["kind","size","region"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"performance"},"region":{"anyOf":[{"const":"us"},{"const":"eu"},{"const":"ap-south"}]},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["kind","size","region"],"type":"object"}]},"managedId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","managedId","launch"],"type":"object"}},"resourceIdPath":"instanceId","resourceKind":"agent37-instance","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"instanceId":{"pattern":"^[a-z0-9]{10}$","type":"string"},"kind":{"anyOf":[{"const":"vm"},{"const":"default"},{"const":"performance"}]},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"region":{"anyOf":[{"const":"us"},{"const":"eu"},{"const":"ap-south"}]},"size":{"anyOf":[{"const":"2-4"},{"const":"4-8"},{"const":"4-16"},{"const":"4-32"}]}},"required":["instanceId","managedId","kind","size","region"],"type":"object"},"retention":{"supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"Agent37"}},
    'happier.machine.boat/boat': {"contribution":{"pluginId":"happier.machine.boat","localId":"boat"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power","renew":"renew"},"billing":{"location":"cloud","stoppedBilling":"not-billed"},"bootstrapCredential":{"kind":"ssh"},"browserReachable":false,"description":{"fallback":"EU-only Boat sandboxes. Running time is billed per second; stopping pauses compute billing. Plans start at $20/month and include the same amount of usage.","key":"machineBoat.presentation.description"},"enrollmentRole":"server","icon":"cloud","id":"boat","kindTitle":{"fallback":"sandbox","key":"machineBoat.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"size":{"anyOf":[{"const":"small"},{"const":"default"},{"const":"large"},{"const":"xlarge"}]},"source":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"blank"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"named-snapshot"},"name":{"pattern":"^[a-z0-9][a-z0-9-]{0,62}$","type":"string"}},"required":["kind","name"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"fork"},"sandboxId":{"pattern":"^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$","type":"string"}},"required":["kind","sandboxId"],"type":"object"}]}},"required":["size","source"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[{"id":"ssh-keyscan","kind":"systemTool"}],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"idempotencyKey":{"maxLength":255,"minLength":1,"type":"string"},"kind":{"const":"acquire"},"sandboxId":{"pattern":"^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$","type":"string"}},"required":["kind","idempotencyKey"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"delete"},"operationId":{"pattern":"^bdop_[a-f0-9]{32}$","type":"string"},"sandboxId":{"pattern":"^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$","type":"string"}},"required":["kind","operationId","sandboxId"],"type":"object"}]}},"resourceIdPath":"sandboxId","resourceKind":"boat-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"sandboxId":{"pattern":"^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$","type":"string"}},"required":["sandboxId"],"type":"object"},"retention":{"deletionNotices":[{"consequence":"disk-deleted","kind":"stopped-storage","rule":{"afterMs":1209600000,"kind":"after-stop"}}],"supportedIntents":["stop","resume","delete"]},"schemaVersion":1,"title":"Boat"}},
    'happier.machine.crabbox/crabbox': {"contribution":{"pluginId":"happier.machine.crabbox","localId":"crabbox"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options"},"billing":{"location":"cloud","stoppedBilling":"unknown"},"browserReachable":false,"credentialPurposeRequirements":[{"optionalWhen":{"all":[{"op":"eq","path":"transport","value":"direct"},{"op":"eq","path":"backendId","value":"local-container"}],"op":"and"},"purpose":"crabbox-coordinator"}],"description":{"fallback":"Development machines from a coordinator or local container.","key":"machineCrabbox.presentation.description"},"enrollmentRole":"server","icon":"hard-drives","id":"crabbox","kindTitle":{"fallback":"machine","key":"machineCrabbox.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"backendId":{"const":"aws"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"anyOf":[{"const":"linux"},{"const":"macos"}]},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"gcp"},"gcpProject":{"minLength":1,"type":"string"},"gcpZone":{"minLength":1,"type":"string"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target","gcpProject","gcpZone"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"hetzner"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"location":{"minLength":1,"type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target","location"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"local-container"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"localContainerCpus":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"localContainerMemory":{"minLength":1,"type":"string"},"localContainerRuntime":{"anyOf":[{"const":"docker"},{"const":"podman"}]},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"const":"direct"},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","nativeImageId","ttlSeconds","idleTimeoutSeconds","backendId","transport","target"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"blacksmith-testbox"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"const":"direct"},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target"],"type":"object"}]},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"backendId":{"anyOf":[{"const":"aws"},{"const":"gcp"},{"const":"hetzner"}]},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"local-container"},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"localContainerRuntime":{"anyOf":[{"const":"docker"},{"const":"podman"}]},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"blacksmith-testbox"},"leaseId":{"pattern":"^tbx_[A-Za-z0-9_-]+$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"}]}},"resourceIdPath":"leaseId","resourceKind":"crabbox-lease","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"backendId":{"anyOf":[{"const":"aws"},{"const":"gcp"},{"const":"hetzner"}]},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"local-container"},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"localContainerRuntime":{"anyOf":[{"const":"docker"},{"const":"podman"}]},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"blacksmith-testbox"},"leaseId":{"pattern":"^tbx_[A-Za-z0-9_-]+$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"}]},"retention":{"supportedIntents":["delete"]},"schemaVersion":1,"title":"Crabbox"}},
    'happier.machine.crabbox/crabbox-coordinator': {"contribution":{"pluginId":"happier.machine.crabbox","localId":"crabbox-coordinator"},"descriptor":{"actions":{"acquire":"coordinator-acquire","bootstrap":"coordinator-bootstrap","check":"coordinator-check","destroy":"coordinator-destroy","inspect":"coordinator-inspect","options":"coordinator-options"},"billing":{"location":"cloud","stoppedBilling":"unknown"},"bootstrapCredential":{"kind":"ssh"},"browserReachable":false,"credentialPurposeRequirements":[],"description":{"fallback":"Development machines from a coordinator or local container.","key":"machineCrabbox.presentation.description"},"enrollmentRole":"server","icon":"hard-drives","id":"crabbox-coordinator","kindTitle":{"fallback":"machine","key":"machineCrabbox.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"backendId":{"const":"aws"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"anyOf":[{"const":"linux"},{"const":"macos"}]},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"gcp"},"gcpProject":{"minLength":1,"type":"string"},"gcpZone":{"minLength":1,"type":"string"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target","gcpProject","gcpZone"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"hetzner"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"location":{"minLength":1,"type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target","location"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"local-container"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"localContainerCpus":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"localContainerMemory":{"minLength":1,"type":"string"},"localContainerRuntime":{"anyOf":[{"const":"docker"},{"const":"podman"}]},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"const":"direct"},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","nativeImageId","ttlSeconds","idleTimeoutSeconds","backendId","transport","target"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"blacksmith-testbox"},"idleTimeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeImageId":{"minLength":1,"type":"string"},"nativeSizeId":{"minLength":1,"type":"string"},"target":{"const":"linux"},"transport":{"const":"direct"},"ttlSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["namespace","transport","nativeImageId","nativeSizeId","ttlSeconds","idleTimeoutSeconds","backendId","target"],"type":"object"}]},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"coordinator-reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"backendId":{"anyOf":[{"const":"aws"},{"const":"gcp"},{"const":"hetzner"}]},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"local-container"},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"localContainerRuntime":{"anyOf":[{"const":"docker"},{"const":"podman"}]},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"blacksmith-testbox"},"leaseId":{"pattern":"^tbx_[A-Za-z0-9_-]+$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"}]}},"resourceIdPath":"leaseId","resourceKind":"crabbox-lease","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"backendId":{"anyOf":[{"const":"aws"},{"const":"gcp"},{"const":"hetzner"}]},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"anyOf":[{"const":"direct"},{"const":"coordinator"}]}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"local-container"},"leaseId":{"pattern":"^cbx_[0-9a-f]{12}$","type":"string"},"localContainerRuntime":{"anyOf":[{"const":"docker"},{"const":"podman"}]},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"},{"additionalProperties":false,"properties":{"backendId":{"const":"blacksmith-testbox"},"leaseId":{"pattern":"^tbx_[A-Za-z0-9_-]+$","type":"string"},"namespace":{"maxLength":63,"minLength":1,"pattern":"^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$","type":"string"},"nativeInstanceId":{"minLength":1,"type":"string"},"transport":{"const":"direct"}},"required":["namespace","transport","backendId","leaseId"],"type":"object"}]},"retention":{"supportedIntents":["delete"]},"schemaVersion":1,"title":"Crabbox coordinator"}},
    'happier.machine.cua/local-sandbox': {"contribution":{"pluginId":"happier.machine.cua","localId":"local-sandbox"},"descriptor":{"actions":{"acquire":"sandbox-acquire","bootstrap":"sandbox-bootstrap","check":"sandbox-check","destroy":"sandbox-destroy","inspect":"sandbox-inspect","options":"sandbox-options","power":"sandbox-power"},"billing":{"location":"local","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"sandbox-exec","kind":"native","putFile":"sandbox-put-file"},"description":{"fallback":"An isolated machine for coding and development.","key":"machineCua.presentation.description"},"enrollmentRole":"sandbox","icon":"desktop","id":"local-sandbox","kindTitle":{"fallback":"sandbox","key":"machineCua.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"imageId":{"minLength":1,"type":"string"},"on":{"const":"local"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"size":{"additionalProperties":false,"properties":{"cpu":{"maximum":4294967295,"minimum":1,"type":"integer"},"diskBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"memoryBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["cpu","memoryBytes","diskBytes"],"type":"object"}},"required":["on","runtimeId","imageId","size"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[{"id":"cua-cli","kind":"managedDependency"}],"reconciliation":{"action":"sandbox-reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"imageId":{"minLength":1,"type":"string"},"resource":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"sandbox"},"namespace":{"const":"local"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","namespace","runtimeId","sandboxId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"space"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"},"spaceId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","spaceId","sandboxId","runtimeId"],"type":"object"}]}},"required":["resource","imageId"],"type":"object"}},"resourceIdPath":"sandboxId","resourceKind":"cua-local-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"sandbox"},"namespace":{"const":"local"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","namespace","runtimeId","sandboxId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"space"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"},"spaceId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","spaceId","sandboxId","runtimeId"],"type":"object"}]},"retention":{"supportedIntents":["start","suspend","resume","delete"]},"schemaVersion":1,"title":"Cua"}},
    'happier.machine.cua/local-space': {"contribution":{"pluginId":"happier.machine.cua","localId":"local-space"},"descriptor":{"actions":{"acquire":"space-acquire","bootstrap":"space-bootstrap","check":"space-check","destroy":"space-destroy","inspect":"space-inspect","options":"space-options","power":"space-power"},"billing":{"location":"local","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"space-exec","kind":"native","putFile":"space-put-file"},"description":{"fallback":"A local workspace with its own machine and screen.","key":"machineCua.presentation.spaceDescription"},"enrollmentRole":"sandbox","icon":"desktop","id":"local-space","kindTitle":{"fallback":"space","key":"machineCua.presentation.spaceKind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"imageId":{"minLength":1,"type":"string"},"on":{"const":"local"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"size":{"additionalProperties":false,"properties":{"cpu":{"maximum":4294967295,"minimum":1,"type":"integer"},"diskBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"memoryBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["cpu","memoryBytes","diskBytes"],"type":"object"}},"required":["on","runtimeId","imageId","size"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[{"id":"cua-cli","kind":"managedDependency"}],"reconciliation":{"action":"space-reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"imageId":{"minLength":1,"type":"string"},"resource":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"sandbox"},"namespace":{"const":"local"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","namespace","runtimeId","sandboxId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"space"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"},"spaceId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","spaceId","sandboxId","runtimeId"],"type":"object"}]}},"required":["resource","imageId"],"type":"object"}},"resourceIdPath":"sandboxId","resourceKind":"cua-local-space","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"sandbox"},"namespace":{"const":"local"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","namespace","runtimeId","sandboxId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"space"},"runtimeId":{"anyOf":[{"const":"gvisor"},{"const":"runc"},{"const":"qemu"}]},"sandboxId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"},"spaceId":{"minLength":1,"pattern":"^local:(?!\\.)[^:\\s/\\\\\\0]+$(?![\\s\\S])","type":"string"}},"required":["kind","spaceId","sandboxId","runtimeId"],"type":"object"}]},"retention":{"supportedIntents":["start","suspend","resume","delete"]},"schemaVersion":1,"title":"Cua"}},
    'happier.machine.cua/byoc': {"contribution":{"pluginId":"happier.machine.cua","localId":"byoc"},"descriptor":{"actions":{"acquire":"byoc-acquire","bootstrap":"byoc-bootstrap","check":"byoc-check","destroy":"byoc-destroy","inspect":"byoc-inspect","options":"byoc-options","power":"byoc-power"},"billing":{"location":"cloud","stoppedBilling":"unknown"},"bootstrapTransport":{"exec":"byoc-exec","kind":"native","putFile":"byoc-put-file"},"description":{"fallback":"Machines on your own cloud account, managed by Cua.","key":"machineCua.presentation.byocDescription"},"enrollmentRole":"sandbox","icon":"server","id":"byoc","kindTitle":{"fallback":"machine","key":"machineCua.presentation.byocKind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"cloud":{"const":"aws"},"nativeImageId":{"minLength":1,"type":"string"},"nativeLifetime":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"no-native-ttl"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"durationSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"kind":{"const":"finite"}},"required":["kind","durationSeconds"],"type":"object"}]},"nativeSizeId":{"minLength":1,"type":"string"},"region":{"minLength":1,"type":"string"}},"required":["cloud","region","nativeImageId","nativeSizeId","nativeLifetime"],"type":"object"},{"additionalProperties":false,"properties":{"cloud":{"const":"gcp"},"nativeImageId":{"minLength":1,"type":"string"},"nativeLifetime":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"no-native-ttl"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"durationSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"kind":{"const":"finite"}},"required":["kind","durationSeconds"],"type":"object"}]},"nativeSizeId":{"minLength":1,"type":"string"},"region":{"minLength":1,"type":"string"}},"required":["cloud","region","nativeImageId","nativeSizeId","nativeLifetime"],"type":"object"},{"additionalProperties":false,"properties":{"cloud":{"const":"modal"},"nativeImageId":{"minLength":1,"type":"string"},"nativeLifetime":{"additionalProperties":false,"properties":{"durationSeconds":{"maximum":86400,"minimum":1,"type":"integer"},"kind":{"const":"finite"}},"required":["kind","durationSeconds"],"type":"object"},"nativeSizeId":{"minLength":1,"type":"string"},"region":{"minLength":1,"type":"string"}},"required":["cloud","region","nativeImageId","nativeSizeId","nativeLifetime"],"type":"object"}]},"platforms":["darwin","linux","win32"],"prerequisites":[{"id":"cua-cli","kind":"managedDependency"}],"reconciliation":{"action":"byoc-reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"launch":{"anyOf":[{"additionalProperties":false,"properties":{"cloud":{"const":"aws"},"nativeImageId":{"minLength":1,"type":"string"},"nativeLifetime":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"no-native-ttl"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"durationSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"kind":{"const":"finite"}},"required":["kind","durationSeconds"],"type":"object"}]},"nativeSizeId":{"minLength":1,"type":"string"},"region":{"minLength":1,"type":"string"}},"required":["cloud","region","nativeImageId","nativeSizeId","nativeLifetime"],"type":"object"},{"additionalProperties":false,"properties":{"cloud":{"const":"gcp"},"nativeImageId":{"minLength":1,"type":"string"},"nativeLifetime":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"no-native-ttl"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"durationSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"kind":{"const":"finite"}},"required":["kind","durationSeconds"],"type":"object"}]},"nativeSizeId":{"minLength":1,"type":"string"},"region":{"minLength":1,"type":"string"}},"required":["cloud","region","nativeImageId","nativeSizeId","nativeLifetime"],"type":"object"},{"additionalProperties":false,"properties":{"cloud":{"const":"modal"},"nativeImageId":{"minLength":1,"type":"string"},"nativeLifetime":{"additionalProperties":false,"properties":{"durationSeconds":{"maximum":86400,"minimum":1,"type":"integer"},"kind":{"const":"finite"}},"required":["kind","durationSeconds"],"type":"object"},"nativeSizeId":{"minLength":1,"type":"string"},"region":{"minLength":1,"type":"string"}},"required":["cloud","region","nativeImageId","nativeSizeId","nativeLifetime"],"type":"object"}]},"sandboxId":{"minLength":1,"type":"string"}},"required":["launch","sandboxId"],"type":"object"}},"resourceKind":"cua-byoc-resource","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"cloud":{"anyOf":[{"const":"aws"},{"const":"gcp"},{"const":"modal"}]},"nativeResourceId":{"minLength":1,"type":"string"},"ownedAttachmentIds":{"items":{"minLength":1,"type":"string"},"type":"array"},"sandboxId":{"minLength":1,"type":"string"},"spaceId":{"minLength":1,"type":"string"}},"required":["cloud","nativeResourceId","sandboxId","ownedAttachmentIds"],"type":"object"},"retention":{"supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"Cua BYOC"}},
    'happier.machine.daytona/daytona': {"contribution":{"pluginId":"happier.machine.daytona","localId":"daytona"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":true,"description":"Run Happier in a retained Daytona Cloud sandbox.","enrollmentRole":"sandbox","icon":"cloud","id":"daytona","kindTitle":"Sandbox","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"snapshot":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["snapshot"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","cleanup":"observe-cleanup","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"acquire"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","name","managedId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"delete"},"resource":{"additionalProperties":false,"properties":{"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"organizationId":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"},"toolboxProxyUrl":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["sandboxId","name","managedId","organizationId","toolboxProxyUrl"],"type":"object"}},"required":["kind","resource"],"type":"object"}]}},"resourceIdPath":"sandboxId","resourceKind":"daytona-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"organizationId":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"},"toolboxProxyUrl":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["sandboxId","name","managedId","organizationId","toolboxProxyUrl"],"type":"object"},"retention":{"supportedIntents":["start","stop","resume","delete"]},"schemaVersion":1,"title":"Daytona"}},
    'happier.machine.digitalocean/digitalocean': {"contribution":{"pluginId":"happier.machine.digitalocean","localId":"digitalocean"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"billed"},"browserReachable":false,"description":{"fallback":"A cloud machine with your chosen size, image and region.","key":"machineDigitalOcean.presentation.description"},"enrollmentRole":"server","icon":"hard-drives","id":"digitalocean","kindTitle":{"fallback":"Machine","key":"machineDigitalOcean.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"imageId":{"anyOf":[{"maximum":9007199254740991,"minimum":1,"type":"integer"},{"minLength":1,"pattern":"\\S","type":"string"}]},"publicNetworking":{"additionalProperties":false,"properties":{"ipv6":{"anyOf":[{"const":true},{"const":false}]}},"required":["ipv6"],"type":"object"},"regionSlug":{"minLength":1,"pattern":"\\S","type":"string"},"sizeSlug":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["regionSlug","sizeSlug","imageId","publicNetworking"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"recoveryTag":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["recoveryTag"],"type":"object"},{"additionalProperties":false,"properties":{"dropletId":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"ownedVolumeIds":{"items":{"minLength":1,"pattern":"\\S","type":"string"},"type":"array"}},"required":["dropletId","ownedVolumeIds"],"type":"object"}]}},"resourceIdPath":"dropletId","resourceKind":"digitalocean-droplet","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"dropletId":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"ownedVolumeIds":{"items":{"minLength":1,"pattern":"\\S","type":"string"},"type":"array"}},"required":["dropletId","ownedVolumeIds"],"type":"object"},"retention":{"guestLocalStop":"poweroff","supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"DigitalOcean"}},
    'happier.machine.docker-sandboxes/docker-sandboxes': {"contribution":{"pluginId":"happier.machine.docker-sandboxes","localId":"docker-sandboxes"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"local","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"description":{"fallback":"An isolated machine for coding and development.","key":"machineDocker.presentation.description"},"enrollmentRole":"sandbox","icon":"cube","id":"docker-sandboxes","kindTitle":{"fallback":"sandbox","key":"machineDocker.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"name":{"pattern":"^(?!default$)[A-Za-z0-9][A-Za-z0-9.-]+$","type":"string"},"templateId":{"minLength":1,"type":"string"}},"required":["templateId","name"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[{"id":"docker-sandboxes-cli","kind":"managedDependency"}],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"sandboxName":{"pattern":"^(?!default$)[A-Za-z0-9][A-Za-z0-9.-]+$","type":"string"}},"required":["sandboxName"],"type":"object"}},"resourceIdPath":"sandboxName","resourceKind":"docker-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"sandboxName":{"pattern":"^(?!default$)[A-Za-z0-9][A-Za-z0-9.-]+$","type":"string"}},"required":["sandboxName"],"type":"object"},"retention":{"supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"Docker Sandboxes"}},
    'happier.machine.e2b/e2b': {"contribution":{"pluginId":"happier.machine.e2b","localId":"e2b"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":"A Linux sandbox on E2B, connected as an ordinary Happier Machine.","enrollmentRole":"sandbox","icon":"cloud","id":"e2b","kindTitle":"Sandbox","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"templateId":{"minLength":1,"pattern":"\\S","type":"string"},"timeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["templateId","timeoutSeconds"],"type":"object"},"nativeDurationInput":{"path":"timeoutSeconds","unit":"seconds"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"kind":{"const":"acquire"},"launch":{"additionalProperties":false,"properties":{"templateId":{"minLength":1,"pattern":"\\S","type":"string"},"timeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["templateId","timeoutSeconds"],"type":"object"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","managedId","launch"],"type":"object"}},"resourceIdPath":"sandboxId","resourceKind":"e2b-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"},"timeoutSeconds":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["sandboxId","managedId","timeoutSeconds"],"type":"object"},"retention":{"supportedIntents":["suspend","resume","delete"]},"schemaVersion":1,"title":"E2B"}},
    'happier.machine.fly/fly': {"contribution":{"pluginId":"happier.machine.fly","localId":"fly"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed","storageCharges":[{"amount":"0.15","currency":"USD","label":{"fallback":"Stopped root disk","key":"machineFly.presentation.rootFilesystem"},"observedAt":1793059200000,"source":"https://docs.fly.io/about/pricing","unit":"GB-month"},{"amount":"0.15","currency":"USD","label":{"fallback":"Volume","key":"machineFly.presentation.volumeStorage"},"observedAt":1793059200000,"source":"https://docs.fly.io/about/pricing","unit":"GB-month"},{"amount":"0.08","currency":"USD","label":{"fallback":"Snapshots over allowance","key":"machineFly.presentation.snapshotStorage"},"observedAt":1793059200000,"source":"https://docs.fly.io/about/pricing","unit":"GB-month"}]},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":{"fallback":"Machines with a persistent volume. Compute and retained storage are billed separately.","key":"machineFly.presentation.description"},"enrollmentRole":"sandbox","icon":"hard-drives","id":"fly","kindTitle":{"fallback":"VM","key":"machineFly.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"app":{"anyOf":[{"additionalProperties":false,"properties":{"name":{"minLength":1,"pattern":"\\S","type":"string"},"organizationSlug":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"const":"created"}},"required":["name","ownership","organizationSlug"],"type":"object"},{"additionalProperties":false,"properties":{"name":{"minLength":1,"pattern":"\\S","type":"string"},"organizationSlug":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"const":"existing"}},"required":["name","ownership"],"type":"object"}]},"guest":{"additionalProperties":false,"properties":{"cpuKind":{"anyOf":[{"const":"shared"},{"const":"performance"}]},"cpus":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"memoryMb":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["cpuKind","cpus","memoryMb"],"type":"object"},"imageReference":{"minLength":1,"pattern":"\\S","type":"string"},"region":{"minLength":1,"pattern":"\\S","type":"string"},"volume":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"create"},"sizeGb":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["kind","sizeGb"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"attach"},"volumeId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","volumeId"],"type":"object"}]}},"required":["app","region","guest","volume"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","cleanup":"observe-cleanup","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"launch":{"additionalProperties":false,"properties":{"app":{"anyOf":[{"additionalProperties":false,"properties":{"name":{"minLength":1,"pattern":"\\S","type":"string"},"organizationSlug":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"const":"created"}},"required":["name","ownership","organizationSlug"],"type":"object"},{"additionalProperties":false,"properties":{"name":{"minLength":1,"pattern":"\\S","type":"string"},"organizationSlug":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"const":"existing"}},"required":["name","ownership"],"type":"object"}]},"guest":{"additionalProperties":false,"properties":{"cpuKind":{"anyOf":[{"const":"shared"},{"const":"performance"}]},"cpus":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"memoryMb":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["cpuKind","cpus","memoryMb"],"type":"object"},"imageReference":{"minLength":1,"pattern":"\\S","type":"string"},"region":{"minLength":1,"pattern":"\\S","type":"string"},"volume":{"anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"create"},"sizeGb":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["kind","sizeGb"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"attach"},"volumeId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","volumeId"],"type":"object"}]}},"required":["app","region","guest","volume"],"type":"object"},"operation":{"additionalProperties":false,"properties":{"app":{"additionalProperties":false,"properties":{"id":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"anyOf":[{"const":"created"},{"const":"existing"},{"const":"unknown"}]}},"required":["name","ownership"],"type":"object"},"phase":{"anyOf":[{"const":"app"},{"const":"volume"},{"const":"machine"}]},"requestId":{"minLength":1,"pattern":"\\S","type":"string"},"volume":{"additionalProperties":false,"properties":{"id":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"anyOf":[{"const":"created"},{"const":"attached"}]}},"required":["id","ownership"],"type":"object"}},"required":["app","requestId","phase"],"type":"object"}},"required":["operation","launch"],"type":"object"},{"additionalProperties":false,"properties":{"app":{"additionalProperties":false,"properties":{"id":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"anyOf":[{"const":"created"},{"const":"existing"}]}},"required":["name","ownership"],"type":"object"},"machineId":{"minLength":1,"pattern":"\\S","type":"string"},"volume":{"additionalProperties":false,"properties":{"id":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"anyOf":[{"const":"created"},{"const":"attached"}]}},"required":["id","ownership"],"type":"object"}},"required":["app","machineId","volume"],"type":"object"}]}},"resourceIdPath":"machineId","resourceKind":"fly-machine","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"app":{"additionalProperties":false,"properties":{"id":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"anyOf":[{"const":"created"},{"const":"existing"}]}},"required":["name","ownership"],"type":"object"},"machineId":{"minLength":1,"pattern":"\\S","type":"string"},"volume":{"additionalProperties":false,"properties":{"id":{"minLength":1,"pattern":"\\S","type":"string"},"ownership":{"anyOf":[{"const":"created"},{"const":"attached"}]}},"required":["id","ownership"],"type":"object"}},"required":["app","machineId","volume"],"type":"object"},"retention":{"supportedIntents":["start","stop","resume","suspend","delete"]},"schemaVersion":1,"title":"Fly Machines"}},
    'happier.machine.freestyle/freestyle': {"contribution":{"pluginId":"happier.machine.freestyle","localId":"freestyle"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed","storageCharges":[{"amount":"0.000086","currency":"USD","label":"Retained storage while paused","observedAt":1793836800000,"source":"https://www.freestyle.sh/docs/vms/pricing-and-limits","unit":"GiB-hour"}]},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":"Run Happier in a retained Freestyle VM.","enrollmentRole":"sandbox","icon":"cloud","id":"freestyle","kindTitle":"VM","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"snapshotId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["snapshotId"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"kind":{"const":"acquire"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","name","managedId"],"type":"object"}},"resourceIdPath":"vmId","resourceKind":"freestyle-vm","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"vmId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["vmId","name","managedId"],"type":"object"},"retention":{"supportedIntents":["start","suspend","resume","delete"]},"schemaVersion":1,"title":"Freestyle"}},
    'happier.machine.hetzner/hetzner': {"contribution":{"pluginId":"happier.machine.hetzner","localId":"hetzner"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"billed"},"browserReachable":false,"description":{"fallback":"A cloud machine with a persistent disk.","key":"machineHetzner.presentation.description"},"enrollmentRole":"server","icon":"hard-drives","id":"hetzner","kindTitle":{"fallback":"VM","key":"machineHetzner.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"imageId":{"minLength":1,"pattern":"\\S","type":"string"},"locationId":{"minLength":1,"pattern":"\\S","type":"string"},"publicNetworking":{"additionalProperties":false,"properties":{"ipv4":{"anyOf":[{"const":true},{"const":false}]},"ipv6":{"anyOf":[{"const":true},{"const":false}]}},"required":["ipv4","ipv6"],"type":"object"},"serverTypeId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["serverTypeId","imageId","locationId","publicNetworking"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"correlation":{"maxLength":63,"minLength":1,"pattern":"^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$","type":"string"}},"required":["correlation"],"type":"object"},{"additionalProperties":false,"properties":{"deleteActionId":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"owned":{"additionalProperties":false,"properties":{"primaryIpIds":{"items":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"type":"array"},"volumeIds":{"items":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"type":"array"}},"required":["volumeIds","primaryIpIds"],"type":"object"},"serverId":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["serverId","owned"],"type":"object"}]}},"resourceIdPath":"serverId","resourceKind":"hetzner-server","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"owned":{"additionalProperties":false,"properties":{"primaryIpIds":{"items":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"type":"array"},"volumeIds":{"items":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"type":"array"}},"required":["volumeIds","primaryIpIds"],"type":"object"},"serverId":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["serverId","owned"],"type":"object"},"retention":{"guestLocalStop":"poweroff","supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"Hetzner"}},
    'happier.machine.lima/lima': {"contribution":{"pluginId":"happier.machine.lima","localId":"lima"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"local","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"description":{"fallback":"A lightweight Linux machine for code, scripts and dev servers.","key":"machineLima.presentation.description"},"enrollmentRole":"server","icon":"terminal","id":"lima","kindTitle":{"fallback":"Machine","key":"machineLima.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"arch":{"anyOf":[{"const":"aarch64"},{"const":"x86_64"}]},"cpus":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"diskGiB":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"image":{"minLength":1,"type":"string"},"memoryGiB":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"mounts":{"items":{"additionalProperties":false,"properties":{"location":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"mountPoint":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"writable":{"anyOf":[{"const":true},{"const":false}]}},"required":["location","mountPoint","writable"],"type":"object"},"type":"array"},"store":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"vmType":{"anyOf":[{"const":"vz"},{"const":"qemu"}]}},"required":["store","image","arch","vmType","cpus","memoryGiB","diskGiB","mounts"],"type":"object"},"platforms":["darwin","linux"],"prerequisites":[{"id":"lima-cli","kind":"managedDependency"}],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"arch":{"anyOf":[{"const":"aarch64"},{"const":"x86_64"}]},"cpus":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"diskBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"image":{"minLength":1,"type":"string"},"instance":{"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$","type":"string"},"memoryBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"mounts":{"items":{"additionalProperties":false,"properties":{"location":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"mountPoint":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"writable":{"anyOf":[{"const":true},{"const":false}]}},"required":["location","mountPoint","writable"],"type":"object"},"type":"array"},"store":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"vmType":{"anyOf":[{"const":"vz"},{"const":"qemu"}]}},"required":["instance","store","arch","vmType","cpus","memoryBytes","diskBytes","image","mounts"],"type":"object"}},"resourceIdPath":"instance","resourceKind":"lima-vm","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"arch":{"anyOf":[{"const":"aarch64"},{"const":"x86_64"}]},"cpus":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"diskBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"image":{"minLength":1,"type":"string"},"instance":{"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$","type":"string"},"memoryBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"mounts":{"items":{"additionalProperties":false,"properties":{"location":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"mountPoint":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"writable":{"anyOf":[{"const":true},{"const":false}]}},"required":["location","mountPoint","writable"],"type":"object"},"type":"array"},"store":{"pattern":"^/[^\\u0000\\r\\n]*$","type":"string"},"vmType":{"anyOf":[{"const":"vz"},{"const":"qemu"}]}},"required":["instance","store","arch","vmType","cpus","memoryBytes","diskBytes","image","mounts"],"type":"object"},"retention":{"supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"Lima"}},
    'happier.machine.lume/lume': {"contribution":{"pluginId":"happier.machine.lume","localId":"lume"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"local","stoppedBilling":"not-billed"},"description":{"fallback":"A local macOS or Linux machine with your chosen image.","key":"machineLume.presentation.description"},"enrollmentRole":"personal","icon":"desktop","id":"lume","kindTitle":{"fallback":"Machine","key":"machineLume.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"cpu":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"diskBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"image":{"anyOf":[{"additionalProperties":false,"properties":{"id":{"pattern":"^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*|@sha256:[a-f0-9]{64})(?![\\s\\S])","type":"string"},"kind":{"const":"catalog"}},"required":["kind","id"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"native-image"},"privateCarrier":{"additionalProperties":false,"properties":{"guestOs":{"anyOf":[{"const":"linux"},{"const":"macos"}]},"kind":{"const":"lume-default-password"},"user":{"minLength":1,"pattern":"^[^\\s\\u0000]+(?![\\s\\S])","type":"string"}},"required":["kind","guestOs","user"],"type":"object"},"reference":{"pattern":"^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*|@sha256:[a-f0-9]{64})(?![\\s\\S])","type":"string"}},"required":["kind","reference"],"type":"object"}]},"keepPasswordLogin":{"anyOf":[{"const":false},{"const":true}]},"memoryBytes":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"storage":{"minLength":1,"pattern":"^[^\\u0000]*$","type":"string"}},"required":["image","storage","cpu","memoryBytes","diskBytes"],"type":"object"},"platforms":["darwin"],"prerequisites":[{"id":"lume-cli","kind":"managedDependency"},{"id":"ssh-keyscan","kind":"systemTool"},{"id":"ssh","kind":"systemTool"}],"reconciliation":{"action":"reconcile","continueAcquire":true,"nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"keepPasswordLogin":{"anyOf":[{"const":false},{"const":true}]},"privateCarrier":{"additionalProperties":false,"properties":{"guestOs":{"anyOf":[{"const":"linux"},{"const":"macos"}]},"kind":{"const":"lume-default-password"},"user":{"minLength":1,"pattern":"^[^\\s\\u0000]+(?![\\s\\S])","type":"string"}},"required":["kind","guestOs","user"],"type":"object"},"storage":{"minLength":1,"pattern":"^[^\\u0000]*$","type":"string"},"vmName":{"pattern":"^happier-[^\\\\/:\\u0000]+(?![\\s\\S])","type":"string"}},"required":["storage","vmName"],"type":"object"}},"resourceIdPath":"vmName","resourceKind":"lume-vm","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"keepPasswordLogin":{"anyOf":[{"const":false},{"const":true}]},"privateCarrier":{"additionalProperties":false,"properties":{"guestOs":{"anyOf":[{"const":"linux"},{"const":"macos"}]},"kind":{"const":"lume-default-password"},"user":{"minLength":1,"pattern":"^[^\\s\\u0000]+(?![\\s\\S])","type":"string"}},"required":["kind","guestOs","user"],"type":"object"},"storage":{"minLength":1,"pattern":"^[^\\u0000]*$","type":"string"},"vmName":{"minLength":1,"pattern":"^(?!\\.{1,2}(?![\\s\\S]))[^\\\\/:\\u0000]+$","type":"string"}},"required":["storage","vmName"],"type":"object"},"retention":{"supportedIntents":["start","stop","delete"]},"schemaVersion":1,"title":"Lume"}},
    'happier.machine.maritime/maritime': {"contribution":{"pluginId":"happier.machine.maritime","localId":"maritime"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"unknown"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":"A persistent Linux machine. Idle machines may sleep; Happier resumes them before work.","enrollmentRole":"server","icon":"cloud","id":"maritime","kindTitle":"Machine","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"alwaysOn":{"anyOf":[{"const":true},{"const":false}]},"diskGb":{"maximum":100,"minimum":1,"type":"integer"},"kind":{"anyOf":[{"const":"agent-box"},{"const":"linux-computer"}]},"memMb":{"maximum":8192,"minimum":512,"type":"integer"},"templateId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","memMb","diskGb","alwaysOn","templateId"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"kind":{"const":"acquire"},"launch":{"additionalProperties":false,"properties":{"alwaysOn":{"anyOf":[{"const":true},{"const":false}]},"diskGb":{"maximum":100,"minimum":1,"type":"integer"},"kind":{"anyOf":[{"const":"agent-box"},{"const":"linux-computer"}]},"memMb":{"maximum":8192,"minimum":512,"type":"integer"},"templateId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","memMb","diskGb","alwaysOn","templateId"],"type":"object"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","managedId","launch"],"type":"object"}},"resourceIdPath":"machineId","resourceKind":"maritime-machine","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"alwaysOn":{"anyOf":[{"const":true},{"const":false}]},"kind":{"anyOf":[{"const":"agent-box"},{"const":"linux-computer"}]},"machineId":{"minLength":1,"pattern":"\\S","type":"string"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["machineId","managedId","kind"],"type":"object"},"retention":{"supportedIntents":["start","stop","suspend","resume","delete"]},"schemaVersion":1,"title":"Maritime"}},
    'happier.machine.modal/modal': {"contribution":{"pluginId":"happier.machine.modal","localId":"modal"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options"},"billing":{"location":"cloud","stoppedBilling":"not-billed"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"description":{"fallback":"On-demand cloud sandboxes with a native lifetime.","key":"machineModal.presentation.description"},"enrollmentRole":"sandbox","icon":"cloud","id":"modal","kindTitle":{"fallback":"sandbox","key":"machineModal.presentation.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"appReference":{"minLength":1,"pattern":"\\S","type":"string"},"imageReference":{"minLength":1,"pattern":"\\S","type":"string"},"resources":{"additionalProperties":false,"properties":{"cpu":{"minimum":0.001,"type":"number"},"memoryMb":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["cpu","memoryMb"],"type":"object"},"timeoutMs":{"maximum":86400000,"minimum":1000,"multipleOf":1000,"type":"integer"}},"required":["imageReference","appReference","resources","timeoutMs"],"type":"object"},"nativeDurationInput":{"path":"timeoutMs","unit":"milliseconds"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"appReference":{"minLength":1,"pattern":"\\S","type":"string"},"managedId":{"minLength":1,"pattern":"^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])","type":"string"}},"required":["appReference","managedId"],"type":"object"}},"resourceIdPath":"sandboxId","resourceKind":"modal-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"appId":{"minLength":1,"pattern":"^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])","type":"string"},"sandboxId":{"minLength":1,"pattern":"^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])","type":"string"}},"required":["sandboxId","appId"],"type":"object"},"retention":{"finiteOnly":true,"supportedIntents":["delete"]},"schemaVersion":1,"title":"Modal"}},
    'happier.machine.railway/railway': {"contribution":{"pluginId":"happier.machine.railway","localId":"railway"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"unknown"},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":"Run Happier in a Railway sandbox until you delete it.","enrollmentRole":"sandbox","icon":"cloud","id":"railway","kindTitle":"Sandbox","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"environmentId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["environmentId"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","cleanup":"observe-cleanup","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"environmentId":{"minLength":1,"pattern":"\\S","type":"string"},"kind":{"const":"acquire"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","environmentId","managedId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"delete"},"resource":{"additionalProperties":false,"properties":{"environmentId":{"minLength":1,"pattern":"\\S","type":"string"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["sandboxId","environmentId","managedId"],"type":"object"}},"required":["kind","resource"],"type":"object"}]}},"resourceIdPath":"sandboxId","resourceKind":"railway-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"environmentId":{"minLength":1,"pattern":"\\S","type":"string"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["sandboxId","environmentId","managedId"],"type":"object"},"retention":{"supportedIntents":["delete"]},"schemaVersion":1,"title":"Railway"}},
    'happier.machine.superserve/superserve': {"contribution":{"pluginId":"happier.machine.superserve","localId":"superserve"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed","storageCharges":[{"amount":"0.000108","currency":"USD","label":"Retained shared template and sandbox changes","observedAt":1793836800000,"source":"https://www.superserve.ai/pricing/","unit":"GiB-hour"}]},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":false,"description":"Run Happier in a retained Superserve Cloud sandbox.","enrollmentRole":"sandbox","icon":"cloud","id":"superserve","kindTitle":"Sandbox","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"template":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["template"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"kind":{"const":"acquire"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","name","managedId"],"type":"object"}},"resourceIdPath":"sandboxId","resourceKind":"superserve-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"},"sandboxId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["sandboxId","name","managedId"],"type":"object"},"retention":{"supportedIntents":["suspend","resume","delete"]},"schemaVersion":1,"title":"Superserve"}},
    'happier.machine.upstash-box/upstash-box': {"contribution":{"pluginId":"happier.machine.upstash-box","localId":"upstash-box"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed","storageCharges":[{"amount":"0.10","currency":"USD","label":"Retained storage, including snapshots","observedAt":1793836800000,"source":"https://upstash.com/pricing/box","unit":"GB-month"}]},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":true,"description":"Run Happier in a retained Upstash Box Cloud sandbox.","enrollmentRole":"sandbox","icon":"cloud","id":"upstash-box","kindTitle":"Sandbox","launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"runtime":{"const":"node"},"size":{"anyOf":[{"const":"small"},{"const":"medium"},{"const":"large"}]}},"required":["runtime","size"],"type":"object"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","cleanup":"observe-cleanup","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"kind":{"const":"acquire"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","name","managedId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"delete"},"resource":{"additionalProperties":false,"properties":{"boxId":{"minLength":1,"pattern":"\\S","type":"string"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["boxId","name","managedId"],"type":"object"}},"required":["kind","resource"],"type":"object"}]}},"resourceIdPath":"boxId","resourceKind":"upstash-box-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"boxId":{"minLength":1,"pattern":"\\S","type":"string"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["boxId","name","managedId"],"type":"object"},"retention":{"supportedIntents":["start","stop","resume","delete"]},"schemaVersion":1,"title":"Upstash Box"}},
    'happier.machine.vercel/vercel': {"contribution":{"pluginId":"happier.machine.vercel","localId":"vercel"},"descriptor":{"actions":{"acquire":"acquire","bootstrap":"bootstrap","check":"check","destroy":"destroy","inspect":"inspect","options":"options","power":"power"},"billing":{"location":"cloud","stoppedBilling":"not-billed","storageCharges":[{"amount":"0.08","currency":"USD","label":{"fallback":"Snapshot storage (Pro / Enterprise)","key":"machineVercel.snapshotStorage"},"observedAt":1793059200000,"source":"https://vercel.com/docs/sandbox/pricing","unit":"GB-month"}]},"bootstrapTransport":{"exec":"exec","kind":"native","putFile":"put-file"},"browserReachable":true,"description":{"fallback":"Sandboxes that keep their files between runs.","key":"machineVercel.description"},"enrollmentRole":"sandbox","icon":"cloud","id":"vercel","kindTitle":{"fallback":"sandbox","key":"machineVercel.kind"},"launchSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"image":{"maxLength":255,"minLength":1,"pattern":"\\S","type":"string"},"region":{"anyOf":[{"const":"iad1"},{"const":"sfo1"},{"const":"cle1"},{"const":"cdg1"},{"const":"fra1"},{"const":"arn1"},{"const":"sin1"},{"const":"pdx1"},{"const":"lhr1"},{"const":"icn1"},{"const":"bom1"},{"const":"cpt1"},{"const":"dub1"},{"const":"gru1"},{"const":"hkg1"},{"const":"syd1"},{"const":"yul1"},{"const":"hnd1"},{"const":"kix1"}]},"snapshotExpirationMs":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"timeoutMs":{"maximum":86400000,"minimum":1000,"type":"integer"},"vcpus":{"anyOf":[{"const":1},{"maximum":32,"minimum":2,"multipleOf":2,"type":"integer"}]}},"required":["image","region","vcpus","timeoutMs","snapshotExpirationMs"],"type":"object"},"nativeCredentialDelivery":{"apply":"native-credential-apply","perBindingMatching":true,"preservesEndpoint":true,"transports":["https_headers"]},"nativeDurationInput":{"path":"timeoutMs","unit":"milliseconds"},"platforms":["darwin","linux","win32"],"prerequisites":[],"reconciliation":{"action":"reconcile","cleanup":"observe-cleanup","nativeOperationSchema":{"$schema":"http://json-schema.org/draft-07/schema#","anyOf":[{"additionalProperties":false,"properties":{"createdAt":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"kind":{"const":"acquire"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"maxLength":128,"minLength":1,"pattern":"^[a-zA-Z0-9_-]+$","type":"string"},"projectId":{"minLength":1,"pattern":"\\S","type":"string"},"teamId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["kind","name","managedId","teamId","projectId"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"delete"},"phase":{"anyOf":[{"const":"stop"},{"const":"delete"}]},"resource":{"additionalProperties":false,"properties":{"createdAt":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"maxLength":128,"minLength":1,"pattern":"^[a-zA-Z0-9_-]+$","type":"string"},"projectId":{"minLength":1,"pattern":"\\S","type":"string"},"teamId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["name","createdAt","managedId","teamId","projectId"],"type":"object"},"snapshotIds":{"items":{"minLength":1,"pattern":"\\S","type":"string"},"type":"array"}},"required":["kind","resource","phase","snapshotIds"],"type":"object"}]}},"resourceIdPath":"name","resourceKind":"vercel-sandbox","resourceSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"createdAt":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"managedId":{"minLength":1,"pattern":"\\S","type":"string"},"name":{"maxLength":128,"minLength":1,"pattern":"^[a-zA-Z0-9_-]+$","type":"string"},"projectId":{"minLength":1,"pattern":"\\S","type":"string"},"teamId":{"minLength":1,"pattern":"\\S","type":"string"}},"required":["name","createdAt","managedId","teamId","projectId"],"type":"object"},"retention":{"supportedIntents":["start","stop","resume","delete"]},"schemaVersion":1,"title":"Vercel"}},
});
