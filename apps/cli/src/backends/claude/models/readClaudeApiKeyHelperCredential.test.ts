import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readClaudeApiKeyHelperCredential } from './readClaudeApiKeyHelperCredential';

let claudeConfigDir: string;

async function writeUserSettings(settings: unknown): Promise<void> {
  await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify(settings), 'utf8');
}

describe('readClaudeApiKeyHelperCredential', () => {
  beforeEach(async () => {
    claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-api-key-helper-'));
  });

  afterEach(async () => {
    await rm(claudeConfigDir, { recursive: true, force: true });
  });

  it('runs the apiKeyHelper from the Claude user settings and uses its trimmed output', async () => {
    await writeUserSettings({ apiKeyHelper: 'echo helper-token' });

    await expect(readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000 }))
      .resolves.toBe('helper-token');
  });

  it('passes the session environment to the helper', async () => {
    await writeUserSettings({
      apiKeyHelper: process.platform === 'win32' ? 'echo %HELPER_TOKEN%' : 'echo "$HELPER_TOKEN"',
    });

    await expect(readClaudeApiKeyHelperCredential({
      claudeConfigDir,
      env: { ...process.env, HELPER_TOKEN: 'from-session-env' },
      timeoutMs: 5_000,
    })).resolves.toBe('from-session-env');
  });

  it('returns null without settings, without a helper, or when the helper fails or prints nothing', async () => {
    const read = () => readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000 });

    await expect(read()).resolves.toBeNull();

    await writeFile(join(claudeConfigDir, 'settings.json'), '{ not json', 'utf8');
    await expect(read()).resolves.toBeNull();

    await writeUserSettings({ theme: 'dark' });
    await expect(read()).resolves.toBeNull();

    await writeUserSettings({ apiKeyHelper: 'exit 3' });
    await expect(read()).resolves.toBeNull();

    await writeUserSettings({ apiKeyHelper: 'exit 0' });
    await expect(read()).resolves.toBeNull();
  });
});
