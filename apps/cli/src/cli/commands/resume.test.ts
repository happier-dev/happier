import { beforeEach, describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accountSettingsParse, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { encodeBase64, encrypt } from '@/api/encryption';
import { readSessionAttachFromEnv } from '@/agent/runtime/sessionAttach';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { CommandHandler } from '@/cli/commandRegistry';
import { createPluginStateStore } from '@/plugins/store/state';

const { resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  resolveMergedContributionRegistryMock.mockImplementation(actual.resolveMergedContributionRegistry);
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
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

  it('fails closed when merged registry resolution fails during resume', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-registry-fail-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-registry-fail-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevCwd = process.cwd();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      resolveMergedContributionRegistryMock.mockRejectedValueOnce(new Error('merged registry failed'));

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

      const rawSession = {
        ...createSessionRecordFixture({
          id: 'sid_registry_fail_1',
          dataEncryptionKey: encodeBase64(envelope),
          metadata: encodeBase64(
            encrypt(sessionEncryptionKey, 'dataKey', {
              path: directory,
              host: 'test',
              flavor: 'codex',
              codexSessionId: 'codex_vendor_session_1',
            }),
          ),
          active: false,
          activeAt: 0,
        }),
      };

      const agentHandler: CommandHandler = vi.fn(async () => {});

      await expect(handleResumeCommand(['sid_registry_fail_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        resolveAgentHandlerFn: async () => agentHandler,
        chdirFn: (next: string) => process.chdir(next),
      })).rejects.toThrow('merged registry failed');

      expect(agentHandler).not.toHaveBeenCalled();
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

  it('resumes configured ACP sessions backed by a plugin provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-plugin-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-resume-plugin-root-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-plugin-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevCwd = process.cwd();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(
        join(pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify(
          {
            schemaVersion: 2,
            id: 'acme.resume',
            version: '1.0.0',
            displayName: 'Acme Resume',
            description: 'Plugin resume coverage',
            engines: { happier: '^0.2.0' },
            runtime: {
              apiVersion: 1,
              capabilities: ['providers', 'backends'],
            },
            targets: {
              daemon: {
                entry: './daemon.js',
              },
            },
            permissions: [],
            contributions: [
              {
                kind: 'provider',
                kindVersion: 1,
                id: 'acme.resume.provider',
                display: { name: 'Acme Resume Provider', tags: ['plugin'] },
                session: {
                  resume: {
                    supportLevel: 'supported',
                    vendorResumeIdField: 'acmeResumeSessionId',
                  },
                },
                ownedBackendIds: ['acme.resume.backend'],
              },
              {
                kind: 'backend',
                kindVersion: 1,
                id: 'acme.resume.backend',
                providerId: 'acme.resume.provider',
                runtimeKind: 'acp',
                capabilities: {},
                runtimeAdapters: [],
              },
            ],
          },
          null,
          2,
        ),
        'utf8',
      );
      // Plugin loader requires the declared daemon entry path to exist.
      await writeFile(
        join(pluginRoot, 'daemon.js'),
        'export default async function pluginDaemonEntry() { return null; }\n',
        'utf8',
      );

      const stateStore = createPluginStateStore({ happyHomeDir: home });
      await stateStore.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.resume': {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'unknown', diagnostics: [] },
            install: { mode: 'link', manifestVersion: '1.0.0', manifestDigest: null, installedPath: null },
            state: { enabled: true },
          },
        },
      });

      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
      };

      const vendorResumeId = 'plugin_vendor_resume_1';
      const rawSession = createSessionRecordFixture({
        id: 'sid_plugin_1',
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadata: JSON.stringify({
          path: directory,
          host: 'test',
          flavor: 'acp:acme.resume.backend',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: Date.now(),
            backendId: 'acme.resume.backend',
            title: 'Acme Resume Backend',
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            // Configured ACP sessions often publish a configured-backend provider id,
            // so resume eligibility must be able to rely on the provider-declared
            // vendorResumeIdField instead of only runtimeDescriptor.provider.providerSessionId.
            providerId: 'acp:acme.resume.backend',
            provider: {},
          },
          acmeResumeSessionId: vendorResumeId,
        }),
        active: false,
        activeAt: 0,
      });

      const dispatched: { args: string[] }[] = [];
      const agentHandler: CommandHandler = vi.fn(async (context) => {
        dispatched.push({ args: [...context.args] });
      });

      await handleResumeCommand(['sid_plugin_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6 }),
        resolveAgentHandlerFn: async () => agentHandler,
        resolveConfiguredAcpCatalogHandlerFn: async () => agentHandler,
        chdirFn: (next: string) => process.chdir(next),
      });

      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(dispatched[0]?.args[0]).toBe('acp-catalog');
      expect(dispatched[0]?.args).toContain('--backend');
      expect(dispatched[0]?.args).toContain('acme.resume.backend');
      expect(dispatched[0]?.args).toContain('--resume');
      expect(dispatched[0]?.args).toContain(vendorResumeId);
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
      await rm(pluginRoot, { recursive: true, force: true });
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
        selectResumableSessionIdFn: async () => ({ type: 'cancelled' }),
      });

      expect(fetchSessionByIdFn).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('cancel');
      expect(output).not.toContain('No resumable sessions found.');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints a "No resumable sessions" message when there are none in interactive mode', async () => {
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
        selectResumableSessionIdFn: async () => ({ type: 'none' }),
      });

      expect(fetchSessionByIdFn).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('No resumable sessions found.');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints the attach footer when interactive resume only finds active sessions', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
      };
      const activeSession = createSessionRecordFixture({
        id: 'sid_active_only_1',
        active: true,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'claude',
          path: '/tmp/active-only',
          machineId: 'machine-local',
        }),
      });
      const fetchSessionByIdFn = vi.fn(async () => {
        throw new Error('fetchSessionByIdFn should not be called');
      });

      await handleResumeCommand([], {
        readCredentialsFn: async () => credentials,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        fetchSessionByIdFn,
        fetchSessionsPageFn: async () => ({
          sessions: [activeSession],
          nextCursor: null,
          hasNext: false,
        }),
        canUseInkSelectorFn: () => true,
      });

      expect(fetchSessionByIdFn).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('No resumable sessions found.');
      expect(output).toContain('happier attach');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
