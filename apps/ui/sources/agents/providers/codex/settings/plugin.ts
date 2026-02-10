import * as z from 'zod';

import { buildCodexProviderSettingsShape, CODEX_PROVIDER_SETTINGS_DEFAULTS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';

const shape = buildCodexProviderSettingsShape(z);
const defaults: Record<keyof typeof shape, unknown> = CODEX_PROVIDER_SETTINGS_DEFAULTS;

export const CODEX_PROVIDER_SETTINGS_PLUGIN = {
    providerId: 'codex',
    title: 'Codex',
    icon: { ionName: 'terminal-outline', color: '#007AFF' },
    settingsShape: shape,
    settingsDefaults: defaults,
    uiSections: [
        {
            id: 'codexMode',
            title: 'Backend mode',
            footer: 'Choose how Codex is routed. ACP and MCP resume require additional installs on your machine.',
            fields: [
                {
                    key: 'codexBackendMode',
                    kind: 'enum',
                    title: 'Codex backend mode',
                    subtitle: 'Select MCP, MCP + resume, or ACP.',
                    enumOptions: [
                        {
                            id: 'mcp',
                            title: 'MCP',
                            subtitle: 'Default Codex MCP mode',
                        },
                        {
                            id: 'mcp_resume',
                            title: 'MCP + resume',
                            subtitle: 'Enable Codex resume MCP dependency for vendor resume flows',
                        },
                        {
                            id: 'acp',
                            title: 'ACP',
                            subtitle: 'Route Codex through ACP (codex-acp)',
                        },
                    ],
                },
            ],
        },
        {
            id: 'codexInstallSpecs',
            title: 'Install source overrides',
            footer: 'Optional. Leave empty to use default install sources.',
            fields: [
                {
                    key: 'codexMcpResumeInstallSpec',
                    kind: 'text',
                    title: 'Codex MCP resume install source',
                    subtitle: 'npm package, git URL, or local file path',
                },
                {
                    key: 'codexAcpInstallSpec',
                    kind: 'text',
                    title: 'Codex ACP install source',
                    subtitle: 'npm package, git URL, or local file path',
                },
            ],
        },
    ],
    buildOutgoingMessageMetaExtras: () => ({}),
} as const satisfies ProviderSettingsPlugin;
