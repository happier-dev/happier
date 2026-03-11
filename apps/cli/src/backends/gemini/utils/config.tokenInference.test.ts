import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readGeminiLocalConfig } from './config';

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

describe('readGeminiLocalConfig token inference', () => {
  it('does not treat oauth_creds.json access_token as an API key', () => {
    withTempHome((homeDir) => {
      const geminiDir = join(homeDir, '.gemini');
      mkdirSync(geminiDir, { recursive: true });
      writeFileSync(
        join(geminiDir, 'oauth_creds.json'),
        JSON.stringify({ access_token: 'ya29.fake-oauth-token' }),
        'utf8',
      );

      const cfg = readGeminiLocalConfig();
      expect(cfg.token).toBeNull();
    });
  });

  it('prefers GEMINI_CLI_HOME over HOME when reading local config', () => {
    const prevHome = process.env.HOME;
    const prevGeminiCliHome = process.env.GEMINI_CLI_HOME;
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-gemini-home-default-'));
    const cliHomeDir = mkdtempSync(join(tmpdir(), 'happier-gemini-home-override-'));

    process.env.HOME = homeDir;
    process.env.GEMINI_CLI_HOME = cliHomeDir;

    try {
      mkdirSync(join(homeDir, '.gemini'), { recursive: true });
      writeFileSync(join(homeDir, '.gemini', 'config.json'), JSON.stringify({ model: 'home-model' }), 'utf8');

      mkdirSync(join(cliHomeDir, '.gemini'), { recursive: true });
      writeFileSync(join(cliHomeDir, '.gemini', 'config.json'), JSON.stringify({ model: 'override-model' }), 'utf8');

      const cfg = readGeminiLocalConfig();
      expect(cfg.model).toBe('override-model');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevGeminiCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prevGeminiCliHome;
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(cliHomeDir, { recursive: true, force: true });
    }
  });
});
