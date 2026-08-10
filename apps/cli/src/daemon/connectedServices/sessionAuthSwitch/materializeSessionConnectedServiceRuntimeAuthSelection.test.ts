import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import type { Credentials } from '@/persistence';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialScopes';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './materializeSessionConnectedServiceRuntimeAuthSelection';

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnSpy,
  };
});

describe('materializeSessionConnectedServiceRuntimeAuthSelection', () => {
  beforeEach(() => {
    spawnSpy.mockImplementation((_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        if (args[0] === 'find-generic-password') {
          child.stderr.write('missing keychain entry');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 44);
          return;
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    });
  });

  afterEach(() => {
    spawnSpy.mockReset();
  });

  it('preserves group fallback profile and generation from the current session selection env', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: 'anthropic',
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };

    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'anthropic',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
      },
    })).resolves.toMatchObject({
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      record,
    });
  });

  it('uses group metadata active profile when the normalized group binding omits optional profileId', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {},
      },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'anthropic',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: null,
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 8,
        },
      },
    })).resolves.toMatchObject({
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 8,
      record,
    });
    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'anthropic',
      profileId: 'backup',
    });
  });

  it('uses the previous child group active profile when unchanged group rematerialization omits profileId', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: 'anthropic',
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'anthropic',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: null,
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: null,
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
      },
    })).resolves.toMatchObject({
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: 'work',
      activeProfileId: 'primary',
      fallbackProfileId: 'fallback',
      generation: 7,
      record,
    });
  });

  it('prefers authoritative group metadata over stale current session selection env', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: 'anthropic',
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'stale-fallback',
              generation: 7,
            },
          ]),
        },
      },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'anthropic',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'anthropic',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fresh-fallback',
          generation: 8,
        },
      },
    })).resolves.toMatchObject({
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fresh-fallback',
      generation: 8,
      record,
    });
  });

  it('rejects a canonical credential revision mismatch before the Claude materializer writes provider state', async () => {
    const committedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const actualRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-pre-effect-revision-fence-'));
    const groupConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'work',
      'claude',
      'claude-config',
    );
    await mkdir(groupConfigDir, { recursive: true });
    await writeFile(join(groupConfigDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'credential-before-mismatch',
        expiresAt: 1,
        scopes: [CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE],
      },
    }));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'credential-that-must-not-be-written',
        refreshToken: 'refresh-that-must-not-be-written',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: actualRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {},
      },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    } as const;

    const outcome = await materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      api: api as unknown as ApiClient,
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 8,
        },
        expectedCredentialRevision: committedRevision,
      } as Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0]['input'] & Readonly<{
        expectedCredentialRevision: string;
      }>,
      processEnv: { HOME: tmpdir() },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    const credential = JSON.parse(await readFile(join(groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('credential-before-mismatch');
    expect(outcome).toMatchObject({
      message: 'connected_service_auth_generation_apply_failed:credential_revision_superseded',
    });
  });

  it('refreshes the active member source and shared group config dir when refreshing the same active profile', async () => {
    const credentialRevision = 'csr_6123456789ABCDEFGHJKMNPQRS' as const;
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-session-runtime-selection-refresh-'));
    const activeMemberConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'primary',
      'claude',
      'claude-config',
    );
    const groupConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'work',
      'claude',
      'claude-config',
    );
    await mkdir(activeMemberConfigDir, { recursive: true });
    await writeFile(join(activeMemberConfigDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale-access-placeholder',
        refreshToken: 'stale-refresh-placeholder',
        expiresAt: 1,
        scopes: [CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE],
      },
    }));
    await mkdir(groupConfigDir, { recursive: true });
    await writeFile(join(groupConfigDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale-group-access-placeholder',
        refreshToken: 'stale-group-refresh-placeholder',
        expiresAt: 1,
        scopes: [CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE],
      },
    }));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'refreshed-access-placeholder',
        refreshToken: 'refreshed-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        groupId: 'work',
        activeProfileId: 'primary',
        generation: 8,
      })),
    };
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    } as const;
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: 'claude-subscription',
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };

    const result = await materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'primary',
          fallbackProfileId: 'fallback',
          generation: 8,
        },
      },
      processEnv: { HOME: tmpdir() },
    });

    const materializedEnv = (result as { targetMaterializedEnv?: Record<string, string> }).targetMaterializedEnv;
    expect(materializedEnv?.CLAUDE_CONFIG_DIR).toBe(groupConfigDir);
    const credential = JSON.parse(await readFile(join(activeMemberConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('refreshed-access-placeholder');
    expect(credential.claudeAiOauth.accessToken).not.toBe('stale-access-placeholder');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    const groupCredential = JSON.parse(await readFile(join(groupConfigDir, '.credentials.json'), 'utf8'));
    expect(groupCredential.claudeAiOauth.accessToken).toBe('refreshed-access-placeholder');
    expect(groupCredential.claudeAiOauth.accessToken).not.toBe('stale-group-access-placeholder');
  });

  it('uses Claude catalog runtime selection materializer for group switches', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-session-runtime-selection-server-'));
    const credentialRevision = 'csr_7123456789ABCDEFGHJKMNPQRS' as const;
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        groupId: 'work',
        activeProfileId: 'backup',
        generation: 9,
      })),
    };
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    } as const;
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
        },
      },
    };

    const result = await materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 9,
        },
      },
      processEnv: { HOME: tmpdir() },
    });

    const materializedEnv = (result as { targetMaterializedEnv?: Record<string, string> }).targetMaterializedEnv;
    expect(result).toMatchObject({ credentialRevision });
    expect(materializedEnv).toEqual({
      CLAUDE_CONFIG_DIR: join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'claude-subscription',
        '__groups',
        'work',
        'claude',
        'claude-config',
      ),
    });
    const credential = JSON.parse(await readFile(join(materializedEnv!.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    expect(credential.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
  });
});
