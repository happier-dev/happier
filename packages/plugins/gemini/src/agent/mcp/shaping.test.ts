import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { prepareGeminiMcpShaping, type GeminiMcpShapingContext } from './shaping.js';

function createTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createShapingContext(params: Readonly<{
  sourceHome: string;
  tempHome: string;
}>): GeminiMcpShapingContext {
  return {
    env: {
      list: () => ({
        HOME: params.sourceHome,
      }),
    },
    fs: {
      createTempDirectory: async (input) => {
        expect(input).toEqual({ prefix: 'happier-gemini-mcp-home-' });
        mkdirSync(params.tempHome, { recursive: true });
        return {
          path: params.tempHome,
          createTextFile: async () => {
            throw new Error('createTextFile is not used by Gemini MCP shaping');
          },
          createScopedPathListFile: async () => {
            throw new Error('createScopedPathListFile is not used by Gemini MCP shaping');
          },
          readText: async () => {
            throw new Error('readText is not used by Gemini MCP shaping');
          },
          cleanup: async () => {
            rmSync(params.tempHome, { recursive: true, force: true });
          },
        };
      },
    },
  };
}

describe('prepareGeminiMcpShaping', () => {
  it('copies non-auth Gemini settings while leaving local OAuth and auth state behind', async () => {
    const sourceHome = createTempRoot('happier-gemini-source-home-');
    const tempHome = createTempRoot('happier-gemini-plugin-home-');

    try {
      const geminiDir = join(sourceHome, '.gemini');
      const xdgGeminiDir = join(sourceHome, '.config', 'gemini');
      mkdirSync(geminiDir, { recursive: true });
      mkdirSync(xdgGeminiDir, { recursive: true });
      writeFileSync(join(geminiDir, 'oauth_creds.json'), JSON.stringify({ access_token: 'oauth-token' }), 'utf8');
      writeFileSync(join(geminiDir, 'auth.json'), JSON.stringify({ mode: 'interactive-login' }), 'utf8');
      writeFileSync(join(xdgGeminiDir, 'auth.json'), JSON.stringify({ mode: 'interactive-xdg-login' }), 'utf8');
      writeFileSync(join(geminiDir, 'config.json'), JSON.stringify({ apiEndpoint: 'https://example.invalid' }), 'utf8');
      writeFileSync(join(xdgGeminiDir, 'config.json'), JSON.stringify({ location: 'us-central1' }), 'utf8');
      writeFileSync(
        join(geminiDir, 'settings.json'),
        JSON.stringify({
          theme: 'dark',
          mcpServers: {
            leaked: {
              command: 'node',
              args: ['server.js'],
              env: { TOKEN: 'secret' },
            },
          },
        }),
        'utf8',
      );

      const prepared = await prepareGeminiMcpShaping(createShapingContext({ sourceHome, tempHome }));

      expect(prepared.env).toEqual({
        GEMINI_CLI_HOME: tempHome,
        HOME: tempHome,
        XDG_CONFIG_HOME: join(tempHome, '.config'),
      });
      expect(existsSync(join(tempHome, '.gemini', 'oauth_creds.json'))).toBe(false);
      expect(existsSync(join(tempHome, '.gemini', 'auth.json'))).toBe(false);
      expect(existsSync(join(tempHome, '.config', 'gemini', 'auth.json'))).toBe(false);
      expect(readFileSync(join(tempHome, '.gemini', 'config.json'), 'utf8')).toContain('apiEndpoint');
      expect(readFileSync(join(tempHome, '.config', 'gemini', 'config.json'), 'utf8')).toContain('us-central1');
      const settings = JSON.parse(readFileSync(join(tempHome, '.gemini', 'settings.json'), 'utf8')) as {
        theme?: string;
        mcpServers?: unknown;
      };
      expect(settings.theme).toBe('dark');
      expect(settings).not.toHaveProperty('mcpServers');
      expect(JSON.stringify(settings)).not.toContain('secret');

      await prepared.cleanup();
      expect(existsSync(tempHome)).toBe(false);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('replaces malformed copied settings with an empty object', async () => {
    const sourceHome = createTempRoot('happier-gemini-source-home-');
    const tempHome = createTempRoot('happier-gemini-plugin-home-');

    try {
      const geminiDir = join(sourceHome, '.gemini');
      mkdirSync(geminiDir, { recursive: true });
      writeFileSync(join(geminiDir, 'settings.json'), '{"theme":"dark","mcpServers":{"leak":', 'utf8');

      await prepareGeminiMcpShaping(createShapingContext({ sourceHome, tempHome }));

      const settings = JSON.parse(readFileSync(join(tempHome, '.gemini', 'settings.json'), 'utf8'));
      expect(settings).toEqual({});
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
