import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDirSync } from '@/testkit/fs/tempDir';

import { createGeminiMcpCliEnvironment } from './createGeminiMcpCliEnvironment';

describe('createGeminiMcpCliEnvironment', () => {
  it('copies Gemini auth files and scrubs MCP servers from the temporary CLI home', () => {
    withTempDirSync('happier-gemini-source-home-', (sourceHome) => {
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

      try {
        expect(prepared.env.GEMINI_CLI_HOME).toBe(prepared.cliHomeDir);
        expect(prepared.env.HOME).toBe(prepared.cliHomeDir);
        expect(prepared.env.XDG_CONFIG_HOME).toBe(join(prepared.cliHomeDir, '.config'));
        expect(readFileSync(join(prepared.cliHomeDir, '.gemini', 'oauth_creds.json'), 'utf8')).toContain('oauth-token');
        const settings = JSON.parse(readFileSync(join(prepared.cliHomeDir, '.gemini', 'settings.json'), 'utf8')) as {
          theme?: string;
          mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
        };
        expect(settings.theme).toBe('dark');
        expect(settings).not.toHaveProperty('mcpServers');
        expect(JSON.stringify(settings)).not.toContain('secret');

        prepared.cleanup();
        expect(() => readFileSync(join(prepared.cliHomeDir, '.gemini', 'settings.json'), 'utf8')).toThrow();
      } finally {
        prepared.cleanup();
      }
    });
  });

  it('fails closed by replacing malformed copied settings with an empty object', () => {
    withTempDirSync('happier-gemini-source-home-', (sourceHome) => {
      const geminiDir = join(sourceHome, '.gemini');
      mkdirSync(geminiDir, { recursive: true });
      writeFileSync(join(geminiDir, 'settings.json'), '{"theme":"dark","mcpServers":{"leak":', 'utf8');

      const prepared = createGeminiMcpCliEnvironment({
        cwd: '/tmp/workspace',
        processEnv: { HOME: sourceHome },
        mcpServers: {},
      });

      try {
        const settings = JSON.parse(readFileSync(join(prepared.cliHomeDir, '.gemini', 'settings.json'), 'utf8'));
        expect(settings).toEqual({});
      } finally {
        prepared.cleanup();
      }
    });
  });
});
