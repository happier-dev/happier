import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { createRequesterSessionCredentialCustody, retireRequesterSessionCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { resolveAbsentSessionControlEnvKeys, stripSessionControlEnvOverrides } from '@/session/runtime/control/sessionControlEnvironment';

describe('requester Session private credential custody', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it('never falls back to custodian credentials when explicit requester custody is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-requester-credentials-'));
    directories.push(directory);
    const original = configuration.privateKeyFile;
    Object.assign(configuration, { privateKeyFile: join(directory, 'alice.key') });
    await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'alice-private-bearer' }));
    vi.stubEnv('HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', join(directory, 'missing-bob.key'));
    try {
      expect(await readStoredCredentials()).toBeNull();
    } finally { Object.assign(configuration, { privateKeyFile: original }); }
  });

  it('keeps private custody bound to the exact Session and retires only its admitted tuple', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-requester-custody-'));
    directories.push(directory);
    const binding = { happyHomeDir: directory, sessionId: 'bob-session', attribution: {
      serverId: configuration.activeServerId, accountId: 'bob', machineId: 'alice-machine', installationId: 'current-installation',
    } };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials: { token: 'bob-token', encryption: null } });
    vi.stubEnv('HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', custody.path);
    vi.stubEnv('HAPPIER_SESSION_REQUESTER_SESSION_ID', 'another-session');
    expect(await readStoredCredentials()).toBeNull();
    vi.stubEnv('HAPPIER_SESSION_REQUESTER_SESSION_ID', binding.sessionId);
    expect((await readStoredCredentials())?.token).toBe('bob-token');
    expect(await retireRequesterSessionCredentialCustody({ ...binding, attribution: { ...binding.attribution, accountId: 'alice' } })).toBe(false);
    expect((await readStoredCredentials())?.token).toBe('bob-token');
    expect(await retireRequesterSessionCredentialCustody(binding)).toBe(true);
    expect(await readStoredCredentials()).toBeNull();
  });

  it('rejects caller credential-path overrides and clears inherited requester custody from ordinary children', () => {
    expect(stripSessionControlEnvOverrides({ HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: '/forged',
      HAPPIER_SESSION_REQUESTER_SESSION_ID: 'forged', USER_SETTING: 'retained' })).toEqual({ USER_SETTING: 'retained' });
    expect(resolveAbsentSessionControlEnvKeys({})).toEqual(expect.arrayContaining([
      'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_SESSION_REQUESTER_SESSION_ID',
    ]));
  });
});
