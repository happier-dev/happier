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
            iconName: 'globe-outline',
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
            iconName: 'book-outline',
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
            iconName: 'git-branch-outline',
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
            iconName: 'logo-github',
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

export function listMcpQuickInstallPresets(): readonly McpQuickInstallPreset[] {
    return PRESETS.map((preset) => preset.preset);
}

export function buildQuickInstallMcpDraft(id: McpQuickInstallPresetId): QuickInstallDraft {
    const preset = PRESETS.find((entry) => entry.preset.id === id);
    if (!preset) {
        throw new Error(`Unknown MCP quick install preset: ${id}`);
    }
    return preset;
}
