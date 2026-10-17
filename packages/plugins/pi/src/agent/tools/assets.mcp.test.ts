import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';
import { describe, expect, it } from 'vitest';
import { preparePiHappierToolsExtension } from './assets.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

describe('Pi private user MCP config', () => {
  it('carries the open-request servers in the private config and removes it on dispose', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-mcp-assets-'));
    const secret = 'pi-private-carrier-sentinel';
    const launcherConfigPath = writeSecureTempTextFileSync({ prefix: 'happier-pi-carrier-fixture-', suffix: '.json',
      contents: JSON.stringify({ command: '/managed/server', args: ['serve'], env: { TOKEN: secret } }) });
    try {
      // The real host materializer carries secrets in its own private launcher
      // file; the extension must preserve that binding without embedding them.
      const mcpServers = { example: { command: '/managed/launcher', args: [],
        env: { HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: launcherConfigPath } } };
      const mcpToolPolicy = { example: { unlisted: 'ask', tools: { read: 'allow', write: 'off' } } } satisfies NonNullable<AgentSessionOpenRequest['mcpToolPolicy']>;
      const prepared = await preparePiHappierToolsExtension({
        config: { v: 1, sessionId: 'session', directory: root, systemPrompt: '', tools: [],
          launch: { executablePath: '/managed/happier', argsPrefix: [] } },
        mcpServers,
        mcpToolPolicy,
        mcpServersStrictMode: true,
      });
      try {
        expect(JSON.parse(readFileSync(prepared.configPath, 'utf8')).mcpServers).toEqual(mcpServers);
        expect(JSON.parse(readFileSync(prepared.configPath, 'utf8')).mcpToolPolicy).toEqual(mcpToolPolicy);
        expect(JSON.parse(readFileSync(prepared.configPath, 'utf8')).mcpServersStrictMode).toBe(true);
        expect(readFileSync(prepared.configPath, 'utf8')).not.toContain(secret);
        expect(readFileSync(prepared.extensionPath, 'utf8')).not.toContain(secret);
        expect(JSON.parse(readFileSync(launcherConfigPath, 'utf8')).env.TOKEN).toBe(secret);
        if (process.platform !== 'win32') expect(statSync(prepared.configPath).mode & 0o777).toBe(0o600);
      } finally {
        await prepared.dispose();
      }
      expect(existsSync(prepared.configPath)).toBe(false);
      expect(existsSync(prepared.extensionPath)).toBe(false);
    } finally {
      rmSync(dirname(launcherConfigPath), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares Run MCP without a Session bridge or invented Session identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-run-mcp-assets-'));
    let prepared: Awaited<ReturnType<typeof preparePiHappierToolsExtension>> | undefined;
    try {
      prepared = await preparePiHappierToolsExtension({ directory: root,
        mcpServersStrictMode: false,
        mcpServers: { run: { command: '/managed/server', args: [] } },
        mcpToolPolicy: { run: { unlisted: 'ask', tools: { echo: 'ask' } } } });
      const config = JSON.parse(readFileSync(prepared.configPath, 'utf8'));
      expect(config).toMatchObject({ v: 1, directory: root, tools: [], mcpServersStrictMode: false,
        mcpServers: { run: { command: '/managed/server', args: [] } },
        mcpToolPolicy: { run: { unlisted: 'ask', tools: { echo: 'ask' } } } });
      expect(config).not.toHaveProperty('sessionId');
      expect(config).not.toHaveProperty('launch');
      expect(prepared.toolNames).toEqual([]);
    } finally {
      await prepared?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
