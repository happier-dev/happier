import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCodexEnvironmentAuthTokens } from './environment.js';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('readCodexEnvironmentAuthTokens', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('ignores expired credentials-file tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: buildJwt({ email: 'expired@example.test', exp: 1 }) } }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthTokens({ HOME: dir, USERPROFILE: dir })).toEqual({
      idToken: null,
      accessToken: null,
      accountId: null,
      accountLabel: null,
    });
  });

  it('reads usable credentials-file access tokens and ChatGPT account ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({
            email: 'valid@example.test',
            chatgpt_account_id: 'acct-chatgpt',
            exp: 4_102_444_800,
          }),
          access_token: buildJwt({ exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthTokens({ HOME: dir, USERPROFILE: dir })).toEqual({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      accountId: 'acct-chatgpt',
      accountLabel: 'valid@example.test',
    });
  });

  it('reads an exact account id from the Codex auth store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'valid@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ exp: 4_102_444_800 }),
          account_id: 'acct-from-store',
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthTokens({ HOME: dir, USERPROFILE: dir })).toEqual({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      accountId: 'acct-from-store',
      accountLabel: 'valid@example.test',
    });
  });

  it('expands CODEX_HOME from the caller environment home', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-home-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'custom-codex'), { recursive: true });
    await writeFile(
      join(dir, 'custom-codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: buildJwt({ email: 'tilde@example.test', exp: 4_102_444_800 }) } }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthTokens({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: '~/custom-codex',
    })).toMatchObject({ accountLabel: 'tilde@example.test' });
  });
});
