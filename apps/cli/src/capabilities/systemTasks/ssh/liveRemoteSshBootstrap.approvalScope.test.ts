import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliPayloadFixture } from '../../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { configuration, reloadConfiguration } from '@/configuration';
import { withCliApiToken } from '@/auth/cliApiToken';
import { deriveServerIdFromUrl } from '@/server/serverId';
import { findAvailableLoopbackPort } from '@/cloud/loopbackPort';
import { createLiveRemoteSshBootstrapTaskKind } from './liveRemoteSshBootstrap';

const boundary = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), enrolled: new Set<string>(), relayRuntimeUrl: null as string | null,
}));

// Only HTTP and SSH/process IO are simulated; selection, credential files,
// installation, enrollment parsing and terminal approval remain real.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: boundary.get, post: boundary.post } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === 'ssh-keyscan'
    ? { status: 0, stdout: 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n', stderr: '' }
    : actual.spawnSync(...args) };
});
vi.mock('@happier-dev/cli-common/ssh', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/ssh')>();
  return { ...actual,
    transferOpenSshFile: async () => undefined,
    withOpenSshLocalPortForward: async (_request: unknown, run: () => Promise<unknown>) => await run(),
    runOpenSshRemoteCommand: async (params: Parameters<typeof actual.runOpenSshRemoteCommand>[0]) => {
      const command = params.remoteCommand.join(' ');
      const json = (data: unknown) => ({ status: 0, stdout: `${JSON.stringify(data)}\n`, stderr: '' });
      if (command.includes('enroll-remote')) {
        const now = Date.now();
        const stdout = [
          { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
            publicKey: Buffer.alloc(32, 3).toString('base64'), homeServerIdentityId: 'srv_scope_home',
            pairing: { secretB64Url: Buffer.alloc(32, 4).toString('base64url'), createdAtMs: now, expiresAtMs: now + 60_000 },
            supportsTokenOnly: true, pairingRequirement: 'v3' },
          { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
            homeServerIdentityId: 'srv_scope_home', machineId: params.target, encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile' },
        ].map(value => JSON.stringify(value)).join('\n') + '\n';
        boundary.enrolled.add(params.target);
        params.onStdoutChunk?.(stdout);
        return { status: 0, stdout, stderr: '' };
      }
      if (command.includes('relay host install')) return json({ ok: true, kind: 'relay_host_install', data: { relayUrl: boundary.relayRuntimeUrl, mode: 'user' } });
      if (command.includes('auth status --json')) return json({ v: 1, ok: true, kind: 'auth_status', data: {
        authenticated: boundary.enrolled.has(params.target),
        credentialState: boundary.enrolled.has(params.target) ? 'valid' : 'missing',
        machineRegistrationState: boundary.enrolled.has(params.target) ? 'server-confirmed' : 'no-local-id',
        machineId: boundary.enrolled.has(params.target) ? params.target : null,
      } });
      if (command.includes('current_target##*/')) return { status: 0, stdout: 'current=test-version\nprevious=\nversion=test-version\n', stderr: '' };
      if (command.includes('"arch"')) return json({ platform: 'linux', arch: 'x86_64' });
      return json({ ok: true, data: {} });
    },
  };
});

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_TOKEN',
  'HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE'] as const;
let scope = createEnvKeyScope(envKeys);
afterEach(() => { scope.restore(); reloadConfiguration(); scope = createEnvKeyScope(envKeys); });
beforeEach(() => {
  boundary.enrolled.clear(); boundary.relayRuntimeUrl = null; boundary.get.mockReset(); boundary.post.mockReset();
  boundary.get.mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) });
  boundary.post.mockResolvedValue({ status: 200, data: {} });
});

async function provisionCredentials(home: string, serverId: string, token: string) {
  const directory = join(home, 'servers', serverId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'access.key'), JSON.stringify({ token }), { mode: 0o600 });
}

function startBootstrap(name: string, relayUrl: string, options: Readonly<{ publicRelayUrl?: string; relayRuntime?: boolean; requireLocalApproval?: boolean }> = {}) {
  return createLiveRemoteSshBootstrapTaskKind().run({
    params: { ssh: { target: name, auth: 'agent' }, relay: { relayUrl, ...(options.publicRelayUrl ? { publicRelayUrl: options.publicRelayUrl } : {}) },
      knownHostsMode: 'system', serviceMode: 'none', channel: 'preview',
      ...(options.requireLocalApproval ? { requireLocalApproval: true } : {}),
      ...(options.relayRuntime ? { relayRuntime: { enabled: true, mode: 'user', env: { PORT: new URL(relayUrl).port } } } : {}) },
    emit: () => undefined,
    prompt: async request => {
      if (request.kind === 'auth.approveRemoteProvisioning' || request.kind === 'ssh.trustHost') return { approved: true, trusted: true };
      throw new Error(`Unexpected prompt: ${request.kind}`);
    },
  });
}

async function withFixture(run: (home: string) => Promise<void>) {
  await withTempDir('happier-ssh-approval-scope-', async home => {
    const payload = await createCliPayloadFixture();
    scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://current.example.test',
      HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: 'https://current-app.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
      HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payload.payloadRoot });
    reloadConfiguration();
    await provisionCredentials(home, configuration.activeServerId, 'current-fixture-bearer');
    try { await run(home); } finally { await payload.cleanup(); }
  });
}

describe('SSH bootstrap approval invocation scope', () => {
  it('keeps overlapping Session approvals on their selected credentials and routes without changing global configuration', async () => {
    await withFixture(async home => {
      const firstUrl = 'https://first.example.test';
      const secondUrl = 'https://second.example.test';
      await provisionCredentials(home, deriveServerIdFromUrl(firstUrl), 'first-fixture-bearer');
      await provisionCredentials(home, deriveServerIdFromUrl(secondUrl), 'second-fixture-bearer');
      const originalConfiguration = configuration;
      const originalEnvironment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
      const observations: Array<{ url: string; bearer: string }> = [];
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      const entered = new Promise<void>(resolve => { firstEntered = resolve; });
      const held = new Promise<void>(resolve => { releaseFirst = resolve; });
      boundary.post.mockImplementation(async (url: string, _body: unknown, options: { headers: { Authorization: string } }) => {
        observations.push({ url, bearer: options.headers.Authorization });
        if (url.startsWith(firstUrl)) { firstEntered(); await held; }
        return { status: 200, data: {} };
      });
      const first = startBootstrap('first-session', firstUrl);
      try {
        await Promise.race([entered, first.then(() => { throw new Error("Bootstrap completed before approval"); })]);
        await startBootstrap('second-session', secondUrl);
        expect(configuration).toBe(originalConfiguration);
        expect(Object.fromEntries(envKeys.map(key => [key, process.env[key]]))).toEqual(originalEnvironment);
      } finally { releaseFirst(); await first; }
      expect(observations).toEqual([
        { url: `${firstUrl}/v1/auth/response`, bearer: 'Bearer first-fixture-bearer' },
        { url: `${secondUrl}/v1/auth/response`, bearer: 'Bearer second-fixture-bearer' },
      ]);
      expect(configuration).toBe(originalConfiguration);
      expect(Object.fromEntries(envKeys.map(key => [key, process.env[key]]))).toEqual(originalEnvironment);
    });
  });

  it('preserves the current public/local relay route while using an invocation API token', async () => {
    await withFixture(async () => {
      scope.patch({ HAPPIER_SERVER_URL: 'http://127.0.0.1:59999', HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:59999',
        HAPPIER_PUBLIC_SERVER_URL: 'https://public.example.test' });
      reloadConfiguration();
      const originalConfiguration = configuration;
      // Invocation API-token custody is synthetic and never persists to a profile.
      const token = `hap_v1_123e4567-e89b-42d3-a456-426614174000_${'A'.repeat(43)}`;
      await withCliApiToken(token, async () => {
        await startBootstrap('api-token-session', 'https://public.example.test');
      });
      expect(boundary.post).toHaveBeenCalledWith('http://127.0.0.1:59999/v1/auth/response', expect.anything(),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }));
      expect(configuration).toBe(originalConfiguration);
      expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBe('https://public.example.test');
    });
  });

  it('approves through the loopback SSH forward instead of an ambient public/local route', async () => {
    await withFixture(async home => {
      const relayUrl = `http://localhost:${await findAvailableLoopbackPort()}`;
      boundary.relayRuntimeUrl = relayUrl;
      await writeFile(configuration.settingsFile, JSON.stringify({ schemaVersion: 5, activeServerId: 'ambient-home', servers: {
        'ambient-home': { id: 'ambient-home', serverUrl: 'https://ambient.example.test',
          localServerUrl: 'http://127.0.0.1:59999', webappUrl: 'https://ambient-app.example.test' },
      } }));
      await provisionCredentials(home, 'ambient-home', 'ambient-fixture-bearer');
      scope.patch({ HAPPIER_SERVER_URL: 'http://127.0.0.1:59999', HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:59999',
        HAPPIER_PUBLIC_SERVER_URL: relayUrl });
      reloadConfiguration();
      await provisionCredentials(home, deriveServerIdFromUrl(relayUrl), 'loopback-fixture-bearer');
      const originalConfiguration = configuration;
      await startBootstrap('loopback-session', relayUrl, { relayRuntime: true });
      expect(boundary.post).toHaveBeenCalledWith(`${relayUrl}/v1/auth/response`, expect.anything(),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer loopback-fixture-bearer' }) }));
      expect(configuration).toBe(originalConfiguration);
      expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:59999');
    });
  });


  it('refuses required local approval with no selected Home credentials instead of borrowing the active bearer', async () => {
    await withFixture(async () => {
      await expect(startBootstrap('missing-credentials-session', 'https://missing.example.test', { requireLocalApproval: true }))
        .rejects.toMatchObject({ code: 'local_approval_required' });
      expect(boundary.post).not.toHaveBeenCalled();
    });
  });

});
