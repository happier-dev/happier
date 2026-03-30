import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { readCodexEnvironmentAuthState } from './readCodexEnvironmentAuthState';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('readCodexEnvironmentAuthState', () => {
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
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'expired@example.test', exp: 1 }),
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthState({ HOME: dir, USERPROFILE: dir })).toEqual({
      method: null,
      accountLabel: null,
    });
  });

  it('accepts unexpired credentials-file tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'valid@example.test', exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthState({ HOME: dir, USERPROFILE: dir })).toEqual({
      method: 'credentials_file',
      accountLabel: 'valid@example.test',
    });
  });
});
