import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { SessionRequesterBootstrapCredentialsV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { decodeStoredCredentials, encodeRequesterCredentials, encodeStoredCredentials, hasStoredSessionCredentialProvenance,
  readStoredCredentials, readStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
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
      expect(await readStoredCredentialsForServerId(configuration.activeServerId)).toBeNull();
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
    const child = await readStoredCredentials();
    expect(child?.token).toBe('bob-token');
    expect(hasStoredSessionCredentialProvenance(child)).toBe(false);
    expect(hasStoredSessionCredentialProvenance({ token: 'person-token', encryption: null,
      credentialProvenance: 'stored_session' })).toBe(true);
    const selected = await readStoredCredentialsForServerId(configuration.activeServerId);
    expect(selected?.requesterSessionCredentialScope?.requesterSession?.sessionId).toBe(binding.sessionId);
    expect(await readStoredCredentialsForServerId('another-home')).toBeNull();
    vi.stubEnv('HAPPIER_TOKEN', `hap_v1_11111111-1111-4111-8111-111111111111_${'A'.repeat(43)}`);
    expect((await readStoredCredentials({ serverId: configuration.activeServerId }))?.token).toBe('bob-token');
    expect(await readStoredCredentials({ serverId: 'another-home' })).toBeNull();
    expect(await retireRequesterSessionCredentialCustody({ ...binding, attribution: { ...binding.attribution, accountId: 'alice' } })).toBe(false);
    expect((await readStoredCredentials())?.token).toBe('bob-token');
    expect(await retireRequesterSessionCredentialCustody(binding)).toBe(true);
    expect(await readStoredCredentials()).toBeNull();
  });

  it('hands another person\'s Machine the guest\'s content key, which the host persists and opens Session content with, never the recovery secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-requester-recovery-'));
    directories.push(directory);
    const recoverySecret = tweetnacl.randomBytes(32);
    const guest: StoredCredentials = { token: 'bob-token', encryption: { type: 'legacy', secret: recoverySecret } };
    // Guest device -> private wire -> host codec -> host custody file -> Session child.
    const wire = SessionRequesterBootstrapCredentialsV1Schema.parse(encodeRequesterCredentials(guest));
    const received = decodeStoredCredentials(JSON.parse(JSON.stringify(wire)) as unknown);
    if (!received) throw new Error('Host refused the guest credentials');
    const binding = { happyHomeDir: directory, sessionId: 'bob-session', attribution: {
      serverId: configuration.activeServerId, accountId: 'bob', machineId: 'alice-machine', installationId: 'current-installation',
    } };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials: received });
    const persisted = await readFile(custody.path, 'utf8');
    // Boolean assertions: a failure must not print key material.
    expect(persisted.includes(encodeBase64(recoverySecret))).toBe(false);
    expect(persisted.includes(Buffer.from(recoverySecret).toString('base64url'))).toBe(false);
    expect('secret' in (JSON.parse(persisted) as { credentials: Record<string, unknown> }).credentials).toBe(false);

    vi.stubEnv('HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', custody.path);
    vi.stubEnv('HAPPIER_SESSION_REQUESTER_SESSION_ID', binding.sessionId);
    const child = await readStoredCredentials();
    if (!child) throw new Error('Missing guest Session credentials');
    const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(recoverySecret)).publicKey;
    const sessionKey = tweetnacl.randomBytes(32);
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey, recipientPublicKey: contentPublicKey,
      randomBytes: tweetnacl.randomBytes }));
    expect(openSessionDataEncryptionKey({ credential: child, encryptedDataEncryptionKeyBase64: envelope })).toEqual(sessionKey);
  });

  it('sends a content-key-only guest\'s credentials byte-identical to what it stores', () => {
    const guest: StoredCredentials = { token: 'bob-token', encryption: { type: 'dataKey',
      publicKey: new Uint8Array(32).fill(8), machineKey: new Uint8Array(32).fill(7) } };
    expect(JSON.stringify(encodeRequesterCredentials(guest))).toBe(JSON.stringify(encodeStoredCredentials(guest)));
  });

  it('rejects caller credential-path overrides and clears inherited requester custody from ordinary children', () => {
    expect(stripSessionControlEnvOverrides({ HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: '/forged',
      HAPPIER_SESSION_REQUESTER_SESSION_ID: 'forged', USER_SETTING: 'retained' })).toEqual({ USER_SETTING: 'retained' });
    expect(resolveAbsentSessionControlEnvKeys({})).toEqual(expect.arrayContaining([
      'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_SESSION_REQUESTER_SESSION_ID',
    ]));
  });
});
