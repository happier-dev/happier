import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { materializeClaudeMcpConfigArgsForSpawn } from './materializeClaudeMcpConfigArgsForSpawn';

describe('materializeClaudeMcpConfigArgsForSpawn', () => {
    it('replaces inline MCP JSON with private files, preserves path inputs, and cleans up idempotently', async () => {
        const first = JSON.stringify({
            mcpServers: { first: { command: 'mcp-one', env: { TOKEN: 'synthetic-first' } } },
        });
        const second = JSON.stringify({
            mcpServers: { second: { command: 'mcp-two', env: { TOKEN: 'synthetic-second' } } },
        });
        const existingPath = '/already/materialized/mcp.json';

        const materialized = await materializeClaudeMcpConfigArgsForSpawn([
            '--mcp-config',
            first,
            '--mcp-config',
            existingPath,
            `--mcp-config=${second}`,
        ]);

        expect(JSON.stringify(materialized.args)).not.toContain('synthetic-first');
        expect(JSON.stringify(materialized.args)).not.toContain('synthetic-second');
        expect(materialized.args[3]).toBe(existingPath);
        expect(materialized.cleanupPaths).toHaveLength(2);

        const firstPath = materialized.args[1]!;
        const secondPath = materialized.args[4]!.slice('--mcp-config='.length);
        await expect(readFile(firstPath, 'utf8')).resolves.toBe(first);
        await expect(readFile(secondPath, 'utf8')).resolves.toBe(second);
        if (process.platform !== 'win32') {
            expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
            expect((await stat(secondPath)).mode & 0o777).toBe(0o600);
        }

        await materialized.cleanup();
        await materialized.cleanup();
        expect(existsSync(firstPath)).toBe(false);
        expect(existsSync(secondPath)).toBe(false);
        expect(existsSync(dirname(firstPath))).toBe(false);
        expect(existsSync(dirname(secondPath))).toBe(false);
    });
});
