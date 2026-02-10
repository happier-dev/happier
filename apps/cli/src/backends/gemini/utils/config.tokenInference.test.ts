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
});
