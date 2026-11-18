import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readServerIdentityRecord, readServerIdentityRecordSync } from './serverIdentityRecord.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function recordWith(content: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'server-identity-record-'));
  dirs.push(dir);
  const path = join(dir, 'server.identity');
  if (content !== null) await writeFile(path, content);
  return path;
}

describe('server identity record (one parser for the server, the Stack and the CLI)', () => {
  it.each([
    ['an absent record', null, null],
    ['a blank record', ' \n', null],
    ['the identity the server wrote', 'srv_minted.id-1\n', 'srv_minted.id-1'],
  ])('reads %s', async (_label, content, expected) => {
    const path = await recordWith(content);
    expect(await readServerIdentityRecord(path)).toBe(expected);
    expect(readServerIdentityRecordSync(path)).toBe(expected);
  });

  it.each([
    ['a value that is not a Home identity', 'not-a-home\n'],
    ['two identities', 'srv_a\nsrv_b\n'],
  ])('refuses %s instead of trusting it', async (_label, content) => {
    const path = await recordWith(content);
    await expect(readServerIdentityRecord(path)).rejects.toThrow(path);
    expect(() => readServerIdentityRecordSync(path)).toThrow(path);
  });
});
