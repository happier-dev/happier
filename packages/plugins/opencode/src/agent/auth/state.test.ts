import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  probeOpenAiCodexOauthRefreshToken,
  readOpenCodeOauthRefreshToken,
  resolveOpenCodeAuthJsonPath,
} from './state.js';

describe('OpenCode auth state', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-auth-state-'));
    tempDirs.push(dir);
    return dir;
  }

  it('resolves the OpenCode auth file from XDG_DATA_HOME', () => {
    expect(resolveOpenCodeAuthJsonPath({
      env: { XDG_DATA_HOME: '/tmp/opencode-data' },
      homeDir: '/home/alice',
    })).toBe('/tmp/opencode-data/opencode/auth.json');
  });

  it('reads a trimmed OpenAI refresh token from the auth file', async () => {
    const dataHome = await createTempDir();
    const authDir = join(dataHome, 'opencode');
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({
      openai: {
        refresh: '  refresh-token  ',
      },
    }));

    expect(readOpenCodeOauthRefreshToken({
      env: { XDG_DATA_HOME: dataHome },
      homeDir: '/home/alice',
    })).toBe('refresh-token');
  });

  it('returns null for missing or malformed auth files', async () => {
    const dataHome = await createTempDir();
    await writeFile(join(dataHome, 'auth.json'), '{');

    expect(readOpenCodeOauthRefreshToken({
      env: { XDG_DATA_HOME: dataHome },
      homeDir: '/home/alice',
    })).toBeNull();
  });

  it('probes OAuth refresh tokens with injected provider config', async () => {
    let body: URLSearchParams | null = null;
    const fetchOpenAiToken = async (_url: string, init: Readonly<{ body: URLSearchParams }>) => {
      body = init.body;
      return { ok: true, status: 200 };
    };

    await expect(probeOpenAiCodexOauthRefreshToken(' refresh-token ', {
      tokenUrl: 'https://oauth.example/token',
      clientId: 'client-id',
      fetchOpenAiToken,
      env: {},
    })).resolves.toBe('valid');

    expect(body?.get('grant_type')).toBe('refresh_token');
    expect(body?.get('client_id')).toBe('client-id');
    expect(body?.get('refresh_token')).toBe('refresh-token');
  });

  it('classifies rejected and transport-failed refresh token probes', async () => {
    await expect(probeOpenAiCodexOauthRefreshToken('refresh-token', {
      tokenUrl: 'https://oauth.example/token',
      clientId: 'client-id',
      fetchOpenAiToken: async () => ({ ok: false, status: 401 }),
      env: {},
    })).resolves.toBe('invalid');

    await expect(probeOpenAiCodexOauthRefreshToken('refresh-token', {
      tokenUrl: 'https://oauth.example/token',
      clientId: 'client-id',
      fetchOpenAiToken: async () => {
        throw new Error('network down');
      },
      env: {},
    })).resolves.toBe('unknown');
  });

  it('clears pending timeout handles after a successful probe', async () => {
    vi.useFakeTimers();

    await expect(probeOpenAiCodexOauthRefreshToken('refresh-token', {
      tokenUrl: 'https://oauth.example/token',
      clientId: 'client-id',
      fetchOpenAiToken: async () => ({ ok: true, status: 200 }),
      env: { HAPPIER_OPENCODE_OAUTH_REFRESH_TOKEN_PROBE_TIMEOUT_MS: '25' },
    })).resolves.toBe('valid');

    expect(vi.getTimerCount()).toBe(0);
  });
});
