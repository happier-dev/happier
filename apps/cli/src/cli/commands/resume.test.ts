import { beforeEach, describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import {
  accountSettingsParse,
  buildConnectedServiceCredentialRecord,
  projectSessionMetadataForWire,
  sealAccountScopedBlobCiphertext,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import type { Credentials, Settings } from '@/persistence';
import { encodeBase64, encrypt } from '@/api/encryption';
import { readSessionAttachFromEnv } from '@/agent/runtime/sessionAttach';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { CommandHandler } from '@/cli/commandRegistry';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { waitForCondition } from '@/testkit/async/waitFor';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { acquireSessionRunnerLock, sessionRunnerLockPathForSessionId } from '@/daemon/sessionRunnerLock';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const nativeBoundary = vi.hoisted(() => ({ supportedHerdr: false, foregroundSpawn: vi.fn(), interceptForeground: false }));
// Only the installed executable's --version response is pinned. Files, sockets,
// runner/process custody, and every other OS command remain real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => nativeBoundary.interceptForeground
      ? nativeBoundary.foregroundSpawn(...args)
      : actual.spawn(...args)) as typeof actual.spawn,
    execFile: Object.assign(actual.execFile.bind(null), {
      [Symbol.for('nodejs.util.promisify.custom')]: async (
        file: string, args: readonly string[], options?: import('node:child_process').ExecFileOptions,
      ) => nativeBoundary.supportedHerdr && args[0] === '--version'
        ? { stdout: 'herdr 0.9.3', stderr: '' }
        : await promisify(actual.execFile)(file, [...args], options ?? {}),
    }),
  };
});
// A stopped controller has no session RPC endpoint. Keep real RPC orchestration
// underneath a promptly rejected relay transport rather than a test timeout.
vi.mock('socket.io-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => nativeBoundary.interceptForeground
    ? createApiSessionSocketStub({
      onConnect: socket => queueMicrotask(() => socket.trigger('connect')),
      emit: (event, values) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const acknowledge = values[1];
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'stopped controller has no RPC endpoint' });
      },
    })
    : actual.io(...args) };
});

import { handleResumeCommand } from './resume';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectPathRemoved(path: string): Promise<void> {
  await waitForCondition(async () => !(await pathExists(path)), {
    label: `removal of ${path}`,
    timeoutMs: 1_000,
    intervalMs: 25,
  });
  expect(await pathExists(path)).toBe(false);
}

describe('happier resume', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as any);

  beforeEach(() => {
    exitSpy.mockClear();
  });

  it('prints usage for --help without requiring authentication', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readCredentialsFn = vi.fn(async () => null);

    try {
      await handleResumeCommand(['--help'], {
        readCredentialsFn,
        fetchSessionByIdFn: async () => null,
      });

      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier resume');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it.each(['absent', 'live', 'foreign-pane', 'inactive-live', 'inactive-unknown'] as const)(
    'uses real local runner custody for a restored Herdr resume with stale active metadata (%s)',
    async (runner) => {
      await withTempDir('happier-herdr-resume-', async (home) => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SESSION_ATTACH_FILE', 'HERDR_BIN_PATH']);
        env.patch({
          HAPPIER_HOME_DIR: home, HAPPIER_SESSION_ATTACH_FILE: undefined,
          HERDR_BIN_PATH: join(home, 'isolated-unavailable-herdr'),
        });
        reloadConfiguration();
        nativeBoundary.supportedHerdr = true;
        const sessionId = 'sid_restored_herdr';
        const socketPath = join(home, 'unavailable-herdr.sock');
        const credentials: Credentials = {
          token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
        };
        const rawSession = createSessionRecordFixture({
          id: sessionId, active: !runner.startsWith('inactive-'), encryptionMode: 'plain',
          metadata: JSON.stringify(projectSessionMetadataForWire({
            flavor: 'claude', claudeSessionId: 'same-native-claude-session',
            machineId: 'machine-local', path: home,
            terminal: { mode: 'herdr', herdr: {
              sessionName: 'work', socketPath, paneId: 'managed', terminalId: 'old-terminal',
            } },
          })),
        });
        const lock = runner === 'live' || runner === 'inactive-live'
          ? await acquireSessionRunnerLock({ sessionId, happyHomeDir: home })
          : null;
        if (lock) expect(lock.ok).toBe(true);
        if (runner === 'inactive-unknown') {
          const lockPath = sessionRunnerLockPathForSessionId({ sessionId, happyHomeDir: home });
          if (!lockPath) throw new Error('Expected canonical runner lock path');
          await mkdir(dirname(lockPath), { recursive: true });
          await writeFile(lockPath, '{malformed', 'utf8');
        }
        // chdir is an OS boundary. Stop there, before any provider execution or model call.
        const osFailure = Object.assign(new Error('isolated directory admission denied'), { code: 'EACCES' });
        const chdirFn = vi.fn(() => { throw osFailure; });
        try {
          const result = handleResumeCommand([sessionId], {
            terminalRuntime: {
              mode: 'herdr', herdrSessionName: 'work', herdrSocketPath: socketPath,
              herdrPaneId: runner === 'foreign-pane' ? 'foreign' : 'managed',
              herdrTerminalId: 'restored-terminal',
            },
            readCredentialsFn: async () => credentials,
            fetchSessionByIdFn: async () => rawSession,
            readAccountSettingsFn: async () => accountSettingsParse({}),
            chdirFn,
            attachDeps: {
              readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
              readTerminalAttachmentInfoFn: async () => null,
            },
          });
          if (runner === 'absent') {
            await expect(result).rejects.toBe(osFailure);
            expect(chdirFn).toHaveBeenCalledWith(home);
          } else {
            await expect(result).rejects.not.toBe(osFailure);
            expect(chdirFn).not.toHaveBeenCalled();
          }
          expect(await readdir(join(home, 'tmp', 'session-attach')).catch(() => [])).toEqual([]);
        } finally {
          nativeBoundary.supportedHerdr = false;
          if (lock?.ok) await lock.release();
          env.restore();
          reloadConfiguration();
        }
      });
    },
  );

  it.each([
    { agent: 'claude', runner: 'absent' },
    { agent: 'opencode', runner: 'absent' },
    { agent: 'opencode', runner: 'live' },
    { agent: 'opencode', runner: 'unknown' },
    { agent: 'opencode', runner: 'stale-active' },
  ] as const)('opens a recorded local Herdr restoration candidate without fresh provider dispatch ($agent/$runner)', async ({ agent, runner }) => {
    await withTempDir('happier-herdr-cold-resume-', async (home) => {
      await withHerdrApi(async (api) => {
        api.panes.add('managed');
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HERDR_BIN_PATH', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']);
        env.patch({ HAPPIER_HOME_DIR: home, HERDR_BIN_PATH: join(home, 'isolated-herdr'), HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined });
        reloadConfiguration();
        nativeBoundary.supportedHerdr = true;
        nativeBoundary.interceptForeground = true;
        nativeBoundary.foregroundSpawn.mockReset();
        nativeBoundary.foregroundSpawn.mockImplementation(() => {
          const child = new EventEmitter();
          queueMicrotask(() => child.emit('exit', 0));
          return child;
        });
        const credentials: Credentials = { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) } };
        const sessionId = 'sid_cold_generic_resume';
        const rawSession = createSessionRecordFixture({
          id: sessionId, active: runner === 'stale-active', encryptionMode: 'plain',
          metadata: JSON.stringify(projectSessionMetadataForWire({
            flavor: agent, machineId: 'machine-local', path: home,
            ...(agent === 'claude' ? { claudeSessionId: 'same-native-session' } : {
              opencodeSessionId: 'same-native-session', opencodeBackendMode: 'server',
              opencodeServerBaseUrl: 'https://opencode.test/', opencodeServerBaseUrlExplicit: true,
            }),
            terminal: { mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath, paneId: 'managed', terminalId: 'old-terminal' } },
          })),
        });
        const lock = runner === 'live' ? await acquireSessionRunnerLock({ sessionId, happyHomeDir: home }) : null;
        if (lock) expect(lock.ok).toBe(true);
        if (runner === 'unknown') {
          const lockPath = sessionRunnerLockPathForSessionId({ sessionId, happyHomeDir: home });
          if (!lockPath) throw new Error('Expected canonical runner lock path');
          await mkdir(dirname(lockPath), { recursive: true });
          await writeFile(lockPath, '{malformed', 'utf8');
        }
        // A fresh-provider branch must fail at the real OS directory boundary,
        // before any provider execution. The intended path uses the real socket.
        const chdirFn = vi.fn(() => { throw new Error('unexpected fresh provider dispatch'); });
        try {
          const result = handleResumeCommand([sessionId], {
            readCredentialsFn: async () => credentials,
            fetchSessionByIdFn: async () => rawSession,
            readAccountSettingsFn: async () => accountSettingsParse({}), chdirFn,
            attachDeps: {
              readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
              readTerminalAttachmentInfoFn: async () => null,
            },
          });
          if (runner === 'live' || runner === 'unknown') {
            await expect(result).rejects.toThrow('stopped controller has no RPC endpoint');
            expect(nativeBoundary.foregroundSpawn).not.toHaveBeenCalled();
            expect(chdirFn).not.toHaveBeenCalled();
            return;
          }
          await result;
          expect(chdirFn).not.toHaveBeenCalled();
          expect(nativeBoundary.foregroundSpawn).toHaveBeenCalledWith(expect.any(String),
            ['terminal', 'attach', 'terminal_1'], expect.objectContaining({
              env: expect.objectContaining({ HERDR_SESSION: 'work', HERDR_SOCKET_PATH: api.socketPath }),
            }));
          expect(api.requests.some(request => request.method === 'pane.close' || request.method === 'layout.apply')).toBe(false);
        } finally {
          if (lock?.ok) await lock.release();
          nativeBoundary.supportedHerdr = false;
          nativeBoundary.interceptForeground = false;
          env.restore(); reloadConfiguration();
        }
      });
    });
  });

  it('attaches an active Happier session through the existing terminal attach path without vendor-resuming it', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const terminal = {
      mode: 'herdr' as const,
      requested: 'herdr' as const,
      herdr: { sessionName: 'main', socketPath: '/tmp/herdr.sock', terminalId: 'term-1' },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_active_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify(projectSessionMetadataForWire({
        flavor: 'claude',
        machineId: 'machine-local',
        path: '/tmp/project',
        terminal,
      })),
    });
    const runHerdrAttachFn = vi.fn(async () => 0);
    const resolveAgentHandlerFn = vi.fn(async () => vi.fn(async () => {}));

    await handleResumeCommand(['sid_active_1'], {
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn: async () => rawSession,
      readAccountSettingsFn: async () => accountSettingsParse({}),
      resolveAgentHandlerFn,
      attachDeps: {
        readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
        // With no local descriptor, this actual attach path must normalize the
        // additive wire selectors rather than obtain the host from local state.
        readTerminalAttachmentInfoFn: async () => null,
        runHerdrAttachFn,
      },
    });

    expect(runHerdrAttachFn).toHaveBeenCalledWith({ terminal });
    expect(resolveAgentHandlerFn).not.toHaveBeenCalled();
  });

  it('does not start a second agent when attachment to an active session fails', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const terminal = {
      mode: 'herdr' as const,
      requested: 'herdr' as const,
      herdr: { sessionName: 'main', socketPath: '/tmp/herdr.sock', terminalId: 'stale-term' },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_active_stale',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        claudeSessionId: 'vendor-resumable-id',
        machineId: 'machine-local',
        path: '/tmp/project',
        terminal,
      }),
    });
    const resolveAgentHandlerFn = vi.fn(async () => vi.fn(async () => {}));

    await expect(handleResumeCommand(['sid_active_stale'], {
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn: async () => rawSession,
      readAccountSettingsFn: async () => accountSettingsParse({}),
      resolveAgentHandlerFn,
      attachDeps: {
        readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
        readTerminalAttachmentInfoFn: async () => ({
          version: 1,
          sessionId: 'sid_active_stale',
          terminal,
          updatedAt: Date.now(),
        }),
        runHerdrAttachFn: async () => { throw new Error('Herdr terminal is no longer available'); },
      },
    })).rejects.toThrow('Herdr terminal is no longer available');

    expect(resolveAgentHandlerFn).not.toHaveBeenCalled();
  });

  it('creates an attach file and dispatches to the agent handler with --resume', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevCwd = process.cwd();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(11);
      const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'dataKey', machineKey, publicKey },
      };

      const sessionEncryptionKey = new Uint8Array(32).fill(5);
      const envelope = sealEncryptedDataKeyEnvelopeV1({
        dataKey: sessionEncryptionKey,
        recipientPublicKey: publicKey,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const vendorResumeId = 'codex_vendor_session_1';
      const rawSession = {
        ...createSessionRecordFixture({
          id: 'sid_1',
          dataEncryptionKey: encodeBase64(envelope),
          metadata: encodeBase64(
            encrypt(sessionEncryptionKey, 'dataKey', {
              path: directory,
              host: 'test',
              flavor: 'codex',
              codexSessionId: vendorResumeId,
            }),
          ),
          active: false,
          activeAt: 0,
        }),
      };

      const dispatched: { args: string[] }[] = [];
      const agentHandler: CommandHandler = vi.fn(async (context) => {
        dispatched.push({ args: [...context.args] });
        expect(await realpath(process.cwd())).toBe(await realpath(directory));

        const attach = await readSessionAttachFromEnv();
        expect(attach).not.toBeNull();
        expect(attach).toEqual({ encryptionMode: 'e2ee', encryptionVariant: 'dataKey', encryptionKey: sessionEncryptionKey });
      });

      await handleResumeCommand(['sid_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        resolveAgentHandlerFn: async () => agentHandler,
        chdirFn: (next: string) => process.chdir(next),
      });

      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(dispatched[0]?.args[0]).toBe('codex');
      expect(dispatched[0]?.args).toContain('--existing-session');
      expect(dispatched[0]?.args).toContain('sid_1');
      expect(dispatched[0]?.args).toContain('--resume');
      expect(dispatched[0]?.args).toContain(vendorResumeId);
      expect(process.env.HAPPIER_SESSION_ATTACH_FILE ?? '').toBe('');

      const attachDir = join(home, 'tmp', 'session-attach');
      const attachFiles = await readdir(attachDir).catch(() => []);
      expect(attachFiles).toEqual([]);
    } finally {
      try {
        process.chdir(prevCwd);
      } catch {
        // ignore
      }
      if (prevAttach === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = prevAttach;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports plaintext sessions by creating an attach payload without a data encryption key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-plain-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-plain-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevCwd = process.cwd();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
      };

      const vendorResumeId = 'claude_vendor_session_1';
      const rawSession = {
        ...createSessionRecordFixture({
          id: 'sid_plain_1',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadata: JSON.stringify({
            path: directory,
            host: 'test',
            flavor: 'claude',
            claudeSessionId: vendorResumeId,
          }),
          active: false,
          activeAt: 0,
        }),
      };

      const dispatched: { args: string[] }[] = [];
      const agentHandler: CommandHandler = vi.fn(async (context) => {
        dispatched.push({ args: [...context.args] });
        expect(await realpath(process.cwd())).toBe(await realpath(directory));

        const attach = await readSessionAttachFromEnv();
        expect(attach).toEqual({ encryptionMode: 'plain' });
      });

      await handleResumeCommand(['sid_plain_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        resolveAgentHandlerFn: async () => agentHandler,
        chdirFn: (next: string) => process.chdir(next),
      });

      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(dispatched[0]?.args[0]).toBe('claude');
      expect(dispatched[0]?.args).toContain('--existing-session');
      expect(dispatched[0]?.args).toContain('sid_plain_1');
      expect(dispatched[0]?.args).toContain('--resume');
      expect(dispatched[0]?.args).toContain(vendorResumeId);

      const attachDir = join(home, 'tmp', 'session-attach');
      const attachFiles = await readdir(attachDir).catch(() => []);
      expect(attachFiles).toEqual([]);
    } finally {
      try {
        process.chdir(prevCwd);
      } catch {
        // ignore
      }
      if (prevAttach === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = prevAttach;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('materializes connected-service auth from persisted Codex metadata before direct terminal resume dispatch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-connected-home-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-connected-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    const prevBindingsEnv = process.env.HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON;
    const prevIdentityEnv = process.env.HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON;
    const prevSelectionsEnv = process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON;
    const prevMaterializedKeysEnv = process.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON;
    const prevTargetRootEnv = process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT;
    const prevCwd = process.cwd();
    // Since 21060ed08d the Codex spawn hook admits App Server resumes only when the Codex CLI resolves.
    const codexBinDir = dirname(await createExecutableShim({
      dirPrefix: 'happier-resume-connected-codex-',
      fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
      contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    }));
    const pathEnv = createEnvKeyScope(['PATH']);
    pathEnv.patch({ PATH: [codexBinDir, process.env.PATH].filter(Boolean).join(delimiter) });

    const now = Date.now();
    const credentials = {
      token: 'token-connected',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(13) },
    } satisfies Credentials;
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const credentialRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'connected-access',
        refreshToken: 'connected-refresh',
        idToken: 'connected-id-token',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'connected-account',
        providerEmail: 'codex@example.test',
      },
    });
    const credentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: credentialRecord,
      randomBytes,
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const next = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && url.pathname === '/v1/account/encryption') {
          res.end(JSON.stringify({ mode: 'e2ee', updatedAt: now }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v2/connect/openai-codex/profiles') {
          res.end(JSON.stringify({
            serviceId: 'openai-codex',
            profiles: [{
              profileId: 'work',
              status: 'connected',
              kind: 'oauth',
              providerEmail: 'codex@example.test',
              providerAccountId: 'connected-account',
              expiresAt: now + 3_600_000,
            }],
          }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v2/connect/openai-codex/profiles/work/credential') {
          res.end(JSON.stringify({
            sealed: { format: 'account_scoped_v1', ciphertext: credentialCiphertext },
            metadata: {
              kind: 'oauth',
              providerEmail: 'codex@example.test',
              providerAccountId: 'connected-account',
              expiresAt: now + 3_600_000,
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
      });
      next.on('error', reject);
      next.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve connected-service fixture server address');
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_SERVER_URL = serverUrl;
      process.env.HAPPIER_WEBAPP_URL = serverUrl;
      reloadConfiguration();

      const connectedServices = {
        v: 1 as const,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'work',
          },
        },
      };
      const materializationIdentity = {
        v: 1 as const,
        id: 'csm_resume_codex_terminal',
        createdAtMs: 1234,
      };
      const vendorResumeId = 'codex_vendor_connected_1';
      const rawSession = {
        ...createSessionRecordFixture({
          id: 'sid_connected_1',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadata: JSON.stringify({
            path: directory,
            host: 'test',
            flavor: 'codex',
            codexSessionId: vendorResumeId,
            connectedServices,
            connectedServicesUpdatedAt: 5678,
            connectedServiceMaterializationIdentityV1: materializationIdentity,
          }),
          active: false,
          activeAt: 0,
        }),
      };

      const agentHandler: CommandHandler = vi.fn(async () => {
        const codexHome = process.env.CODEX_HOME;
        expect(codexHome).toBeTypeOf('string');
        expect(process.env.CODEX_SQLITE_HOME).toBe(codexHome);
        expect(JSON.parse(process.env.HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON ?? 'null')).toEqual(connectedServices);
        expect(JSON.parse(process.env.HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON ?? 'null')).toEqual(materializationIdentity);
        expect(JSON.parse(process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON ?? '[]')).toEqual([
          {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
            credentialRevision: null,
          },
        ]);
        expect(JSON.parse(process.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON ?? '[]')).toEqual([
          'CODEX_HOME',
          'CODEX_SQLITE_HOME',
        ]);
        const auth = JSON.parse(await readFile(join(codexHome!, 'auth.json'), 'utf8')) as Record<string, unknown>;
        expect(auth.access_token).toBe('connected-access');
      });

      await handleResumeCommand(['sid_connected_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({
          schemaVersion: 6,
          codexBackendMode: 'appServer',
          connectedServicesDefaultAuthByAgentIdV1: {
            v: 1,
            bindingsByAgentId: {
              codex: {
                v: 1,
                bindingsByServiceId: {
                  'openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'different-current-default',
                  },
                },
              },
            },
          },
          connectedServicesProviderStateSharingSettingsV1: {
            defaults: { configMode: 'linked', stateMode: 'isolated' },
            byAgentId: {
              codex: { stateMode: 'isolated' },
            },
          },
        }),
        resolveAgentHandlerFn: async () => agentHandler,
        chdirFn: (next: string) => process.chdir(next),
      });

      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(process.env.CODEX_HOME).toBe(prevCodexHome);
      expect(process.env.CODEX_SQLITE_HOME).toBe(prevCodexSqliteHome);
      expect(process.env.HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON).toBe(prevBindingsEnv);
      expect(process.env.HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON).toBe(prevIdentityEnv);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      try {
        process.chdir(prevCwd);
      } catch {
        // ignore
      }
      if (prevAttach === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = prevAttach;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = prevCodexSqliteHome;
      if (prevBindingsEnv === undefined) delete process.env.HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON;
      else process.env.HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON = prevBindingsEnv;
      if (prevIdentityEnv === undefined) delete process.env.HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON;
      else process.env.HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON = prevIdentityEnv;
      if (prevSelectionsEnv === undefined) delete process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON;
      else process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON = prevSelectionsEnv;
      if (prevMaterializedKeysEnv === undefined) delete process.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON;
      else process.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON = prevMaterializedKeysEnv;
      if (prevTargetRootEnv === undefined) delete process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT;
      else process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT = prevTargetRootEnv;
      pathEnv.restore();
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
      await rm(codexBinDir, { recursive: true, force: true });
    }
  });

  it('cleans up connected-service materialization when direct resume fails before handler dispatch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-connected-cleanup-home-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-connected-cleanup-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const prevCodexBackendMode = process.env.HAPPIER_CODEX_BACKEND_MODE;
    const prevCodexAcpBin = process.env.HAPPIER_CODEX_ACP_BIN;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevCwd = process.cwd();

    const now = Date.now();
    const credentials = {
      token: 'token-connected-cleanup',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(17) },
    } satisfies Credentials;
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const credentialRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'cleanup-access',
        refreshToken: 'cleanup-refresh',
        idToken: 'cleanup-id-token',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'cleanup-account',
        providerEmail: 'cleanup@example.test',
      },
    });
    const credentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: credentialRecord,
      randomBytes,
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const next = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && url.pathname === '/v1/account/encryption') {
          res.end(JSON.stringify({ mode: 'e2ee', updatedAt: now }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v2/connect/openai-codex/profiles') {
          res.end(JSON.stringify({
            serviceId: 'openai-codex',
            profiles: [{
              profileId: 'work',
              status: 'connected',
              kind: 'oauth',
              providerEmail: 'cleanup@example.test',
              providerAccountId: 'cleanup-account',
              expiresAt: now + 3_600_000,
            }],
          }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v2/connect/openai-codex/profiles/work/credential') {
          res.end(JSON.stringify({
            sealed: { format: 'account_scoped_v1', ciphertext: credentialCiphertext },
            metadata: {
              kind: 'oauth',
              providerEmail: 'cleanup@example.test',
              providerAccountId: 'cleanup-account',
              expiresAt: now + 3_600_000,
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
      });
      next.on('error', reject);
      next.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve connected-service fixture server address');
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'work',
        },
      },
    };
    const materializationIdentity = {
      v: 1 as const,
      id: 'csm_resume_codex_cleanup',
      createdAtMs: 1234,
    };
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir: join(home, 'daemon', 'connected-services', 'materialized'),
      agentId: 'codex',
      materializationKey: materializationIdentity.id,
      materializationIdentity,
    });
    const rawSession = {
      ...createSessionRecordFixture({
        id: 'sid_connected_cleanup_1',
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadata: JSON.stringify({
          path: directory,
          host: 'test',
          flavor: 'codex',
          codexSessionId: 'codex_vendor_connected_cleanup_1',
          connectedServices,
          connectedServicesUpdatedAt: 5678,
          connectedServiceMaterializationIdentityV1: materializationIdentity,
        }),
        active: false,
        activeAt: 0,
      }),
    };
    const agentHandler: CommandHandler = vi.fn(async () => {});

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_SERVER_URL = serverUrl;
      process.env.HAPPIER_WEBAPP_URL = serverUrl;
      process.env.HAPPIER_CODEX_BACKEND_MODE = 'acp';
      process.env.HAPPIER_CODEX_ACP_BIN = join(home, 'missing-codex-acp');
      reloadConfiguration();

      await expect(handleResumeCommand(['sid_connected_cleanup_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({
          schemaVersion: 6,
          codexBackendMode: 'acp',
          connectedServicesProviderStateSharingSettingsV1: {
            defaults: { configMode: 'linked', stateMode: 'isolated' },
            byAgentId: {
              codex: { stateMode: 'isolated' },
            },
          },
        }),
        resolveAgentHandlerFn: async () => agentHandler,
        chdirFn: (next: string) => process.chdir(next),
      })).rejects.toThrow(/Codex ACP is enabled/);

      expect(agentHandler).not.toHaveBeenCalled();
      await expectPathRemoved(materializedRoot);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      try {
        process.chdir(prevCwd);
      } catch {
        // ignore
      }
      if (prevAttach === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = prevAttach;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      if (prevCodexBackendMode === undefined) delete process.env.HAPPIER_CODEX_BACKEND_MODE;
      else process.env.HAPPIER_CODEX_BACKEND_MODE = prevCodexBackendMode;
      if (prevCodexAcpBin === undefined) delete process.env.HAPPIER_CODEX_ACP_BIN;
      else process.env.HAPPIER_CODEX_ACP_BIN = prevCodexAcpBin;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats interactive cancellation as a cancel (not as "no resumable sessions")', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
      };

      const fetchSessionByIdFn = vi.fn(async () => {
        throw new Error('fetchSessionByIdFn should not be called');
      });

      await handleResumeCommand([], {
        readCredentialsFn: async () => credentials,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        fetchSessionByIdFn,
        canUseInkSelectorFn: () => true,
        selectContinuableSessionIdFn: async () => ({ type: 'cancelled' }),
      });

      expect(fetchSessionByIdFn).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('cancel');
      expect(output).not.toContain('No sessions available to continue from here.');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints a no-sessions message when there are none in interactive mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
      };

      const fetchSessionByIdFn = vi.fn(async () => {
        throw new Error('fetchSessionByIdFn should not be called');
      });

      await handleResumeCommand([], {
        readCredentialsFn: async () => credentials,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        fetchSessionByIdFn,
        canUseInkSelectorFn: () => true,
        selectContinuableSessionIdFn: async () => ({ type: 'none' }),
      });

      expect(fetchSessionByIdFn).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('No sessions available to continue from here.');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
