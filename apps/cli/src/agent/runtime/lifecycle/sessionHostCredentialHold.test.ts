import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const testHome = vi.hoisted(() => {
  const home = `${process.env.TMPDIR ?? '/tmp'}/happier-host-credential-hold-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = home;
  return home;
});

import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { createSessionHostCredentialHold, SessionHostLaunchAccountChangedError } from './sessionHostCredentialHold';

function token(accountId: string, tokenEpoch: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // A terminal sign-in bearer as the Home mints it (the signature is never checked locally).
  return `${encode({ alg: 'none' })}.${encode({ sub: accountId, tokenEpoch, session: `terminal-${accountId}` })}.sig`;
}

async function signIn(accountId: string, tokenEpoch: number): Promise<void> {
  await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
  await writeFile(configuration.privateKeyFile, JSON.stringify({ token: token(accountId, tokenEpoch) }), { mode: 0o600 });
}

describe('session host credential hold', () => {
  afterAll(async () => { await rm(testHome, { recursive: true, force: true }); });

  it('reads the credential once per (Home, Account) and never starts a Session under the previous Account', async () => {
    let reads = 0;
    const hold = createSessionHostCredentialHold(async () => { reads += 1; return await readStoredCredentials(); });
    const accountA = { accountId: 'account-a', credentialEpoch: 0, machineId: 'machine-1' };
    const accountB = { accountId: 'account-b', credentialEpoch: 3, machineId: 'machine-1' };

    await signIn('account-a', 0);
    for (let added = 0; added < 3; added += 1) {
      expect((await hold.resolve(accountA)).token).toBe(token('account-a', 0));
    }
    expect(reads).toBe(1);

    // Sign out A, sign in B: the daemon now admits B; the host's held A is never used for it.
    await rm(configuration.privateKeyFile);
    await signIn('account-b', 3);
    expect((await hold.resolve(accountB)).token).toBe(token('account-b', 3));
    expect(reads).toBe(2);

    // A launch admitted for A while only B is signed in on disk: typed refusal, never A's held bearer.
    const fresh = createSessionHostCredentialHold(async () => { reads += 1; return await readStoredCredentials(); });
    await expect(fresh.resolve(accountA)).rejects.toBeInstanceOf(SessionHostLaunchAccountChangedError);

    // Same Account, retired epoch (sign out everywhere): the held bearer is dropped and re-read once.
    await signIn('account-b', 4);
    const reread = await hold.resolve({ ...accountB, credentialEpoch: 4 });
    expect(reread.token).toBe(token('account-b', 4));
    expect(reads).toBe(4);

    // Each Session gets its own object: custody bound onto one never reaches the next.
    const first = await hold.resolve({ ...accountB, credentialEpoch: 4 });
    const second = await hold.resolve({ ...accountB, credentialEpoch: 4 });
    expect(first).not.toBe(second);
    expect(reads).toBe(4);
  });
});
