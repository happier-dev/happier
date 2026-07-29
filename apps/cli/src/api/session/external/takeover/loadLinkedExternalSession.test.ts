import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const fetchSessionByIdMock = vi.fn();
const tryDecryptSessionOwnerMetadataViewMock = vi.fn();
const {
  canonicalizeLinkedExternalSessionSourceMock,
  resolveExternalSessionLinkIdentityMock,
} = vi.hoisted(() => ({
  canonicalizeLinkedExternalSessionSourceMock: vi.fn(),
  resolveExternalSessionLinkIdentityMock: vi.fn(),
}));
const temporaryRoots = new Set<string>();

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionOwnerMetadataView: (...args: unknown[]) =>
    tryDecryptSessionOwnerMetadataViewMock(...args),
}));

vi.mock('@/agent/runtime/bridges/session/externalSessionSourceCanonicalization', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/agent/runtime/bridges/session/externalSessionSourceCanonicalization')
  >();
  canonicalizeLinkedExternalSessionSourceMock.mockImplementation(
    actual.canonicalizeLinkedExternalSessionSource,
  );
  resolveExternalSessionLinkIdentityMock.mockImplementation(
    actual.resolveExternalSessionLinkIdentity,
  );
  return {
    ...actual,
    canonicalizeLinkedExternalSessionSource:
      (...args: unknown[]) => canonicalizeLinkedExternalSessionSourceMock(...args),
    resolveExternalSessionLinkIdentity:
      (...args: unknown[]) => resolveExternalSessionLinkIdentityMock(...args),
  };
});

import {
  loadLinkedExternalSession,
  loadPersistedLinkedExternalSession,
} from './loadLinkedExternalSession';

describe('loadLinkedExternalSession', () => {
  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(),
        pluginIds: [
          'happier.agent.claude',
          'happier.agent.codex',
          'happier.agent.ohmypi',
          'happier.agent.opencode',
        ],
      }),
    });
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
    runtimeRegistryLease = null;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads persisted linked identity without resolving an Agent runtime surface', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_persisted_only',
      archivedAt: 3_000,
    });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        source: {
          kind: 'opencodeServer',
          directory: '/repo',
        },
        linkedAtMs: 1_000,
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 2_000,
        },
      },
    });

    await expect(loadPersistedLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1]),
        },
      },
      sessionId: 'sess_persisted_only',
      machineId: 'machine_1',
    })).resolves.toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        linkGeneration: '1000',
        rawSession: expect.objectContaining({
          id: 'sess_persisted_only',
          archivedAt: 3_000,
        }),
      }),
    });
    expect(canonicalizeLinkedExternalSessionSourceMock).not.toHaveBeenCalled();
    expect(resolveExternalSessionLinkIdentityMock).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all([...temporaryRoots].map(
      (root) => rm(root, { recursive: true, force: true }),
    ));
    temporaryRoots.clear();
  });

  it('loads legacy directSessionV1 metadata as a canonical linked external session', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/claude-config');
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_legacy_direct' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude-config',
          projectId: 'project-legacy',
        },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_legacy_direct',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        metadata: expect.objectContaining({
          externalSessionV1: expect.objectContaining({
            remoteSessionId: 'claude-session',
          }),
        }),
      }),
    });
  });

  it('projects an exact hosted owner into an in-memory follow identity', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_hosted',
      currentStorageState: 'hosted',
    });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_hosted',
      path: '/repo',
    });

    const result = await loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_hosted',
      machineId: 'machine_1',
      expectedHostedIdentity: {
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_hosted',
        source: { kind: 'codexHome', home: 'user' },
      },
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        rawSession: expect.objectContaining({ id: 'sess_hosted' }),
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_hosted',
        linkGeneration: 'sess_hosted',
        metadata: expect.objectContaining({
          externalSessionV1: expect.objectContaining({
            agentId: 'codex',
            machineId: 'machine_1',
            remoteSessionId: 'thread_hosted',
          }),
        }),
      }),
    });
  });

  it('does not project a hosted owner for a different Provider-session identity', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_hosted',
      currentStorageState: 'hosted',
    });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_other',
    });

    await expect(loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_hosted',
      machineId: 'machine_1',
      expectedHostedIdentity: {
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_hosted',
        source: { kind: 'codexHome', home: 'user' },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'session_is_not_external',
    });
  });

  it('projects released Claude source project identity before public linked-identity resolution', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/claude-config');
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_released_claude_project' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude-config',
          projectId: 'project-released',
        },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_released_claude_project',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'claude',
        linkData: { projectId: 'project-released' },
        metadata: expect.objectContaining({
          externalSessionV1: expect.objectContaining({
            linkData: { projectId: 'project-released' },
          }),
        }),
      }),
    });
  });

  it('returns typed reconciliation before resolving a divergent dual-row source', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_dual_conflict' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'codex-session',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 1,
      },
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'codex-session',
        source: { kind: 'codexHome', home: 'custom' },
        linkedAtMs: 1,
      },
    });

    await expect(loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_dual_conflict',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_reconciliation_required',
    });
  });

  it('loads a split-layout linked session through the owner compatibility view', async () => {
    const sharedMetadata = {
      v: 1,
      summary: {
        text: 'Safe shared title',
        updatedAt: 10,
      },
    };
    const ownerView = {
      ...sharedMetadata,
      tag: 'external-session:packed',
      path: '/repo',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'codex-session',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 10,
      },
    };
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_split_linked',
      metadataLayoutVersion: 1,
      metadata: 'shared-ciphertext',
      ownerMetadata: 'owner-ciphertext',
    });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce(ownerView);

    const result = await loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_split_linked',
      machineId: 'machine_1',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'codex-session',
        metadata: expect.objectContaining({
          externalSessionV1: expect.objectContaining({
            remoteSessionId: 'codex-session',
          }),
        }),
      }),
    });
    expect(tryDecryptSessionOwnerMetadataViewMock).toHaveBeenCalledOnce();
  });

  it('prefers the nested OpenCode runtime descriptor over stale legacy metadata', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_1' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'legacy-session',
      opencodeBackendMode: 'acp',
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-session',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:4096/',
          directory: '/repo/opencode',
        },
        linkedAtMs: 1,
        linkData: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
              backendMode: 'server',
              providerSessionId: 'runtime-session',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
              providerExtra: {
                owner: 'opencode',
                schemaId: 'opencode.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: {
                  backendMode: 'server',
                  providerSessionId: 'runtime-session',
                  serverBaseUrl: 'http://127.0.0.1:4096/',
                  serverBaseUrlExplicit: true,
                },
              },
            },
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_1',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'opencode',
        remoteSessionId: 'runtime-session',
      }),
    });
  });

  it('preserves the stored OpenCode source identity when the runtime descriptor does not carry a server base URL', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_open_code_partial_source' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'opencode',
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-session',
        source: { kind: 'opencodeServer', directory: '/repo/opencode' },
        linkedAtMs: 1,
        linkData: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
              backendMode: 'server',
              providerSessionId: 'runtime-session',
            },
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_open_code_partial_source',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'opencode',
        remoteSessionId: 'runtime-session',
        source: {
          kind: 'opencodeServer',
          directory: '/repo/opencode',
        },
      }),
    });
  });

  it('canonicalizes Codex direct-session identity from the nested runtime descriptor instead of stale source metadata', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_2' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'legacy-thread',
      codexBackendMode: 'appServer',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-thread',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 1,
        linkData: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'runtime-thread',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
              connectedServiceProfileId: 'work',
              homePath: '/tmp/connected-home',
              providerExtra: {
                owner: 'codex',
                schemaId: 'codex.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeAffinity: {
                  backendMode: 'appServer',
                  providerSessionId: 'runtime-thread',
                  home: 'connectedService',
                  connectedServiceId: 'openai-codex',
                  connectedServiceProfileId: 'work',
                  homePath: '/tmp/connected-home',
                },
              },
            },
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_2',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'codex',
        remoteSessionId: 'runtime-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-home',
        },
      }),
    });
  });

  it('preserves the stored codex source identity when the runtime descriptor only updates the session id', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_codex_partial_source' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'legacy-thread',
      codexBackendMode: 'appServer',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-home',
        },
        linkedAtMs: 1,
        linkData: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'runtime-thread',
              home: 'connectedService',
            },
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_codex_partial_source',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'codex',
        remoteSessionId: 'runtime-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-home',
        },
      }),
    });
  });

  it('fills linked Claude configDir from the current environment when the canonical source omits it', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/live-claude-config');
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_claude_current_config' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'claude',
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          projectId: 'proj-current',
        },
        linkData: { projectId: 'proj-current' },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_claude_current_config',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'claude',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/live-claude-config',
          projectId: 'proj-current',
        },
      }),
    });
  });

  it('resolves linked ohMyPi identity from canonical file linkData under the configured Agent directory', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-linked-omp-'));
    temporaryRoots.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    const sessionFilePath = join(sessionRoot, '2026-07-24T00-00-00-000Z_omp-session.jsonl');
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(sessionFilePath, `${JSON.stringify({
      type: 'session',
      id: 'omp-session',
      timestamp: '2026-07-24T00:00:00.000Z',
    })}\n`, 'utf8');
    const canonicalAgentDir = await realpath(agentDir);
    const canonicalSessionFilePath = await realpath(sessionFilePath);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_omp_current_agent_dir' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'ohMyPi',
      externalSessionV1: {
        v: 1,
        agentId: 'ohMyPi',
        machineId: 'machine_1',
        remoteSessionId: 'omp-session',
        source: {
          kind: 'ohMyPiAgentDir',
        },
        linkData: { sessionFilePath: canonicalSessionFilePath },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_omp_current_agent_dir',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'ohMyPi',
        remoteSessionId: 'omp-session',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: canonicalAgentDir,
          sessionFilePath: canonicalSessionFilePath,
        },
      }),
    });
  });
});
