import { describe, expect, it } from 'vitest';

import type { McpServersSettingsV1 } from '@happier-dev/protocol';

import {
    buildQuickInstallMcpDraft,
    listAvailableMcpQuickInstallPresets,
} from './mcpQuickInstallCatalog';

describe('mcpQuickInstallCatalog', () => {
    it('lists the curated dev-core presets', () => {
        expect(listAvailableMcpQuickInstallPresets({ v: 1, strictMode: false, servers: [], bindings: [] }).map((preset) => preset.id)).toEqual([
            'playwright',
            'context7',
            'sequential-thinking',
            'github',
        ]);
    });

    it('offers only presets that are not already configured, matched by name or by launch command', () => {
        const settings: McpServersSettingsV1 = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'renamed-playwright',
                    name: 'browser',
                    transport: 'stdio',
                    stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'remote-context7',
                    name: 'context7',
                    transport: 'http',
                    remote: { url: 'https://mcp.context7.com/mcp', headers: {} },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            bindings: [],
        };

        expect(listAvailableMcpQuickInstallPresets(settings).map((preset) => preset.id)).toEqual([
            'sequential-thinking',
            'github',
        ]);
    });

    it('builds the GitHub preset with an input-backed token requirement', () => {
        const draft = buildQuickInstallMcpDraft('github');

        expect(draft.inputs).toEqual([
            {
                inputId: 'github_token',
                title: 'GitHub token',
                description: 'Token used by the GitHub MCP server.',
                secret: true,
                suggestedEnvVarName: 'GITHUB_TOKEN',
            },
        ]);
        expect(draft.server).toMatchObject({
            name: 'github',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
            },
            env: {
                GITHUB_TOKEN: {
                    t: 'input',
                    inputId: 'github_token',
                },
            },
        });
    });
});
