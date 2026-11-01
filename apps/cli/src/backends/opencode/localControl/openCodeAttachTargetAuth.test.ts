import { ChildProcess, type spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { expectTerminalNativeInvocation, terminalLauncherBoundary } from '@/testkit/process/terminalLauncher';

import {
  resolveOpenCodeAttachChildEnv,
  resolveOpenCodeAttachTargetAuthHeaders,
} from './openCodeAttachTargetAuth';

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

const ambientEnv: NodeJS.ProcessEnv = {
  OPENCODE_PASSWORD: 'operator-secret',
  OPENCODE_SERVER_USERNAME: 'reverse-proxy-user',
};

describe('OpenCode attach target authentication', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it.each([
    { ambientState: 'missing', managed: false, targetState: 'matching', operation: 'attach' },
    { ambientState: 'another-account', managed: false, targetState: 'matching', operation: 'attach' },
    { ambientState: 'another-account', managed: true, targetState: 'matching', operation: 'attach' },
    { ambientState: 'another-account', managed: true, targetState: 'missing', operation: 'attach' },
    { ambientState: 'another-account', managed: true, targetState: 'foreign', operation: 'attach' },
    { ambientState: 'another-account', managed: true, targetState: 'malformed', operation: 'attach' },
    { ambientState: 'another-account', managed: false, targetState: 'matching', operation: 'fork' },
    { ambientState: 'another-account', managed: true, targetState: 'matching', operation: 'fork' },
    { ambientState: 'another-account', managed: true, targetState: 'missing', operation: 'fork' },
    { ambientState: 'another-account', managed: true, targetState: 'shadowed', operation: 'attach' },
    { ambientState: 'another-account', managed: true, targetState: 'shadowed', operation: 'fork' },
    { ambientState: 'another-account', managed: true, targetState: 'shadowed', operation: 'owned-attach' },
  ] as const)(
    'native $operation honors exact pooled affinity: $ambientState, managed=$managed, target=$targetState', async ({ ambientState, managed, targetState, operation }) => {
      await withTempDir('opencode-native-attach-target-', async (root) => {
        vi.stubEnv('HAPPIER_HOME_DIR', root);
        vi.stubEnv('HAPPIER_OPENCODE_SERVER_STATE_PATH', join(root, 'ambient.json'));
        vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', '');
        vi.stubEnv('HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR', '');
        vi.resetModules();
        const pool = join(root, 'opencode', 'managed-servers');
        const { resolveOpenCodeManagedServerLaunchFingerprint } = await import('../server/openCodeManagedServerEnv');
        const { runOpenCodeProviderAttach } = await import('../attach/runOpenCodeProviderAttach');
        const { maybeUpdateOpenCodeSessionIdMetadata } = await import('../utils/opencodeSessionIdMetadata');
        const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
        const { openCodeProviderAttachOps } = await import('../attach/providerAttachOps');
        const fingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
          baseEnv: process.env,
          xdgRootDir: null, isolateConfig: false,
        });
        await mkdir(pool, { recursive: true });
        if (targetState !== 'missing') await writeFile(join(pool, `${fingerprint}.json`), JSON.stringify({
          baseUrl: 'http://127.0.0.1:4200', pid: 4200, startedAtMs: 1,
          launchEnvFingerprint: targetState === 'foreign' ? 'foreign-fingerprint' : fingerprint,
          authPassword: 'target-fixture-password', apiGeneration: 'v2',
        }));
        if (ambientState === 'another-account') {
          await writeFile(join(root, 'ambient.json'), JSON.stringify({
            baseUrl: 'http://127.0.0.1:4100', pid: 4100, startedAtMs: 1,
            authPassword: 'other-fixture-password', apiGeneration: 'v2',
          }));
        }
        const targetAuthorization = basic('opencode', 'target-fixture-password');
        const observedAuthorization: Array<string | null> = [];
        const observedUrls: string[] = [];
        let selectingManagedClient = false;
        // Only the real server's HTTP boundary and native OS spawn are substituted.
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const authorization = new Headers(init?.headers).get('Authorization');
          observedAuthorization.push(authorization);
          const url = String(input instanceof Request ? input.url : input);
          observedUrls.push(url);
          return selectingManagedClient || authorization === targetAuthorization
            ? new Response(JSON.stringify(url.includes('/fork')
              ? { data: { id: 'forked-native-target', location: { directory: root } } }
              : { version: '2.0.20', pid: 4200, urls: [], paths: {} }), { status: 200 })
            : new Response('{}', { status: 401 });
        }));
        let selectedFingerprint = fingerprint;
        if (managed && (targetState === 'matching' || targetState === 'shadowed')) {
          // The real client selects its ready server under the original launch context;
          // standalone attachment subsequently runs under another ambient account.
          await writeFile(join(root, 'ambient.json'), JSON.stringify({
            baseUrl: 'http://127.0.0.1:4200', pid: process.pid, startedAtMs: 1,
            launchEnvFingerprint: fingerprint, authPassword: 'target-fixture-password', apiGeneration: 'v2',
          }));
          selectingManagedClient = true;
          const { createOpenCodeServerRuntimeClient } = await import('../server/client');
          const { MessageBuffer } = await import('@/ui/ink/messageBuffer');
          const client = await createOpenCodeServerRuntimeClient({ directory: root, env: process.env, messageBuffer: new MessageBuffer() });
          try {
            const identity = client.getManagedServerIdentity();
            expect(identity?.baseUrl).toBe('http://127.0.0.1:4200');
            expect(identity?.launchEnvFingerprint).toBe(fingerprint);
            selectedFingerprint = identity!.launchEnvFingerprint!;
          } finally { await client.dispose(); }
          selectingManagedClient = false;
          observedAuthorization.length = 0;
          observedUrls.length = 0;
          await writeFile(join(root, 'ambient.json'), JSON.stringify({
            baseUrl: 'http://127.0.0.1:4100', pid: 4100, startedAtMs: 1,
            authPassword: 'other-fixture-password', apiGeneration: 'v2',
          }));
        }
        if (targetState === 'shadowed') {
          const foreignFingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
            baseEnv: { ...process.env, OPENCODE_AUTH_CONTENT: 'foreign-account-fixture' }, xdgRootDir: null, isolateConfig: false,
          });
          await writeFile(join(pool, `${foreignFingerprint}.json`), JSON.stringify({
            baseUrl: 'http://127.0.0.1:4200', pid: 4300, startedAtMs: 2,
            launchEnvFingerprint: foreignFingerprint, authPassword: 'foreign-retained-password', apiGeneration: 'v2',
          }));
        }
        const child = new ChildProcess();
        const spawnProcess = vi.fn(() => {
          terminalLauncherBoundary(child);
          setImmediate(() => child.emit('exit', 0, null));
          return child;
        });
        let metadata = createTestMetadata({ path: root, flavor: 'opencode' });
        await maybeUpdateOpenCodeSessionIdMetadata({
          getOpenCodeSessionId: () => 'native-target-session', backendMode: 'server',
          serverBaseUrl: managed ? null : 'http://127.0.0.1:4200', serverBaseUrlExplicit: !managed,
          managedServerLaunchFingerprint: managed ? selectedFingerprint : null,
          transcriptStorage: 'direct',
          lastPublished: { sessionId: null, backendMode: null, serverBaseUrl: null, serverBaseUrlExplicit: false },
          updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
        });
        if (targetState === 'malformed') metadata.agentRuntimeDescriptorV1 = {
          v: 1, providerId: 'opencode', provider: {
            backendMode: 'server', vendorSessionId: 'native-target-session',
            providerExtra: { v: 1, runtimeHandle: { backendMode: 'server', vendorSessionId: 'native-target-session', managedServerLaunchFingerprint: { invalid: true } } },
          },
        };
        if (operation === 'owned-attach') {
          const { createOpenCodeTuiSupervisor } = await import('./openCodeTuiSupervisor');
          const ownedChild = new ChildProcess();
          let ownedExitCode: number | null = null;
          Object.defineProperty(ownedChild, 'exitCode', { get: () => ownedExitCode });
          vi.spyOn(ownedChild, 'kill').mockImplementation(() => {
            ownedExitCode = 0;
            setImmediate(() => ownedChild.emit('exit', 0, null));
            return true;
          });
          const ownedSpawn = vi.fn(() => terminalLauncherBoundary(ownedChild));
          const supervisor = createOpenCodeTuiSupervisor({ command: 'opencode-fixture', commandArgs: [], env: {},
            spawnProcess: ownedSpawn as unknown as typeof spawn });
          const target = { baseUrl: 'http://127.0.0.1:4200', directory: root, sessionId: 'native-target-session',
            managedServerLaunchFingerprint: selectedFingerprint };
          await expect(supervisor.attach(target)).resolves.toBe(true);
          expect(observedAuthorization).toEqual([targetAuthorization]);
          await expectTerminalNativeInvocation(ownedSpawn.mock.calls, 'opencode-fixture',
            ['--server', target.baseUrl, '--session', target.sessionId, root],
            expect.objectContaining({ env: { OPENCODE_PASSWORD: 'target-fixture-password' } }));
          await supervisor.dispose();
          return;
        }
        if (operation === 'fork') {
          // Ambient context is an explicit different endpoint, so a wrong selection cannot
          // accidentally start a managed provider process in this boundary-only fixture.
          vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', 'http://127.0.0.1:4100');
          metadata.connectedServices = {
            v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'target-group', profileId: 'target-profile' } },
          };
          metadata.connectedServicesUpdatedAt = 123;
          const { openCodeProviderNativeForkHandler } = await import('../server/providerNativeForkHandler');
          const forkResult = openCodeProviderNativeForkHandler({
            credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            agentId: 'opencode', parentSessionId: 'parent-fixture', parentRawSession: { encryptionMode: 'plain' },
            parentMetadata: metadata, directory: root, forkPoint: { type: 'latest' }, targetSeqInclusive: 0,
          });
          if (targetState === 'missing') {
            await expect(forkResult).rejects.toMatchObject({ name: 'ProviderNativeForkFailedBeforeDispatchError' });
            expect(observedUrls).toEqual([]);
          } else {
            const result = await forkResult;
            expect(result?.vendorSessionId).toBe('forked-native-target');
            const { readOpenCodeSessionRuntimeHandleFromMetadata } = await import('../utils/opencodeSessionAffinity');
            expect(readOpenCodeSessionRuntimeHandleFromMetadata(result?.metadata)).toMatchObject({
              vendorSessionId: 'forked-native-target', managedServerLaunchFingerprint: managed ? fingerprint : null,
            });
            expect(observedUrls.length).toBeGreaterThan(0);
            expect(observedUrls.every((url) => new URL(url).origin === 'http://127.0.0.1:4200')).toBe(true);
            expect(observedUrls.some((url) => new URL(url).pathname === '/api/session/native-target-session/fork')).toBe(true);
            const { resolveForkInheritedOverridesFromMetadata } = await import('@/session/fork/resolveForkInheritedOverridesFromMetadata');
            const { createConnectedServiceForkLaunchContext } = await import('@/session/fork/connectedServiceForkLaunchContext');
            const inherited = resolveForkInheritedOverridesFromMetadata(metadata, 'opencode');
            const context = createConnectedServiceForkLaunchContext({ inherited, nowMs: () => 124, randomBytes: (length) => new Uint8Array(length).fill(1) });
            // This is the existing machine ingress merge, not a same-port or credential-validity claim.
            const childLaunch = { ...result?.spawn, ...inherited.spawn, ...context.spawn };
            expect(childLaunch).toMatchObject({
              resume: 'forked-native-target', connectedServices: metadata.connectedServices,
              connectedServiceMaterializationIdentityV1: context.materializationIdentity,
            });
            expect(context.materializationIdentity).not.toBeNull();
            expect(childLaunch.environmentVariables).toEqual(managed ? { HAPPIER_OPENCODE_BACKEND_MODE: 'server' } : {
              HAPPIER_OPENCODE_BACKEND_MODE: 'server', HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4200/', HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            });
          }
          return;
        }
        const eligibility = await openCodeProviderAttachOps.evaluateEligibility({
          sessionId: 'target-happier-session', metadata, currentMachineId: 'machine-target', sessionMachineId: 'machine-target', hasLocalAttachmentInfo: false,
        });
        if (targetState !== 'matching' && targetState !== 'shadowed') {
          expect(eligibility.eligible).toBe(false);
          await expect(runOpenCodeProviderAttach({
            sessionId: 'target-happier-session', metadata, command: 'opencode-fixture', commandArgs: [], env: {},
            spawnProcess: spawnProcess as unknown as typeof spawn,
          })).resolves.toBe(1);
          expect(spawnProcess).not.toHaveBeenCalled();
          expect(observedAuthorization).toEqual([]);
          return;
        }
        expect(eligibility.eligible).toBe(true);
        await expect(runOpenCodeProviderAttach({
          sessionId: 'target-happier-session',
          metadata,
          command: 'opencode-fixture', commandArgs: [], env: {},
          spawnProcess: spawnProcess as unknown as typeof spawn,
          // Session RPC is external to this process; native identity validation stays real.
          prepareProviderCliAttach: async ({ providerSessionId }) => ({ ok: true, providerSessionId }),
        })).resolves.toBe(0);
        expect(observedAuthorization).toEqual([targetAuthorization]);
        await expectTerminalNativeInvocation(spawnProcess.mock.calls, 'opencode-fixture',
          ['--server', managed ? 'http://127.0.0.1:4200' : 'http://127.0.0.1:4200/', '--session', 'native-target-session', root],
          expect.objectContaining({ env: { OPENCODE_PASSWORD: 'target-fixture-password' } }));
      });
    },
  );

  it('rejects external fingerprint traversal at the canonical pooled-state reader', async () => {
    await withTempDir('opencode-affinity-state-boundary-', async (root) => {
      vi.stubEnv('HAPPIER_HOME_DIR', root);
      vi.resetModules();
      const { readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort } = await import('../server/sharedManagedServer');
      await mkdir(join(root, 'opencode', 'managed-servers'), { recursive: true });
      await writeFile(join(root, 'escape.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:4200', pid: 4200, startedAtMs: 1 }));
      await expect(readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort('../../escape')).resolves.toBeNull();
    });
  });

  it('resolves exact retained credentials when legacy and client-tracked servers share a fingerprint', async () => {
    await withTempDir('opencode-pool-coexistence-', async root => {
      vi.stubEnv('HAPPIER_HOME_DIR', root);
      vi.stubEnv('HAPPIER_OPENCODE_SERVER_STATE_PATH', '');
      vi.resetModules();
      const { resolveSharedManagedOpenCodeServerStatePathForEnv } = await import('../server/sharedManagedServer');
      const { resolveOpenCodeAttachTargetAuthHeaders } = await import('./openCodeAttachTargetAuth');
      const currentPath = resolveSharedManagedOpenCodeServerStatePathForEnv();
      const fingerprint = basename(currentPath, '.json');
      for (const [directory, port, password] of [
        [join(root, 'opencode', 'managed-servers'), 4200, 'legacy-secret'],
        [join(root, 'opencode', 'managed-servers', 'clients-tracked'), 4300, 'tracked-secret'],
      ] as const) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${fingerprint}.json`), JSON.stringify({
          baseUrl: `http://127.0.0.1:${port}`, pid: port, startedAtMs: 1,
          launchEnvFingerprint: fingerprint, authPassword: password,
        }));
      }
      for (const [port, password] of [[4200, 'legacy-secret'], [4300, 'tracked-secret']] as const) {
        await expect(resolveOpenCodeAttachTargetAuthHeaders({
          baseUrl: `http://127.0.0.1:${port}`, managedServerLaunchFingerprint: fingerprint, env: ambientEnv,
        })).resolves.toEqual({ Authorization: basic('opencode', password) });
      }
    });
  });

  it.each(['missing', 'mismatched'] as const)('known credential affinity refuses ambient fallback: %s', async (stateKind) => {
    await withTempDir('opencode-known-auth-affinity-', async (root) => {
      vi.stubEnv('HAPPIER_HOME_DIR', root);
      vi.resetModules();
      const { resolveOpenCodeManagedServerLaunchFingerprint } = await import('../server/openCodeManagedServerEnv');
      const { resolveOpenCodeAttachChildEnv, resolveOpenCodeAttachTargetAuthHeaders } = await import('./openCodeAttachTargetAuth');
      const fingerprint = resolveOpenCodeManagedServerLaunchFingerprint({ baseEnv: process.env, xdgRootDir: null, isolateConfig: false });
      if (stateKind === 'mismatched') {
        const pool = join(root, 'opencode', 'managed-servers');
        await mkdir(pool, { recursive: true });
        await writeFile(join(pool, `${fingerprint}.json`), JSON.stringify({
          baseUrl: 'http://127.0.0.1:4300', pid: 4300, startedAtMs: 1,
          launchEnvFingerprint: fingerprint, authPassword: 'different-target-password',
        }));
      }
      const params = { baseUrl: 'http://127.0.0.1:4200', managedServerLaunchFingerprint: fingerprint, env: ambientEnv };
      await expect(resolveOpenCodeAttachChildEnv(params)).rejects.toThrow();
      await expect(resolveOpenCodeAttachTargetAuthHeaders(params)).rejects.toThrow();
    });
  });

  it('preserves the ambient reverse-proxy username for a remote target', async () => {
    await expect(resolveOpenCodeAttachTargetAuthHeaders({
      baseUrl: 'https://opencode.example.test',
      env: ambientEnv,
    })).resolves.toEqual({
      Authorization: basic('reverse-proxy-user', 'operator-secret'),
    });

    await expect(resolveOpenCodeAttachChildEnv({
      baseUrl: 'https://opencode.example.test',
      env: ambientEnv,
    })).resolves.toBe(ambientEnv);
  });

  it('preserves the ambient reverse-proxy username for a nonmatching loopback target', async () => {
    const state = {
      baseUrl: 'http://127.0.0.1:4100',
      pid: 123,
      startedAtMs: 1,
      authPassword: 'managed-secret',
    };
    const readManagedServerStateFn = async () => state;

    await expect(resolveOpenCodeAttachTargetAuthHeaders({
      baseUrl: 'http://127.0.0.1:4200',
      env: ambientEnv,
      readManagedServerStateFn,
    })).resolves.toEqual({
      Authorization: basic('reverse-proxy-user', 'operator-secret'),
    });

    await expect(resolveOpenCodeAttachChildEnv({
      baseUrl: 'http://127.0.0.1:4200',
      env: ambientEnv,
      readManagedServerStateFn,
    })).resolves.toBe(ambientEnv);
  });
});
