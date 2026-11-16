import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';
import { reloadConfiguration } from '@/configuration';
import { prepareManagedSessionSshTrust } from './enrollmentSshTrust';

const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const other = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const correlation = { homeId: 'home', managedId: 'managed' };
const carrier = { kind: 'ssh', address: '192.0.2.7', port: 2222, user: 'guest', hostKeySource: 'retained-credential',
  credentialRef: { kind: 'shared_resource', resourceId: 'retained-key' } } as const;
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); reloadConfiguration(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'happier-session-ssh-')); roots.push(root);
  vi.stubEnv('HAPPIER_HOME_DIR', root); reloadConfiguration();
}

it('pins the installed retained host identity and preserves it across an address move', async () => {
  await home();
  const first = await prepareManagedSessionSshTrust({ correlation, carrier, guestHostPublicKey: key });
  expect(await readFile(first.knownHostsPath, 'utf8')).toBe(`[192.0.2.7]:2222 ${key}\n`);
  const moved = await prepareManagedSessionSshTrust({ correlation, carrier: { ...carrier, address: '192.0.2.8' }, guestHostPublicKey: key });
  expect(moved.knownHostsPath).toBe(first.knownHostsPath);
  expect(await readFile(moved.knownHostsPath, 'utf8')).toContain(`[192.0.2.8]:2222 ${key}\n`);
  await expect(prepareManagedSessionSshTrust({ correlation, carrier, guestHostPublicKey: other }))
    .rejects.toMatchObject({ code: 'trusted_host_key_mismatch' });
});

it('never authorizes a first connection from provider-observed evidence alone', async () => {
  await home();
  const { hostKeySource: _, ...observed } = carrier;
  await expect(prepareManagedSessionSshTrust({ correlation, carrier: { ...observed,
    hostKeyEvidence: { hostKey: `[192.0.2.7]:2222 ${key}`, fingerprint: computeSshHostKeyFingerprint(key.split(' ')[1]!) } }, guestHostPublicKey: key }))
    .rejects.toMatchObject({ code: 'ssh_host_trust_required' });
});

it('refuses evidence conflicting with the installed identity before preparing SSH', async () => {
  await home();
  await expect(prepareManagedSessionSshTrust({ correlation, carrier: { ...carrier,
    hostKeyEvidence: { hostKey: `[192.0.2.7]:2222 ${other}`, fingerprint: computeSshHostKeyFingerprint(other.split(' ')[1]!) } }, guestHostPublicKey: key }))
    .rejects.toMatchObject({ code: 'trusted_host_key_mismatch' });
});
