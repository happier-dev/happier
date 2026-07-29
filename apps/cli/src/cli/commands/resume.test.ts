import { beforeEach, describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accountSettingsParse,
  buildConnectedServiceCredentialRecord,
  deserializeSessionModelSelectionV1,
  ProviderConnectionIdSchema,
  sealAccountScopedBlobCiphertext,
  sealEncryptedDataKeyEnvelopeV1,
  sealSessionOwnerMetadataV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { encodeBase64, encrypt } from '@/api/encryption';
import { readSessionAttachFromFile } from '@/agent/runtime/sessionAttach';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { CommandHandler } from '@/cli/commandRegistry';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import * as persistenceModule from '@/persistence';
import * as authModule from '@/ui/auth';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as daemonEnsureModule from '@/daemon/ensureDaemon';
import * as daemonControlClientModule from '@/daemon/controlClient';

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

import { handleResumeCliCommand, handleResumeCommand } from './resume';

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
        expect(process.env.HAPPIER_SESSION_ATTACH_FILE).toBe(prevAttach);
        expect(context.directSessionLaunch?.sessionAttachFilePath).toEqual(expect.any(String));
        const attach = await readSessionAttachFromFile(context.directSessionLaunch!.sessionAttachFilePath!);
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

  it('rejects a stale linked vendor identity before resolving or invoking the Agent handler', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_stale_linked_antigravity_1',
      encryptionMode: 'plain',
      dataEncryptionKey: null,
      metadata: JSON.stringify({
        path: '/tmp',
        host: 'test',
        flavor: 'antigravity',
        antigravitySessionId: 'stale-conversation',
        externalSessionV1: {
          v: 1,
          agentId: 'antigravity',
          machineId: 'machine-1',
          remoteSessionId: 'conversation-1',
          source: {
            kind: 'antigravityCliPrint',
            brainDir: '/tmp/antigravity-brain',
          },
          qualifiedIdentity: {
            v: 1,
            agent: {
              pluginId: 'happier.agent.antigravity',
              localId: 'antigravity',
            },
            source: {
              kind: 'antigravityCliPrint',
              contractVersion: 1,
            },
          },
        },
      }),
      active: false,
      activeAt: 0,
    });
    const resolveAgentHandlerFn = vi.fn(async () => vi.fn(async () => {}));

    await expect(handleResumeCommand(['sid_stale_linked_antigravity_1'], {
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn: async () => rawSession,
      readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6 }),
      resolveContributionRegistryFn: async () => ({
        agentDefinitionsById: new Map([
          ['antigravity', {
            id: 'antigravity',
            identity: {
              pluginId: 'happier.agent.antigravity',
              localId: 'antigravity',
            },
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {},
            richDefinition: {
              provenance: 'first_party',
              definition: {
                capabilities: { surfaces: ['terminal', 'externalSessions'] },
                surfaces: {
                  externalSession: {
                    sources: [{ sourceKind: 'antigravityCliPrint' }],
                  },
                },
              },
            },
          }],
        ]) as unknown as ResolvedContributionRegistry['agentDefinitionsById'],
      }),
      resolveAgentHandlerFn,
    })).rejects.toThrow('linked_session_identity_unverified');

    expect(resolveAgentHandlerFn).not.toHaveBeenCalled();
  });

  it('restores layout-v1 owner Provider state and fails closed on unreadable owner metadata', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-provider-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-provider-dir-'));
    const previousHome = process.env.HAPPIER_HOME_DIR;
    const previousAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const previousCwd = process.cwd();
    const credentials = {
      token: 'native-credentials-deliberately-present',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
    } satisfies Credentials;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: directory,
        host: 'test',
        flavor: 'codex',
      },
      nativeSession: {
        codexSessionId: 'codex_provider_vendor_1',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          providerSessionId: 'codex_provider_vendor_1',
        },
      },
      runtime: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 123,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_gateway',
            modelId: 'vendor/model',
          },
        },
        providerBindingV1: {
          v: 1,
          connectionId: 'pc_gateway',
          contributionKey: 'acme.gateway/gateway',
          connectionRevision: 1,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'gateway',
          compatibilityFingerprint: 'compatibility:v1:one',
          bindingSecurityFingerprint: 'binding-security:v1:one',
          displaySnapshot: {
            providerName: 'Gateway',
            connectionName: 'Gateway',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
          },
        },
      },
    });
    const rawSession = createSessionRecordFixture({
      id: 'sid_provider_resume_1',
      encryptionMode: 'plain',
      dataEncryptionKey: null,
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        summary: { text: 'Shared resume title', updatedAt: 123 },
      }),
      ownerMetadata: sealSessionOwnerMetadataV1({
        material: { type: 'legacy', secret: credentials.encryption.secret },
        ownerMetadata,
        randomBytes: deterministicRandomBytesFactory(),
      }),
      active: false,
      activeAt: 0,
    });
    const confirmProviderChange = vi.fn(async () => true);
    const agentHandler: CommandHandler = vi.fn(async (context) => {
      const flagIndex = context.args.indexOf('--model-selection-v1');
      expect(flagIndex).toBeGreaterThan(0);
      expect(deserializeSessionModelSelectionV1(context.args[flagIndex + 1]!)).toEqual({
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      });
      const confirm = context.directSessionLaunch?.confirmProviderSecurityChange;
      expect(confirm).toBeTypeOf('function');
      await expect(confirm!({
        v: 1,
        sessionId: 'sid_provider_resume_1',
        connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
        previousBindingSecurityFingerprint: 'binding-security:v1:one',
        nextBindingSecurityFingerprint: 'binding-security:v1:two',
      })).resolves.toBe(true);
    });

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();
      await handleResumeCommand(['sid_provider_resume_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        resolveAgentHandlerFn: async () => agentHandler,
        promptConfirmYesNoFn: confirmProviderChange,
        chdirFn: (next: string) => process.chdir(next),
      });
      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(confirmProviderChange).toHaveBeenCalledWith(
        expect.stringContaining('Gateway'),
        { default: 'no' },
      );

      const unreadableAgentHandler = vi.fn(async () => {});
      await expect(handleResumeCommand(['sid_provider_resume_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => ({
          ...rawSession,
          ownerMetadata: 'not-owner-ciphertext',
        }),
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'acp' }),
        resolveAgentHandlerFn: async () => unreadableAgentHandler,
        chdirFn: (next: string) => process.chdir(next),
      })).rejects.toThrow('Failed to decrypt session metadata');
      expect(unreadableAgentHandler).not.toHaveBeenCalled();
    } finally {
      try { process.chdir(previousCwd); } catch {}
      if (previousAttach === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttach;
      if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = previousHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('presents an invalid persisted Provider binding as a bounded actionable refusal', async () => {
    const credentials: Credentials = {
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_provider_resume_invalid',
      encryptionMode: 'plain',
      dataEncryptionKey: null,
      metadata: JSON.stringify({
        path: tmpdir(),
        host: 'test',
        flavor: 'codex',
        codexSessionId: 'codex_provider_vendor_invalid',
        providerBindingV1: { v: 1, connectionId: 'pc_gateway' },
      }),
      active: false,
      activeAt: 0,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handleResumeCliCommand({
      args: ['resume', 'sid_provider_resume_invalid'],
      rawArgv: ['happier', 'resume', 'sid_provider_resume_invalid'],
      terminalRuntime: null,
    }, {
      readCredentialsFn: async () => credentials,
      readAccountSettingsFn: async () => accountSettingsParse({}),
      fetchSessionByIdFn: async () => rawSession,
      resolveContributionRegistryFn: async () => null,
    })).rejects.toThrow('process.exit(1)');

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('provider_binding_changed');
    expect(output).toContain('Review the Provider connection and restart the session');
    expect(output).toContain('pc_gateway');
    expect(exitSpy).toHaveBeenCalledWith(1);
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
            claudeTranscriptPath: join(directory, `${vendorResumeId}.jsonl`),
          }),
          active: false,
          activeAt: 0,
        }),
      };

      const dispatched: { args: string[] }[] = [];
      const agentHandler: CommandHandler = vi.fn(async (context) => {
        dispatched.push({ args: [...context.args] });
        expect(await realpath(process.cwd())).toBe(await realpath(directory));

        const attach = await readSessionAttachFromFile(context.directSessionLaunch!.sessionAttachFilePath!);
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
          createPluginManifestV2Fixture({
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
            contributes: [
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
	                agentId: 'acme.resume.provider',
                engine: {
                  kind: 'acp',
                  transport: {
                    kind: 'stdio',
                    launch: {
                      kind: 'executable',
                      command: 'acme-resume',
                    },
                  },
                  ux: {
                    title: 'Acme Resume Backend',
                  },
                },
                capabilities: {},
                surfaceHandlers: [],
              },
            ],
          }),
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
	        resolveContributionRegistryFn: async () => ({
	          agentDefinitionsById: new Map([
	            ['acme.resume.backend', {
	              id: 'acme.resume.backend',
	              provenance: 'external',
	              source: { kind: 'path' },
	              definition: {},
	              richDefinition: {
	                provenance: 'external',
	                definition: {
	                  session: {
	                    resume: {
	                      supportLevel: 'supported',
	                      vendorResumeIdField: 'acmeResumeSessionId',
	                    },
	                  },
	                },
	              },
	            }],
	          ]) as unknown as ResolvedContributionRegistry['agentDefinitionsById'],
	        }),
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

    const now = Date.now();
    const credentials: Credentials = {
      token: 'token-connected',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(13) },
    };
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
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
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

      const agentHandler: CommandHandler = vi.fn(async (context) => {
        const resolveEnvironment = context.directSessionLaunch?.resolveConnectedServiceEnvironment;
        expect(resolveEnvironment).toBeTypeOf('function');
        const scoped = await resolveEnvironment!(context.directSessionLaunch?.connectedServices ?? null);
        expect(scoped).not.toBeNull();
        const codexHome = scoped?.environment.CODEX_HOME;
        expect(codexHome).toBeTypeOf('string');
        expect(process.env.CODEX_HOME).toBe(prevCodexHome);
        expect(JSON.parse(scoped?.environment.HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON ?? 'null')).toEqual(connectedServices);
        expect(JSON.parse(scoped?.environment.HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON ?? 'null')).toEqual({
          v: 1,
          id: materializationIdentity.id,
          createdAt: materializationIdentity.createdAtMs,
        });
        expect(JSON.parse(scoped?.environment.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON ?? '[]')).toEqual([
          {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          },
        ]);
        expect(JSON.parse(scoped?.environment.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON ?? '[]')).toEqual([
          'CODEX_HOME',
        ]);
        const auth = JSON.parse(await readFile(join(codexHome!, 'auth.json'), 'utf8')) as Record<string, unknown>;
        expect(auth.access_token).toBe('connected-access');
        await scoped?.cleanupOnExit?.();
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
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails direct terminal resume typed instead of using raw auth-group CAS without the daemon switch owner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-group-owner-home-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-group-owner-dir-'));
    const previousHome = process.env.HAPPIER_HOME_DIR;
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const previousCwd = process.cwd();
    let rawCasRequests = 0;
    const restoreSpies: Array<() => void> = [];

    const server = await new Promise<Server>((resolve, reject) => {
      const next = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && url.pathname === '/v3/connect/openai-codex/groups/codex-main') {
          res.end(JSON.stringify({
            group: {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'codex-main',
              displayName: 'Codex main',
              policy: { v: 1, strategy: 'priority', autoSwitch: true },
              activeProfileId: 'primary',
              generation: 5,
              runtimeStateRevision: 0,
              state: {},
              createdAt: 1,
              updatedAt: 2,
              members: [
                {
                  v: 1,
                  serviceId: 'openai-codex',
                  groupId: 'codex-main',
                  profileId: 'primary',
                  priority: 1,
                  enabled: true,
                  state: {},
                  createdAt: 1,
                  updatedAt: 2,
                },
                {
                  v: 1,
                  serviceId: 'openai-codex',
                  groupId: 'codex-main',
                  profileId: 'backup',
                  priority: 2,
                  enabled: true,
                  state: {},
                  createdAt: 1,
                  updatedAt: 2,
                },
              ],
            },
          }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v2/connect/openai-codex/profiles') {
          res.end(JSON.stringify({
            serviceId: 'openai-codex',
            profiles: [
              { profileId: 'primary', status: 'needs_reauth', kind: 'oauth' },
              { profileId: 'backup', status: 'connected', kind: 'oauth' },
            ],
          }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v3/connect/openai-codex/groups/codex-main/active-profile') {
          rawCasRequests += 1;
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'raw_cas_must_remain_unreachable' }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
      });
      next.on('error', reject);
      next.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve fixture server address');

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
      process.env.HAPPIER_WEBAPP_URL = process.env.HAPPIER_SERVER_URL;
      reloadConfiguration();

      const connectedServices = {
        v: 1 as const,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected' as const,
            selection: 'group' as const,
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      };
      const rawSession = createSessionRecordFixture({
        id: 'sid_group_owner',
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadata: JSON.stringify({
          path: directory,
          host: 'test',
          flavor: 'codex',
          codexSessionId: 'codex_vendor_group_owner',
          connectedServices,
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_resume_group_owner',
            createdAtMs: 1234,
          },
        }),
        active: false,
        activeAt: 0,
      });
      const credentials: Credentials = {
        token: 'token-group-owner',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(13) },
      };
      const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
      const ensureMachineSpy = vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-group-owner' } as never);
      const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
        source: 'none',
        settings: accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'appServer' }),
        settingsVersion: 0,
        loadedAtMs: Date.now(),
        whenRefreshed: null,
      } as never);
      const ensureDaemonSpy = vi.spyOn(
        daemonEnsureModule,
        'ensureDaemonRunningForSessionCommand',
      ).mockResolvedValue(undefined);
      const foregroundAdmissionSpy = vi.spyOn(
        daemonControlClientModule,
        'admitDaemonForegroundAgentRuntime',
      ).mockResolvedValue({
        ok: true,
        capability: {
          attemptId: 'attempt-resume-group-owner',
          tokenFilePath: '/private/foreground-token.json',
          descriptor: {
            v: 1,
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            backendId: 'codex',
            generation: 'generation-1',
            factoryControls: {
              continuation: false,
              goals: false,
              catalog: false,
              usageLimitRecovery: false,
            },
          },
        },
        launchPolicy: {
          reservedEnvironmentVariableNames: [],
          profileSecretRequirementNamesMissingBinding: [],
        },
      } as never);
      const foregroundReleaseSpy = vi.spyOn(
        daemonControlClientModule,
        'releaseDaemonForegroundAgentRuntime',
      ).mockResolvedValue(undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      restoreSpies.push(
        () => readCredentialsSpy.mockRestore(),
        () => ensureMachineSpy.mockRestore(),
        () => bootstrapSpy.mockRestore(),
        () => ensureDaemonSpy.mockRestore(),
        () => foregroundAdmissionSpy.mockRestore(),
        () => foregroundReleaseSpy.mockRestore(),
        () => errorSpy.mockRestore(),
      );

      await expect(handleResumeCommand(['sid_group_owner'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        readAccountSettingsFn: async () => accountSettingsParse({ schemaVersion: 6, codexBackendMode: 'appServer' }),
        chdirFn: (next: string) => process.chdir(next),
      })).rejects.toThrow('process.exit(1)');

      expect(foregroundAdmissionSpy).toHaveBeenCalledTimes(1);
      expect(foregroundReleaseSpy).toHaveBeenCalledTimes(1);
      expect(rawCasRequests).toBe(0);
      const output = errorSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Connected service auth group switch coordinator unavailable (openai-codex/codex-main)');
      expect(output).not.toContain('The Agent runtime cannot use this Provider binding.');
      expect(output).not.toContain('provider_agent_runtime_unsupported');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(await readdir(join(home, 'tmp', 'session-attach')).catch(() => [])).toEqual([]);
    } finally {
      for (const restore of restoreSpies.reverse()) restore();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      try {
        process.chdir(previousCwd);
      } catch {
        // ignore
      }
      if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = previousHome;
      if (previousServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = previousServerUrl;
      if (previousWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
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
