import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectClaudeMcpServers } from './detectServers.js';

describe('detectClaudeMcpServers', () => {
    it('reads Claude user and project MCP servers from the final plugin agent path', async () => {
        const configRoot = await mkdtemp(join(tmpdir(), 'claude-mcp-config-'));
        const projectRoot = await mkdtemp(join(tmpdir(), 'claude-mcp-project-'));
        await mkdir(join(projectRoot, '.claude'), { recursive: true });

        await writeFile(
            join(configRoot, 'settings.json'),
            JSON.stringify({
                mcpServers: {
                    review: {
                        command: 'review-mcp',
                        args: ['--stdio'],
                        env: {
                            REVIEW_TOKEN: 'hidden',
                        },
                    },
                },
            }),
            'utf8',
        );
        await writeFile(
            join(projectRoot, '.claude', 'settings.local.json'),
            JSON.stringify({
                mcp_servers: {
                    docs: {
                        url: 'https://mcp.example.test',
                        headers: {
                            Authorization: 'hidden',
                        },
                    },
                },
            }),
            'utf8',
        );

        const result = await detectClaudeMcpServers({
            directory: projectRoot,
            env: {
                CLAUDE_CONFIG_DIR: configRoot,
            },
        });

        expect(result.warnings).toEqual([]);
        expect(result.servers).toEqual([
            expect.objectContaining({
                provider: 'claude',
                name: 'review',
                transport: 'stdio',
                stdio: {
                    command: 'review-mcp',
                    args: ['--stdio'],
                },
                envKeys: ['REVIEW_TOKEN'],
            }),
            expect.objectContaining({
                provider: 'claude',
                name: 'docs',
                transport: 'http',
                remote: {
                    url: 'https://mcp.example.test',
                    headers: ['Authorization'],
                },
            }),
        ]);
    });
});
