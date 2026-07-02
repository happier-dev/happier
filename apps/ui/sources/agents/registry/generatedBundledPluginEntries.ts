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
import { PROVIDER_LOGO_SVG_XML } from './providerLogoSvgXml';

import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
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
    uiConnectedService: { serviceId: 'anthropic', label: 'Claude Code', connectRoute: '/(app)/settings/connect/claude' },
    flavorAliases: ['claude'],
    cli: buildCatalogProviderCliUiConfig('claude'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.claude ?? null,
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
    uiConnectedService: { serviceId: 'openai', label: 'OpenAI Codex', connectRoute: null },
    flavorAliases: ['codex', 'openai', 'gpt'],
    cli: buildCatalogProviderCliUiConfig('codex'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.codex ?? null,
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
    uiConnectedService: { serviceId: null, label: 'Cursor', connectRoute: null },
    flavorAliases: ['cursor', 'cursor-agent'],
    cli: buildCatalogProviderCliUiConfig('cursor'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.cursor ?? null,
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
    uiConnectedService: { serviceId: null, label: 'OpenCode', connectRoute: null },
    flavorAliases: ['opencode', 'open-code'],
    cli: buildCatalogProviderCliUiConfig('opencode'),
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

const GEMINI_CORE: AgentCoreConfig = {
    id: 'gemini',
    displayNameKey: 'agentInput.agent.gemini',
    subtitleKey: 'profiles.aiBackend.geminiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.geminiPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'gemini' }),
    uiConnectedService: { serviceId: 'gemini', label: 'Google Gemini', connectRoute: null },
    flavorAliases: ['gemini'],
    cli: buildCatalogProviderCliUiConfig('gemini'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.gemini ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: '✦︎',
};

const AUGGIE_CORE: AgentCoreConfig = {
    id: 'auggie',
    displayNameKey: 'agentInput.agent.auggie',
    subtitleKey: 'profiles.aiBackend.auggieSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'auggie' }),
    uiConnectedService: { serviceId: null, label: 'Auggie', connectRoute: null },
    flavorAliases: ['auggie'],
    cli: buildCatalogProviderCliUiConfig('auggie'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.auggie ?? null,
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
    uiConnectedService: { serviceId: null, label: 'Qwen', connectRoute: null },
    flavorAliases: ['qwen', 'qwen-code'],
    cli: buildCatalogProviderCliUiConfig('qwen'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.qwen ?? null,
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
    uiConnectedService: { serviceId: null, label: 'Kimi', connectRoute: null },
    flavorAliases: ['kimi', 'kimi-cli'],
    cli: buildCatalogProviderCliUiConfig('kimi'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.kimi ?? null,
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
    uiConnectedService: { serviceId: null, label: 'Kilo', connectRoute: null },
    flavorAliases: ['kilo', 'kilocode'],
    cli: buildCatalogProviderCliUiConfig('kilo'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.kilo ?? null,
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
    uiConnectedService: { serviceId: null, label: 'Kiro', connectRoute: null },
    flavorAliases: ['kiro', 'kiro-cli'],
    cli: buildCatalogProviderCliUiConfig('kiro'),
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
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};

const KIRO_UI: AgentUiConfig = {
    id: 'kiro',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.kiro ?? null,
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
    uiConnectedService: { serviceId: null, label: 'Pi', connectRoute: null },
    flavorAliases: ['pi', 'pi-coding-agent'],
    cli: buildCatalogProviderCliUiConfig('pi'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.pi ?? null,
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
    uiConnectedService: { serviceId: null, label: 'oh-my-pi', connectRoute: null },
    flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
    cli: buildCatalogProviderCliUiConfig('ohMyPi'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.ohMyPi ?? null,
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
    uiConnectedService: { serviceId: null, label: 'GitHub Copilot', connectRoute: null },
    flavorAliases: ['copilot', 'github-copilot', 'copilot-cli'],
    cli: buildCatalogProviderCliUiConfig('copilot'),
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
    svgIconXml: PROVIDER_LOGO_SVG_XML.copilot ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'CP',
};

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-pi",
  "@happier-dev/plugins-qwen",
  "@happier-dev/plugins-review-coderabbit",
  "@happier-dev/plugins-review-deepsec",
  "@happier-dev/plugins-scm-azure-devops",
  "@happier-dev/plugins-scm-bitbucket",
  "@happier-dev/plugins-scm-git",
  "@happier-dev/plugins-scm-github",
  "@happier-dev/plugins-scm-gitlab",
  "@happier-dev/plugins-scm-sapling",
]);

export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCoreConfig>> = Object.freeze({
    claude: CLAUDE_CORE,
    codex: CODEX_CORE,
    cursor: CURSOR_CORE,
    opencode: OPENCODE_CORE,
    gemini: GEMINI_CORE,
    auggie: AUGGIE_CORE,
    qwen: QWEN_CORE,
    kimi: KIMI_CORE,
    kilo: KILO_CORE,
    kiro: KIRO_CORE,
    pi: PI_CORE,
    ohMyPi: OH_MY_PI_CORE,
    copilot: COPILOT_CORE,
} satisfies Readonly<Record<CanonicalAgentId, AgentCoreConfig>>);

export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Record<CanonicalAgentId, AgentUiConfig>> = Object.freeze({
    claude: CLAUDE_UI,
    codex: CODEX_UI,
    cursor: CURSOR_UI,
    opencode: OPENCODE_UI,
    gemini: GEMINI_UI,
    auggie: AUGGIE_UI,
    qwen: QWEN_UI,
    kimi: KIMI_UI,
    kilo: KILO_UI,
    kiro: KIRO_UI,
    pi: PI_UI,
    ohMyPi: OH_MY_PI_UI,
    copilot: COPILOT_UI,
} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);
