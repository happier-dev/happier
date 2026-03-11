import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGeminiMcpCliEnvironment } from './createGeminiMcpCliEnvironment';

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('createGeminiMcpCliEnvironment', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies Gemini auth files and merges MCP servers into a temporary CLI home without persisting MCP env secrets', () => {
    const sourceHome = createTempDir('happier-gemini-source-home-');
    createdDirs.push(sourceHome);

    const geminiDir = join(sourceHome, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, 'oauth_creds.json'), JSON.stringify({ access_token: 'oauth-token' }), 'utf8');
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');

    const prepared = createGeminiMcpCliEnvironment({
      cwd: '/tmp/workspace',
      processEnv: { HOME: sourceHome },
      mcpServers: {
        qa_stdio: {
          command: 'node',
          args: ['server.js'],
          env: { QA_TOKEN: 'secret' },
        },
      },
    });

    createdDirs.push(prepared.cliHomeDir);

    expect(prepared.env.GEMINI_CLI_HOME).toBe(prepared.cliHomeDir);
    expect(prepared.env.HOME).toBe(prepared.cliHomeDir);
    expect(prepared.env.XDG_CONFIG_HOME).toBe(join(prepared.cliHomeDir, '.config'));
    expect(readFileSync(join(prepared.cliHomeDir, '.gemini', 'oauth_creds.json'), 'utf8')).toContain('oauth-token');
    expect(prepared.env.HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN).toBe('secret');

    const settings = JSON.parse(readFileSync(join(prepared.cliHomeDir, '.gemini', 'settings.json'), 'utf8')) as {
      theme?: string;
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    expect(settings.theme).toBe('dark');
    expect(settings.mcpServers?.qa_stdio).toEqual({
      command: 'node',
      args: ['server.js'],
      env: { QA_TOKEN: '$HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN' },
      cwd: '/tmp/workspace',
    });
    expect(JSON.stringify(settings)).not.toContain('secret');

    prepared.cleanup();
    expect(() => readFileSync(join(prepared.cliHomeDir, '.gemini', 'settings.json'), 'utf8')).toThrow();
  });
});
