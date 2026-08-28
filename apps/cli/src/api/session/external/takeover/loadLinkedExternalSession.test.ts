import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createLocalPathPluginDistributionIdentity } from '@/plugins/store/install/trustIdentity';
import { createImmutablePluginGenerationRecordFromSource } from '@/plugins/store/registry/generationStore';

const fetchSessionByIdMock = vi.fn();
const fetchAccountEncryptionCurrentnessMock = vi.fn();
const tryDecryptSessionOwnerMetadataViewMock = vi.fn();
const {
  canonicalizeLinkedExternalSessionSourceMock,
  resolveExternalSessionLinkIdentityMock,
  resolveExternalSessionSourceKeyOwnerMock,
} = vi.hoisted(() => ({
  canonicalizeLinkedExternalSessionSourceMock: vi.fn(),
  resolveExternalSessionLinkIdentityMock: vi.fn(),
  resolveExternalSessionSourceKeyOwnerMock: vi.fn(),
}));
const temporaryRoots = new Set<string>();
const generationRoots = new Set<string>();

function bundledPluginPackageRoot(packageName: string): string {
  const resolvePackage = createRequire(import.meta.url);
  return dirname(dirname(resolvePackage.resolve(packageName)));
}

async function bundledFixtureGenerations(pluginIds: ReadonlySet<string>) {
  return await Promise.all(
    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS
      .filter((artifact) => pluginIds.has(artifact.record.pluginId))
      .map(async (artifact) => {
        const packageRoot = bundledPluginPackageRoot(artifact.packageName);
        const rootPath = await mkdtemp(join(tmpdir(), 'happier-linked-generation-'));
        generationRoots.add(rootPath);
        await cp(packageRoot, rootPath, {
          recursive: true,
          filter: (source) => basename(source) !== 'node_modules',
        });
        const record = await createImmutablePluginGenerationRecordFromSource({
          pluginId: artifact.record.pluginId,
          sourceRootPath: rootPath,
          manifestRelativePath: '.happier-plugin/plugin.json',
          distribution: await createLocalPathPluginDistributionIdentity(rootPath),
          updatePolicy: 'manual',
          createdAtMs: 0,
          immutableGenerationId: artifact.record.immutableGenerationId,
        });
        await symlink(join(process.cwd(), 'node_modules'), join(rootPath, 'node_modules'));
        return [artifact.record.pluginId, {
          pluginId: artifact.record.pluginId,
          immutableGenerationId: record.immutableGenerationId,
          rootPath,
          record,
        }] as const;
      }),
  );
}

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
    fetchAccountEncryptionCurrentnessMock(...args),
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

vi.mock('@/session/external/resolveExternalSessionSourceKeyOwner', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/session/external/resolveExternalSessionSourceKeyOwner')
  >();
  resolveExternalSessionSourceKeyOwnerMock.mockImplementation(
    actual.resolveExternalSessionSourceKeyOwner,
  );
  return {
    ...actual,
    resolveExternalSessionSourceKeyOwner:
      (...args: unknown[]) => resolveExternalSessionSourceKeyOwnerMock(...args),
  };
});

import {
  loadLinkedExternalSession,
  loadPersistedLinkedExternalSession,
} from './loadLinkedExternalSession';

describe('loadLinkedExternalSession', () => {
  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    const pluginIds = [
      'happier.agent.claude',
      'happier.agent.codex',
      'happier.agent.ohmypi',
      'happier.agent.opencode',
    ] as const;
    const resolvedContributes = getResolvedContributionRegistry();
    const contributes = {
      ...resolvedContributes,
      connectedAccountDescriptors: Object.freeze(
        (resolvedContributes.connectedAccountDescriptors ?? []).filter(
          (descriptor) => pluginIds.includes(descriptor.pluginId as typeof pluginIds[number]),
        ),
      ),
    };
    const admittedPluginIds = new Set(pluginIds);
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes,
        pluginIds,
        generationAuthority: {
          commit: null,
          generations: new Map(await bundledFixtureGenerations(admittedPluginIds)),
          rejectedGenerations: new Map(),
          unavailableBundledPackageNames: new Set(),
          isCurrent: async () => true,
        },
      }),
    });
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
    runtimeRegistryLease = null;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    await Promise.all([...generationRoots].map(
      (root) => rm(root, { recursive: true, force: true }),
    ));
    generationRoots.clear();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
      mode: 'e2ee',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
  });

  function arrangeDirectOpenCodeLink(source: Readonly<Record<string, unknown>>): void {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_current_link' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        source,
        linkedAtMs: 1,
      },
    });
  }

  it('fails closed with an unavailable result when Account currentness cannot be read', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_current_link' });
    fetchAccountEncryptionCurrentnessMock.mockRejectedValueOnce(
      new Error('currentness unavailable'),
    );

    await expect(loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_current_link',
      machineId: 'machine_1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'session_load_unavailable',
    });
    expect(tryDecryptSessionOwnerMetadataViewMock).not.toHaveBeenCalled();
  });

  it('admits only the exact declaration-keyed current link identity', async () => {
    arrangeDirectOpenCodeLink({
      kind: 'opencodeServer',
      directory: '/repo/current',
    });

    await expect(loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_current_link',
      machineId: 'machine_1',
      expectedIdentity: {
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        source: {
          kind: 'opencodeServer',
          directory: '/repo/current',
        },
      },
    })).resolves.toEqual({
      ok: true,
      session: expect.objectContaining({
        source: expect.objectContaining({
          kind: 'opencodeServer',
          directory: '/repo/current',
        }),
        canonicalResolvedSourceKey: expect.any(String),
      }),
    });
    expect(resolveExternalSessionSourceKeyOwnerMock).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'a same-kind source relink',
      { kind: 'opencodeServer', directory: '/repo/relinked' },
    ],
    [
      'a cross-kind source',
      { kind: 'codexHome', home: 'user' },
    ],
    [
      'a malformed source',
      { kind: 'opencodeServer', directory: 42 },
    ],
  ] as const)('rejects %s before admitting the current link', async (_label, expectedSource) => {
    arrangeDirectOpenCodeLink({
      kind: 'opencodeServer',
      directory: '/repo/current',
    });

    await expect(loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_current_link',
      machineId: 'machine_1',
      expectedIdentity: {
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        source: expectedSource,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_identity_mismatch',
    });
  });

  it('rejects when the installed Agent source-key owner is unavailable', async () => {
    arrangeDirectOpenCodeLink({
      kind: 'opencodeServer',
      directory: '/repo/current',
    });
    resolveExternalSessionSourceKeyOwnerMock.mockResolvedValueOnce(null);

    await expect(loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_current_link',
      machineId: 'machine_1',
      expectedIdentity: {
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        source: {
          kind: 'opencodeServer',
          directory: '/repo/current',
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_identity_mismatch',
    });
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

  it('rejects a relinked persisted identity without resolving an Agent runtime surface', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_persisted_relinked',
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
          directory: '/repo/current',
        },
        linkedAtMs: 1_000,
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
      sessionId: 'sess_persisted_relinked',
      machineId: 'machine_1',
      expectedIdentity: {
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'remote_1',
        source: {
          kind: 'opencodeServer',
          directory: '/repo/relinked',
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_identity_mismatch',
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
    resolveExternalSessionSourceKeyOwnerMock.mockResolvedValueOnce({
      sourceKey: 'codexHome:user',
      resolveSourceKey: () => 'codexHome:user',
      resolvePersistedSourceKeys: () => ['codexHome:user'],
    });
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
      expectedIdentity: {
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

  it('rejects a malformed present import tombstone before hosted follow synthesis or source resolution', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_hosted_malformed_tombstone',
      currentStorageState: 'hosted',
    });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_hosted',
      externalHistoryImportV1: {
        v: 1,
        providerId: 'codex',
        remoteSessionId: 'thread_hosted',
        importedAtMs: 100,
        source: { kind: 'codexHome', home: 'user' },
        linkData: { projectId: 'canonical-only' },
      },
    });

    await expect(loadLinkedExternalSession({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      sessionId: 'sess_hosted_malformed_tombstone',
      machineId: 'machine_1',
      expectedIdentity: {
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_hosted',
        source: { kind: 'codexHome', home: 'user' },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'external_history_import_invalid',
    });
    expect(resolveExternalSessionSourceKeyOwnerMock).not.toHaveBeenCalled();
    expect(canonicalizeLinkedExternalSessionSourceMock).not.toHaveBeenCalled();
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
      expectedIdentity: {
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
      ownerMetadata: {
        t: 'encrypted',
        c: 'owner-ciphertext',
      },
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

  it('rejects an unadmitted persisted OpenCode source before Agent canonicalization I/O', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_unadmitted_opencode' });
    tryDecryptSessionOwnerMetadataViewMock.mockReturnValueOnce({
      path: '/repo',
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'native-1',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'https://unadmitted.example',
          directory: '/repo',
        },
        linkedAtMs: 1,
      },
    });
    const admitPersistedSourceBeforeCanonicalization = vi.fn(async () => null);

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess_unadmitted_opencode',
      machineId: 'machine_1',
    }, { admitPersistedSourceBeforeCanonicalization });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_source_not_current',
    });
    expect(admitPersistedSourceBeforeCanonicalization).toHaveBeenCalledOnce();
    expect(canonicalizeLinkedExternalSessionSourceMock).not.toHaveBeenCalled();
  });

  it('preserves the stored OpenCode directory and marks the canonical managed endpoint when the runtime descriptor has no base URL', async () => {
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
          managedEndpoint: true,
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

  it('resolves linked ohMyPi identity from the canonical source session file under the configured Agent directory', async () => {
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
        // The canonical Oh My Pi link persists its session file on the source;
        // link data stays empty because the host spreads it into top-level owner
        // metadata, whose strict allow-list rejects a `sessionFilePath` key.
        source: {
          kind: 'ohMyPiAgentDir',
          sessionFilePath: canonicalSessionFilePath,
        },
        linkData: {},
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
