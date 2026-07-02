import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectCodexMcpServers } from './detectCodexMcpServers.js';

describe('detectCodexMcpServers', () => {
    it('reads Codex MCP stdio servers from the final plugin agent path', async () => {
        const configRoot = await mkdtemp(join(tmpdir(), 'codex-mcp-config-'));
        await writeFile(
            join(configRoot, 'config.toml'),
            [
                '[mcp_servers.context7]',
                'command = "context7-mcp"',
                'args = ["--stdio"]',
                'enabled = true',
                '',
                '[mcp_servers."review.docs"]',
                'command = "review-mcp"',
                'args = ["--repo","."]',
                'enabled = false',
                '',
            ].join('\n'),
            'utf8',
        );

        const result = await detectCodexMcpServers({
            env: {
                CODEX_HOME: configRoot,
            },
        });

        expect(result.warnings).toEqual([]);
        expect(result.servers).toEqual([
            expect.objectContaining({
                provider: 'codex',
                name: 'context7',
                transport: 'stdio',
                stdio: {
                    command: 'context7-mcp',
                    args: ['--stdio'],
                },
                envKeys: [],
                enabled: true,
            }),
            expect.objectContaining({
                provider: 'codex',
                name: 'review.docs',
                transport: 'stdio',
                stdio: {
                    command: 'review-mcp',
                    args: ['--repo', '.'],
                },
                envKeys: [],
                enabled: false,
            }),
        ]);
    });
});
