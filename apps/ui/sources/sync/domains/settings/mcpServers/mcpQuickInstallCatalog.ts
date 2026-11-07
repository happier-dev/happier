import type { McpServersSettingsV1 } from '@happier-dev/protocol';

import { normalizeMcpServerNameCandidate } from './mcpCatalogNaming';
import type { ImportedMcpInputDefinitionV1, ImportedMcpServerDraftV1 } from './parseImportedMcpServerJson';

export type McpQuickInstallPresetId =
    | 'playwright'
    | 'context7'
    | 'sequential-thinking'
    | 'github';

export type McpQuickInstallPreset = Readonly<{
    id: McpQuickInstallPresetId;
    title: string;
    description: string;
    iconName: string;
}>;

type QuickInstallDraft = Readonly<{
    preset: McpQuickInstallPreset;
    server: ImportedMcpServerDraftV1;
    inputs: ImportedMcpInputDefinitionV1[];
}>;

const PRESETS: readonly QuickInstallDraft[] = [
    {
        preset: {
            id: 'playwright',
            title: 'Playwright',
            description: 'Browser automation and testing.',
            iconName: 'globe',
        },
        server: {
            name: 'playwright',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@playwright/mcp@latest'],
            },
            env: {},
            enabled: true,
            warnings: [],
        },
        inputs: [],
    },
    {
        preset: {
            id: 'context7',
            title: 'Context7',
            description: 'Documentation lookup for libraries and frameworks.',
            iconName: 'book',
        },
        server: {
            name: 'context7',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@upstash/context7-mcp@latest'],
            },
            env: {},
            enabled: true,
            warnings: [],
        },
        inputs: [],
    },
    {
        preset: {
            id: 'sequential-thinking',
            title: 'Sequential Thinking',
            description: 'Think through complex problems step-by-step.',
            iconName: 'git-branch',
        },
        server: {
            name: 'sequential_thinking',
            title: 'Sequential Thinking',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
            },
            env: {},
            enabled: true,
            warnings: [],
        },
        inputs: [],
    },
    {
        preset: {
            id: 'github',
            title: 'GitHub',
            description: 'Repos, issues, PRs, and code search.',
            iconName: 'github-logo',
        },
        server: {
            name: 'github',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
            },
            env: {
                GITHUB_TOKEN: { t: 'input', inputId: 'github_token' },
            },
            enabled: true,
            warnings: [],
        },
        inputs: [{
            inputId: 'github_token',
            title: 'GitHub token',
            description: 'Token used by the GitHub MCP server.',
            secret: true,
            suggestedEnvVarName: 'GITHUB_TOKEN',
        }],
    },
] as const;

function isPresetConfigured(preset: QuickInstallDraft, settings: McpServersSettingsV1): boolean {
    const presetName = normalizeMcpServerNameCandidate(preset.server.name);
    const presetStdio = preset.server.stdio;
    return settings.servers.some((server) => {
        if (server.name === presetName) return true;
        if (!presetStdio || server.transport !== 'stdio' || !server.stdio) return false;
        return server.stdio.command === presetStdio.command
            && server.stdio.args.length === presetStdio.args.length
            && server.stdio.args.every((arg, index) => arg === presetStdio.args[index]);
    });
}

/**
 * Presets the user can still quick-install: a preset counts as installed when a configured server
 * already uses its name or its exact stdio launch command (so renamed installs are recognised too).
 */
export function listAvailableMcpQuickInstallPresets(settings: McpServersSettingsV1): readonly McpQuickInstallPreset[] {
    return PRESETS.filter((preset) => !isPresetConfigured(preset, settings)).map((preset) => preset.preset);
}

export function buildQuickInstallMcpDraft(id: McpQuickInstallPresetId): QuickInstallDraft {
    const preset = PRESETS.find((entry) => entry.preset.id === id);
    if (!preset) {
        throw new Error(`Unknown MCP quick install preset: ${id}`);
    }
    return preset;
}
