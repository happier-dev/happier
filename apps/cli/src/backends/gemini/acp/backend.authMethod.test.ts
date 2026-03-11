import { describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    authMethodId?: string;
    env?: Record<string, string | undefined>;
  };
};

function withTempHome<T>(fn: (homeDir: string) => T): T {
  const prevHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'happier-gemini-home-'));
  process.env.HOME = dir;
  try {
    return fn(dir);
  } finally {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

function withFakeGeminiCli<T>(fn: (geminiPath: string) => T): T {
  const prevGeminiPath = process.env.HAPPIER_GEMINI_PATH;
  const dir = mkdtempSync(join(tmpdir(), 'happier-gemini-bin-'));
  const geminiPath = join(dir, 'gemini');
  writeFileSync(geminiPath, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(geminiPath, 0o755);
  process.env.HAPPIER_GEMINI_PATH = geminiPath;

  try {
    return fn(geminiPath);
  } finally {
    if (prevGeminiPath === undefined) delete process.env.HAPPIER_GEMINI_PATH;
    else process.env.HAPPIER_GEMINI_PATH = prevGeminiPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createGeminiBackend auth method', () => {
  it('defaults to oauth-personal when no API key is present', () => {
    withTempHome(() => withFakeGeminiCli(() => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      const prevGoogleKey = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      try {
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('oauth-personal');
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prevGoogleKey;
      }
    }));
  });

  it('uses gemini-api-key when GEMINI_API_KEY is present', () => {
    withTempHome(() => withFakeGeminiCli(() => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      const prevGoogleKey = process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = 'AIzaFakeKey';
      try {
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('gemini-api-key');
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prevGoogleKey;
      }
    }));
  });

  it('creates a temporary Gemini CLI home for MCP-backed sessions and cleans it up on dispose', async () => {
    withTempHome((homeDir) => withFakeGeminiCli(() => {
      mkdirSync(join(homeDir, '.gemini'), { recursive: true });

      const result = createGeminiBackend({
        cwd: '/tmp/workspace',
        env: {},
        model: null,
        mcpServers: {
          qa_stdio: {
            command: 'node',
            args: ['server.js'],
            env: { QA_TOKEN: 'secret' },
          },
        },
      });

      const backend = result.backend as unknown as AcpBackendLike;
      const cliHomeDir = backend.options.env?.GEMINI_CLI_HOME;

      expect(cliHomeDir).toBeTruthy();
      expect(cliHomeDir).not.toBe(homeDir);
      expect(backend.options.env?.HOME).toBe(cliHomeDir);
      expect(backend.options.env?.HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN).toBe('secret');

      const settingsPath = join(String(cliHomeDir), '.gemini', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
      };
      expect(settings.mcpServers?.qa_stdio?.command).toBe('node');
      expect(settings.mcpServers?.qa_stdio?.env).toEqual({
        QA_TOKEN: '$HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN',
      });
      expect(JSON.stringify(settings)).not.toContain('secret');

      return result.backend.dispose().then(() => {
        expect(() => readFileSync(settingsPath, 'utf8')).toThrow();
      });
    }));
  });

  // Connected-services Gemini OAuth is materialized via ~/.gemini/oauth_creds.json and uses oauth-personal,
  // not GEMINI_API_KEY injection. That behavior is validated in connected-services materialization tests.
});
