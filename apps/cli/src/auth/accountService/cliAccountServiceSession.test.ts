import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

import {
  createCliAccountServiceSessionOwner,
  resolveCliAccountServiceSessionRecordPath,
  type CliAccountServiceSelection,
} from './cliAccountServiceSession';

const roots: string[] = [];
const posixOnly = process.platform !== 'win32';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function createHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-account-service-session-'));
  roots.push(root);
  return root;
}

function service(overrides: Partial<CliAccountServiceSelection> = {}): CliAccountServiceSelection {
  return {
    endpoint: 'https://accounts.example.test',
    serverIdentityId: 'srv_account_service_a',
    canonicalServerUrl: 'https://accounts.example.test',
    advertisedMethods: {
      keyLoginAvailable: true,
      oauthProviderIds: ['github', 'google'],
      preferredProvisionProviderId: 'github',
    },
    ...overrides,
  };
}

function selectionAuthority(serviceValue: CliAccountServiceSelection) {
  return {
    endpoint: serviceValue.endpoint.replace(/\/+$/u, ''),
    serverIdentityId: serviceValue.serverIdentityId,
    canonicalServerUrl: serviceValue.canonicalServerUrl.replace(/\/+$/u, ''),
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleLateCompletion(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('CLI Account Service session owner', () => {
  it('locked policy admits its endpoint, rejects alternate selection, and retains the prior selection after policy removal', async () => {
    const happyHomeDir = await createHome();
    const unlocked = createCliAccountServiceSessionOwner({ happyHomeDir, organizationPolicy: { status: 'absent' } });
    await unlocked.selectService(service());
    const organizationPolicy = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","accountService":{"url":"https://company.example.test","locked":true}}');
    const locked = createCliAccountServiceSessionOwner({ happyHomeDir, organizationPolicy });
    await expect(locked.readSelection()).resolves.toBeNull();
    await expect(locked.selectService(service())).rejects.toThrow('organization_policy_locked');
    await expect(unlocked.readSelection()).resolves.toMatchObject({ endpoint: 'https://accounts.example.test' });
    await expect(locked.selectService(service({ endpoint: 'https://company.example.test', canonicalServerUrl: 'https://company.example.test', serverIdentityId: 'srv_company' }))).resolves.toMatchObject({ endpoint: 'https://company.example.test' });
  });

  it('invalid policy refuses Account-service selection without writing state', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir, organizationPolicy: { status: 'invalid', error: { path: '$', code: 'invalid_json' } } });
    await expect(owner.selectService(service())).rejects.toThrow('organization_policy_invalid');
    expect(await readdir(happyHomeDir)).toEqual([]);
  });
  it('stores one strict versioned record only in its dedicated protected namespace', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service({
      endpoint: 'https://accounts.example.test///',
      canonicalServerUrl: 'https://canonical.accounts.example.test/',
    });

    await owner.selectService(selected);
    await owner.replaceCredential({
      service: selected,
      credential: { token: 'restricted-account-service-token' },
    });

    const recordPath = resolveCliAccountServiceSessionRecordPath(happyHomeDir);
    const persisted = JSON.parse(await readFile(recordPath, 'utf8')) as unknown;
    expect(persisted).toEqual({
      v: 1,
      selectedService: {
        endpoint: 'https://accounts.example.test',
        serverIdentityId: 'srv_account_service_a',
        canonicalServerUrl: 'https://canonical.accounts.example.test',
      },
      restrictedCredential: { token: 'restricted-account-service-token' },
    });
    expect(await readdir(happyHomeDir)).toEqual(['account-service']);
    expect(await readdir(dirname(recordPath))).toEqual(['session-v1.json']);
    if (posixOnly) {
      expect((await stat(dirname(recordPath))).mode & 0o777).toBe(0o700);
      expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('atomically replaces the exact endpoint/identity selection without carrying its credential', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selectedA = service();
    const selectedB = service({
      serverIdentityId: 'srv_account_service_b',
      canonicalServerUrl: 'https://canonical-b.example.test',
      advertisedMethods: {
        keyLoginAvailable: false,
        oauthProviderIds: ['google'],
        preferredProvisionProviderId: 'google',
      },
    });

    await owner.selectService(selectedA);
    await owner.replaceCredential({ service: selectedA, credential: { token: 'token-a' } });
    await owner.selectService(selectedB);

    await expect(owner.readSelection()).resolves.toEqual(selectionAuthority(selectedB));
    await expect(owner.readCredential(selectedB)).resolves.toBeNull();
    await expect(owner.replaceCredential({
      service: selectedA,
      credential: { token: 'must-not-cross-service-boundary' },
    })).rejects.toMatchObject({ code: 'account_service_selection_mismatch' });
    await expect(owner.readCredential(selectedB)).resolves.toBeNull();
  });

  it('does not persist discovered methods and retains the credential for the same Account Service authority', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const refreshed = service({
      advertisedMethods: {
        keyLoginAvailable: false,
        oauthProviderIds: ['google'],
        preferredProvisionProviderId: 'google',
      },
    });

    await owner.selectService(selected);
    await owner.replaceCredential({ service: selected, credential: { token: 'still-valid-token' } });
    await owner.selectService(refreshed);

    await expect(owner.readSelection()).resolves.toEqual(selectionAuthority(refreshed));
    await expect(owner.readCredential(refreshed)).resolves.toEqual({ token: 'still-valid-token' });
  });

  it('cancels the prior pending attempt when the exact selected service changes and blocks its late commit', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selectedA = service();
    const selectedB = service({ serverIdentityId: 'srv_account_service_b' });
    const acquired = deferred<Readonly<{ token: string }>>();

    await owner.selectService(selectedA);
    const attempt = owner.authenticate({
      service: selectedA,
      timeoutMs: 30_000,
      acquireCredential: async () => await acquired.promise,
    });
    await owner.selectService(selectedB);
    await expect(attempt).resolves.toEqual({ kind: 'cancelled' });
    acquired.resolve({ token: 'late-token-a' });
    await settleLateCompletion();

    await expect(owner.readSelection()).resolves.toEqual(selectionAuthority(selectedB));
    await expect(owner.readCredential(selectedB)).resolves.toBeNull();
  });

  it('binds caller cancellation to the one pending authentication attempt', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const acquired = deferred<Readonly<{ token: string }>>();
    const controller = new AbortController();

    await owner.selectService(selected);
    const attempt = owner.authenticate({
      service: selected,
      timeoutMs: 30_000,
      signal: controller.signal,
      acquireCredential: async () => await acquired.promise,
    });
    controller.abort();

    await expect(attempt).resolves.toEqual({ kind: 'cancelled' });
    acquired.resolve({ token: 'late-after-caller-abort' });
    await settleLateCompletion();
    await expect(owner.readCredential(selected)).resolves.toBeNull();
  });

  it('timeout clears pending state without waiting for an uncooperative authenticator and blocks late commit', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const acquired = deferred<Readonly<{ token: string }>>();

    await owner.selectService(selected);
    const attempt = owner.authenticate({
      service: selected,
      timeoutMs: 5,
      acquireCredential: async () => await acquired.promise,
    });

    await expect(attempt).resolves.toEqual({ kind: 'timed_out' });
    acquired.resolve({ token: 'late-after-timeout' });
    await settleLateCompletion();
    await expect(owner.readCredential(selected)).resolves.toBeNull();
  });

  it('credential rejection clears both the current credential and pending attempt while blocking late replacement', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const acquired = deferred<Readonly<{ token: string }>>();

    await owner.selectService(selected);
    await owner.replaceCredential({ service: selected, credential: { token: 'rejected-token' } });
    const attempt = owner.authenticate({
      service: selected,
      timeoutMs: 30_000,
      acquireCredential: async () => await acquired.promise,
    });
    await owner.rejectCredential(selected);
    await expect(attempt).resolves.toEqual({ kind: 'cancelled' });
    acquired.resolve({ token: 'late-after-rejection' });
    await settleLateCompletion();

    await expect(owner.readCredential(selected)).resolves.toBeNull();
  });

  it('logout clears pending Account Service state but never reads or changes Home credentials', async () => {
    const happyHomeDir = await createHome();
    const homeCredentialPath = join(happyHomeDir, 'servers', 'studio', 'access.key');
    const legacyHomeCredentialPath = join(happyHomeDir, 'access.key');
    const settingsPath = join(happyHomeDir, 'settings.json');
    await mkdir(dirname(homeCredentialPath), { recursive: true });
    await writeFile(homeCredentialPath, 'home-token');
    await writeFile(legacyHomeCredentialPath, 'legacy-home-token');
    await writeFile(settingsPath, '{"servers":{"studio":{}}}');

    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const acquired = deferred<Readonly<{ token: string }>>();
    await owner.selectService(selected);
    await owner.replaceCredential({ service: selected, credential: { token: 'account-token' } });
    const attempt = owner.authenticate({
      service: selected,
      timeoutMs: 30_000,
      acquireCredential: async () => await acquired.promise,
    });
    await owner.logout();
    await expect(attempt).resolves.toEqual({ kind: 'cancelled' });
    acquired.resolve({ token: 'late-after-logout' });
    await settleLateCompletion();

    await expect(owner.readSelection()).resolves.toEqual(selectionAuthority(selected));
    await expect(owner.readCredential(selected)).resolves.toBeNull();
    await expect(readFile(homeCredentialPath, 'utf8')).resolves.toBe('home-token');
    await expect(readFile(legacyHomeCredentialPath, 'utf8')).resolves.toBe('legacy-home-token');
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{"servers":{"studio":{}}}');
  });

  it('clear removes only its dedicated record and cancels pending authentication', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const acquired = deferred<Readonly<{ token: string }>>();
    await owner.selectService(selected);
    const attempt = owner.authenticate({
      service: selected,
      timeoutMs: 30_000,
      acquireCredential: async () => await acquired.promise,
    });
    await owner.clear();
    await expect(attempt).resolves.toEqual({ kind: 'cancelled' });
    acquired.resolve({ token: 'late-after-clear' });
    await settleLateCompletion();

    await expect(owner.readSelection()).resolves.toBeNull();
    await expect(lstat(resolveCliAccountServiceSessionRecordPath(happyHomeDir)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not persist OAuth or other pending authentication continuation state', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    const acquired = deferred<Readonly<{ token: string }>>();
    const controller = new AbortController();
    await owner.selectService(selected);

    const attempt = owner.authenticate({
      service: selected,
      timeoutMs: 30_000,
      signal: controller.signal,
      acquireCredential: async () => await acquired.promise,
    });
    const rawWhilePending = await readFile(resolveCliAccountServiceSessionRecordPath(happyHomeDir), 'utf8');
    const storedWhilePending = JSON.parse(rawWhilePending) as Record<string, unknown>;
    expect(storedWhilePending).toMatchObject({
      v: 1,
      restrictedCredential: null,
      selectedService: selectionAuthority(selected),
    });
    expect(storedWhilePending.selectedService).not.toHaveProperty('advertisedMethods');
    expect(storedWhilePending).not.toHaveProperty('pendingAuthentication');
    expect(storedWhilePending).not.toHaveProperty('continuation');
    expect(storedWhilePending).not.toHaveProperty('credential');

    controller.abort();
    await expect(attempt).resolves.toEqual({ kind: 'cancelled' });
  });

  it('fails closed on corrupt or non-current stored records without replacing them', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    await owner.selectService(selected);
    const recordPath = resolveCliAccountServiceSessionRecordPath(happyHomeDir);
    const corrupt = '{"v":2,"selectedService":{},"restrictedCredential":null,"extra":true}';
    await writeFile(recordPath, corrupt, { mode: 0o600 });

    await expect(owner.readSelection()).rejects.toMatchObject({ code: 'account_service_storage_corrupt' });
    await expect(owner.selectService(selected)).rejects.toMatchObject({ code: 'account_service_storage_corrupt' });
    await expect(readFile(recordPath, 'utf8')).resolves.toBe(corrupt);
  });

  it('rejects the unreleased development selection shape instead of retaining a compatibility shim', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    await owner.selectService(selected);
    const recordPath = resolveCliAccountServiceSessionRecordPath(happyHomeDir);
    await writeFile(recordPath, JSON.stringify({
      v: 1,
      selectedService: selected,
      restrictedCredential: null,
    }), { mode: 0o600 });

    await expect(owner.readSelection()).rejects.toMatchObject({ code: 'account_service_storage_corrupt' });
  });

  it.runIf(posixOnly)('fails closed on a symbolic-link record', async () => {
    const happyHomeDir = await createHome();
    const recordPath = resolveCliAccountServiceSessionRecordPath(happyHomeDir);
    await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
    const target = join(happyHomeDir, 'elsewhere.json');
    await writeFile(target, '{"secret":"must-not-read"}', { mode: 0o600 });
    await symlink(target, recordPath);
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });

    await expect(owner.readSelection()).rejects.toMatchObject({ code: 'account_service_storage_unsafe' });
  });

  it.runIf(posixOnly)('fails closed when the namespace has insecure permissions', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    await owner.selectService(service());
    const namespacePath = dirname(resolveCliAccountServiceSessionRecordPath(happyHomeDir));
    await chmod(namespacePath, 0o755);

    await expect(owner.readSelection()).rejects.toMatchObject({ code: 'account_service_storage_unsafe' });
  });

  it.runIf(posixOnly)('fails closed when the namespace owner is not the expected user', async () => {
    const happyHomeDir = await createHome();
    const expectedUid = (await stat(happyHomeDir)).uid;
    const normalOwner = createCliAccountServiceSessionOwner({ happyHomeDir });
    await normalOwner.selectService(service());
    const wrongOwner = createCliAccountServiceSessionOwner({
      happyHomeDir,
      protectedLocalStateOptions: { expectedUid: expectedUid + 1 },
    });

    await expect(wrongOwner.readSelection()).rejects.toMatchObject({ code: 'account_service_storage_unsafe' });
  });

  it('serializes concurrent credential replacements into one complete valid record', async () => {
    const happyHomeDir = await createHome();
    const owner = createCliAccountServiceSessionOwner({ happyHomeDir });
    const selected = service();
    await owner.selectService(selected);

    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      await owner.replaceCredential({
        service: selected,
        credential: { token: `credential-${index}` },
      });
    }));

    await expect(owner.readCredential(selected)).resolves.toEqual({ token: 'credential-63' });
    const recordPath = resolveCliAccountServiceSessionRecordPath(happyHomeDir);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
      v: 1,
      restrictedCredential: { token: 'credential-63' },
    });
    await expect(readdir(dirname(recordPath))).resolves.toEqual(['session-v1.json']);
  });
});
