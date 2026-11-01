import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCodexMcpConfigServers } from './configServers.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('readCodexMcpConfigServers', () => {
    it('finds user and project native transports, disabled entries and value names without disclosing values', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-codex-native-'));
        try {
            await mkdir(join(home, '.codex'));
            const project = join(home, 'project');
            await mkdir(join(project, '.codex'), { recursive: true });
            await writeFile(join(home, '.codex', 'config.toml'), [
                '[mcp_servers.local]', 'command = "bridge"', 'args = ["--stdio"]',
                'env = { API_KEY = "private-native-value" }', 'env_vars = ["PASSTHROUGH"]',
                '[mcp_servers.remote]', 'url = "https://example.test/mcp"', 'enabled = false',
                'http_headers = { "X-Api-Key" = "private-native-value" }',
                'env_http_headers = { "X-Tenant" = "TENANT" }', 'bearer_token_env_var = "TOKEN"',
            ].join('\n'));
            await writeFile(join(project, '.codex', 'config.toml'), '[mcp_servers.project]\ncommand = "project-bridge"\n');
            const result = await readCodexMcpConfigServers({ env: { HOME: home, USERPROFILE: home }, directory: '~/project' });
            expect(result.warnings).toEqual([]);
            expect(result.servers).toMatchObject([
                { name: 'local', transport: 'stdio', envKeys: ['API_KEY', 'PASSTHROUGH'], source: { kind: 'user', path: join(home, '.codex', 'config.toml') } },
                { name: 'remote', transport: 'http', enabled: false, remote: { url: 'https://example.test/mcp', headers: ['X-Api-Key', 'X-Tenant', 'Authorization'] } },
                { name: 'project', transport: 'stdio', source: { kind: 'project', path: join(project, '.codex', 'config.toml') } },
            ]);
            expect(JSON.stringify(result)).not.toContain('private-native-value');
        } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('discovers inline tables and preserves escaped arguments through the canonical TOML parser', async () => {
        const configRoot = await mkdtemp(join(tmpdir(), 'codex-mcp-inline-'));
        temporaryRoots.push(configRoot);
        await writeFile(join(configRoot, 'config.toml'), '[mcp_servers]\ninline = { command = "bridge", args = ["line\\nvalue", "quote\\\"value"], enabled = true }\n');
        const result = await readCodexMcpConfigServers({ env: { CODEX_HOME: configRoot } });
        expect(result.servers).toMatchObject([{ name: 'inline', stdio: { command: 'bridge', args: ['line\nvalue', 'quote"value'] }, enabled: true }]);
    });
    it('reads Codex MCP stdio servers from the final plugin agent path', async () => {
        const configRoot = await mkdtemp(join(tmpdir(), 'codex-mcp-config-'));
        temporaryRoots.push(configRoot);
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

        const result = await readCodexMcpConfigServers({
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
