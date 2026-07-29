import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateVendorResumeEligibility } from '@happier-dev/agents';
import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';
import {
  readLinkedExternalSessionV1FromMetadata,
  resolveExternalSessionsSourceKey,
  resolveExternalSessionsSourceKeysForPersistedTagLookup,
  sealSessionOwnerMetadataV1,
  SessionOwnerMetadataV1Schema,
  type CodexBackendMode,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { codexExternalSessionsContribution } from '@happier-dev/plugins-codex';
import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  openCodeExternalSessionsContribution,
} from '@happier-dev/plugins-opencode';

import {
  createAgentExternalSessionsExecutionSurface,
} from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import {
  resolveExternalSessionTagLookupCandidates,
} from './externalSessionTagLookupCandidates';

const fetchSessionsPageMock = vi.fn();
const fetchSessionByIdMock = vi.fn();
const lookupSessionsByTagsMock = vi.fn();
const getOrCreateSessionByTagMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();
const tryDecryptSessionOwnerMetadataMock = vi.fn();
const tryDecryptSessionOwnerMetadataViewMock = vi.fn();
const updateSessionMetadataWithRetryMock = vi.fn();
const listSessionMarkersMock = vi.fn();

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
  fetchSessionsPage: (...args: unknown[]) => fetchSessionsPageMock(...args),
  lookupSessionsByTags: (...args: unknown[]) => lookupSessionsByTagsMock(...args),
  getOrCreateSessionByTag: (...args: unknown[]) => getOrCreateSessionByTagMock(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => tryDecryptSessionMetadataMock(...args),
  tryDecryptSessionOwnerMetadata: (...args: unknown[]) => tryDecryptSessionOwnerMetadataMock(...args),
  tryDecryptSessionOwnerMetadataView: (...args: unknown[]) =>
    tryDecryptSessionOwnerMetadataViewMock(...args),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => updateSessionMetadataWithRetryMock(...args),
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: (...args: unknown[]) => listSessionMarkersMock(...args),
}));

import {
  ensureExternalSessionLink as ensureExternalSessionLinkWithDeps,
  resolveExternalSessionIndexedTagLookup,
} from './ensureExternalSessionLink';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const externalSessionSurfaces = new Map<ExternalSessionsAgentId, ExternalSessionExecutionSurface>([
  ['codex', createAgentExternalSessionsExecutionSurface(codexExternalSessionsContribution)],
  ['opencode', createAgentExternalSessionsExecutionSurface(openCodeExternalSessionsContribution)],
]);
let currentAgentPluginIdOverride: string | null = null;

async function ensureExternalSessionLink(
  params: Parameters<typeof ensureExternalSessionLinkWithDeps>[0],
): ReturnType<typeof ensureExternalSessionLinkWithDeps> {
  return await ensureExternalSessionLinkWithDeps(params, {
    resolveExternalSessionProviderOps: async (agentId) => externalSessionSurfaces.get(agentId) ?? null,
    resolveCurrentAgent: async (agentId) => ({
      identity: {
        pluginId: currentAgentPluginIdOverride ?? `happier.agent.${agentId.toLowerCase()}`,
        localId: agentId === 'ohMyPi' ? 'ohmypi' : agentId,
      },
      sourceKinds: agentId === 'codex'
        ? ['codexHome']
        : agentId === 'opencode'
          ? ['opencodeServer']
          : agentId === 'antigravity'
            ? ['antigravityCliPrint']
          : agentId === 'claude'
            ? ['claudeConfig']
            : ['ohMyPiAgentDir'],
    }),
    resolveSourceKeyOwner: async (_agentId, source) => ({
      sourceKey: resolveExternalSessionsSourceKey(source),
      resolveSourceKey: (candidate: ExternalSessionsSource) => resolveExternalSessionsSourceKey(candidate),
      resolvePersistedSourceKeys: (candidate: ExternalSessionsSource) => (
        resolveExternalSessionsSourceKeysForPersistedTagLookup(candidate)
      ),
    }),
  });
}

describe('ensureExternalSessionLink', () => {
  const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;
  const connectedServices = {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': {
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: 'codex-main',
        profileId: 'backup',
      },
    },
  };
  const materializationIdentity = {
    v: 1 as const,
    id: 'csm_direct_link',
    createdAt: 123,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    listSessionMarkersMock.mockResolvedValue([]);
    fetchSessionsPageMock.mockResolvedValue({ sessions: [], hasNext: false, nextCursor: null });
    fetchSessionByIdMock.mockResolvedValue(null);
    lookupSessionsByTagsMock.mockResolvedValue({ state: 'unavailable' });
    tryDecryptSessionMetadataMock.mockReturnValue(null);
    tryDecryptSessionOwnerMetadataMock.mockReturnValue(null);
    tryDecryptSessionOwnerMetadataViewMock.mockImplementation(
      (params: unknown) => tryDecryptSessionMetadataMock(params),
    );
    updateSessionMetadataWithRetryMock.mockResolvedValue(undefined);
    currentAgentPluginIdOverride = null;
  });

  it('stores the canonical codex runtime descriptor for linked direct sessions', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_1',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: 'thread_runtime',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/connected-codex-home',
      }),
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledWith(expect.objectContaining({
      currentStorageState: 'machine_only',
    }));
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      summary: {
        text: 'Codex linked session',
        updatedAt: expect.any(Number),
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-codex-home',
        },
      },
      externalSessionV1: {
        remoteSessionId: 'thread_runtime',
        source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
          source: { kind: 'codexHome', contractVersion: 1 },
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-codex-home',
          },
        },
      },
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_runtime',
        source: { kind: 'codexHome', home: 'connectedService' },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime',
          },
        },
      },
    });
    expect(createdMetadata).not.toHaveProperty('name');
    expect(createdMetadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(createdMetadata?.externalSessionV1).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('reuses the group-proven Remote predecessor tag for the current member and upgrades it to canonical Dev identity', async () => {
    const removedMemberTag = `direct:v1:${sha256Hex('machine_1|codex|thread_group|codexHome:connectedService:openai-codex:member-a:/tmp/connected-codex-home')}`;
    const legacyTag = `direct:v1:${sha256Hex('machine_1|codex|thread_group|codexHome:connectedService:openai-codex:member-b:/tmp/connected-codex-home')}`;
    const canonicalTag = `direct:v1:${sha256Hex('machine_1|codex|thread_group|codexHome:connectedService:openai-codex:group%3Aprimary-pool:/tmp/connected-codex-home')}`;
    const existingMetadata = {
      tag: legacyTag,
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'thread_group',
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_group',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'member-b',
          connectedServiceGroupId: 'primary-pool',
          homePath: '/tmp/connected-codex-home',
        },
        linkedAtMs: 1,
      },
    };
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => {
      return {
        state: 'available',
        tags,
        sessions: [{
          id: 'sess_group',
          metadata: 'encrypted-metadata-placeholder',
          currentStorageState: 'machine_only',
        }],
      };
    });
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_group', metadata: existingMetadata });
    tryDecryptSessionMetadataMock.mockReturnValue(existingMetadata);

    const result = await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_group',
      codexBackendMode: 'appServer',
      runtimeDescriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: 'thread_group',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'member-b',
        connectedServiceGroupId: 'primary-pool',
        homePath: '/tmp/connected-codex-home',
      }),
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'member-b',
        connectedServiceGroupId: 'primary-pool',
        homePath: '/tmp/connected-codex-home',
      },
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    expect(result).toEqual({ sessionId: 'sess_group', created: false, tag: canonicalTag });
    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(lookupSessionsByTagsMock.mock.calls[0]?.[0]?.tags).toContain(legacyTag);
    expect(lookupSessionsByTagsMock.mock.calls[0]?.[0]?.tags).not.toContain(removedMemberTag);
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledWith(expect.objectContaining({
      tag: existingMetadata.tag,
      currentStorageState: 'machine_only',
    }));
    const updater = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0]?.updater;
    expect(typeof updater).toBe('function');
    expect(updater(existingMetadata)).toMatchObject({
      tag: canonicalTag,
      runtimeDescriptorV1: {
        agent: { connectedServiceGroupId: 'primary-pool' },
      },
      externalSessionV1: {
        agentId: 'codex',
        linkedAtMs: 123,
        remoteSessionId: 'thread_group',
        source: { connectedServiceGroupId: 'primary-pool' },
        runtimeDescriptorV1: {
          agent: { connectedServiceGroupId: 'primary-pool' },
        },
      },
    });
  });

  it('fails closed instead of auto-creating when a removed Codex connected-service member is not derivable', async () => {
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [],
    }));

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_group',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'member-b',
        connectedServiceGroupId: 'primary-pool',
        homePath: '/tmp/connected-codex-home',
      },
      requireIndexedTagLookup: true,
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'conflict',
      operation: 'externalSession.lookupByTags',
    });
    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('retains explicit Browse recovery for a removed Codex connected-service member', async () => {
    const removedMemberTag = `direct:v1:${sha256Hex('machine_1|codex|thread_group|codexHome:connectedService:openai-codex:member-a:/tmp/connected-codex-home')}`;
    const existingMetadata = {
      tag: removedMemberTag,
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'thread_group',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_group',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'member-a',
          connectedServiceGroupId: 'primary-pool',
          homePath: '/tmp/connected-codex-home',
        },
        linkedAtMs: 1,
      },
    };
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [],
    }));
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{
        id: 'sess_removed_member',
        metadata: 'encrypted-metadata-placeholder',
        currentStorageState: 'machine_only',
      }],
      hasNext: false,
    });
    tryDecryptSessionMetadataMock.mockReturnValue(existingMetadata);

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_group',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'member-b',
        connectedServiceGroupId: 'primary-pool',
        homePath: '/tmp/connected-codex-home',
      },
      nowMs: () => 123,
    })).resolves.toMatchObject({
      sessionId: 'sess_removed_member',
      created: false,
    });
    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(fetchSessionsPageMock).toHaveBeenCalledOnce();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('uses the split-layout owner view for indexed-absence Codex group continuity across the archived fallback scan', async () => {
    const credentials = {
      token: 'token',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };
    const currentSource = {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'member-b',
      connectedServiceGroupId: 'primary-pool',
      homePath: '/tmp/connected-codex-home',
    };
    const removedMemberTag = `direct:v1:${sha256Hex(
      'machine_1|codex|thread_split_group|codexHome:connectedService:openai-codex:member-a:/tmp/connected-codex-home',
    )}`;
    const sharedMetadata = {
      v: 1 as const,
      summary: { text: 'Recipient-safe title', updatedAt: 10 },
    };
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine_1',
      },
      nativeSession: {
        tag: removedMemberTag,
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine_1',
          remoteSessionId: 'thread_split_group',
          source: {
            ...currentSource,
            connectedServiceProfileId: 'member-a',
          },
          linkedAtMs: 1,
        },
      },
    });
    const ownerMetadataCiphertext = sealSessionOwnerMetadataV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });
    const splitLayoutArchivedRow = {
      id: 'sess_split_group',
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: ownerMetadataCiphertext,
      currentStorageState: 'machine_only' as const,
      active: false,
      archivedAt: 1_000,
    };
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [],
    }));
    fetchSessionsPageMock
      .mockResolvedValueOnce({
        sessions: [],
        hasNext: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        sessions: [splitLayoutArchivedRow],
        hasNext: false,
        nextCursor: null,
      });
    const actualEncryption = await vi.importActual<
      typeof import('@/session/transport/encryption/sessionEncryptionContext')
    >('@/session/transport/encryption/sessionEncryptionContext');
    tryDecryptSessionOwnerMetadataViewMock.mockImplementation(
      actualEncryption.tryDecryptSessionOwnerMetadataView,
    );
    await expect(ensureExternalSessionLink({
      credentials,
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_split_group',
      source: currentSource,
      nowMs: () => 123,
    })).resolves.toMatchObject({
      sessionId: 'sess_split_group',
      created: false,
    });

    expect(fetchSessionsPageMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      archivedOnly: false,
    }));
    expect(fetchSessionsPageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      archivedOnly: true,
    }));
    expect(tryDecryptSessionOwnerMetadataViewMock).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      rawSession: splitLayoutArchivedRow,
    });
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['malformed', 'malformed-owner-envelope'],
  ] as const)('does not prove split-layout group continuity from shared metadata when owner metadata is %s', async (
    _ownerEnvelopeState,
    ownerMetadata,
  ) => {
    const credentials = {
      token: 'token',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };
    const currentSource = {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'member-b',
      connectedServiceGroupId: 'primary-pool',
      homePath: '/tmp/connected-codex-home',
    };
    const sharedMetadata = {
      v: 1 as const,
      summary: { text: 'Recipient-safe title', updatedAt: 10 },
    };
    const splitLayoutRow = {
      id: 'sess_split_group_unavailable',
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ...(ownerMetadata === undefined ? {} : { ownerMetadata }),
      currentStorageState: 'machine_only' as const,
    };
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [],
    }));
    fetchSessionsPageMock
      .mockResolvedValueOnce({
        sessions: [splitLayoutRow],
        hasNext: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        sessions: [],
        hasNext: false,
        nextCursor: null,
      });
    const actualEncryption = await vi.importActual<
      typeof import('@/session/transport/encryption/sessionEncryptionContext')
    >('@/session/transport/encryption/sessionEncryptionContext');
    tryDecryptSessionOwnerMetadataViewMock.mockImplementation(
      actualEncryption.tryDecryptSessionOwnerMetadataView,
    );
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_new_after_owner_failure', metadata: {} },
      created: true,
    });

    await expect(ensureExternalSessionLink({
      credentials,
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_split_group_unavailable',
      source: currentSource,
      nowMs: () => 123,
    })).resolves.toMatchObject({
      sessionId: 'sess_new_after_owner_failure',
      created: true,
    });

    expect(tryDecryptSessionOwnerMetadataViewMock).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      rawSession: splitLayoutRow,
    });
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledOnce();
  });

  it('preserves a converted group import tombstone after connected-service member rotation', async () => {
    const currentSource = {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'member-b',
      connectedServiceGroupId: 'primary-pool',
      homePath: '/tmp/connected-codex-home',
    };
    const canonicalTag = `direct:v1:${sha256Hex(
      `machine_1|codex|thread_group_import|${resolveExternalSessionsSourceKey(currentSource)}`,
    )}`;
    const importedMetadata = {
      tag: 'direct:v1:released-member-a-tag',
      machineId: 'machine_1',
      externalHistoryImportV1: {
        v: 1,
        agentId: 'codex',
        remoteSessionId: 'thread_group_import',
        importedAtMs: 456,
        source: {
          ...currentSource,
          connectedServiceProfileId: 'member-a',
        },
      },
    };
    fetchSessionsPageMock.mockResolvedValue({
      sessions: [{ id: 'sess_group_import', metadata: importedMetadata }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata,
    );

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_group_import',
      source: currentSource,
      nowMs: () => 123,
    })).resolves.toEqual({
      sessionId: 'sess_group_import',
      created: false,
      tag: canonicalTag,
    });
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('reuses an A13-proven persisted tag written with the legacy unescaped source key', async () => {
    const legacyTag = `direct:v1:${sha256Hex('machine_1|opencode|oc_legacy_tag|opencodeServer:http://127.0.0.1:4096/:/tmp/repo')}`;
    const canonicalTag = `direct:v1:${sha256Hex('machine_1|opencode|oc_legacy_tag|opencodeServer:http%3A//127.0.0.1%3A4096:/tmp/repo')}`;
    const existingMetadata = {
      tag: legacyTag,
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'oc_legacy_tag',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:4096/',
          directory: '/tmp/repo',
        },
        linkedAtMs: 1,
      },
    };
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => {
      existingMetadata.tag = tags.find((tag) => tag !== canonicalTag) ?? legacyTag;
      return {
        state: 'available',
        tags,
        sessions: [{
          id: 'sess_legacy_tag',
          metadata: 'encrypted-metadata-placeholder',
          currentStorageState: 'machine_only',
        }],
      };
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_legacy_tag',
      metadata: 'encrypted-metadata-placeholder',
      currentStorageState: 'machine_only',
    });
    tryDecryptSessionMetadataMock.mockReturnValue(existingMetadata);

    const result = await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'opencode',
      remoteSessionId: 'oc_legacy_tag',
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:4096/',
        directory: '/tmp/repo',
      },
      directoryHint: '/tmp/repo',
      nowMs: () => 123,
    });

    expect(result).toEqual({ sessionId: 'sess_legacy_tag', created: false, tag: canonicalTag });
    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledWith(expect.objectContaining({
      tag: existingMetadata.tag,
      currentStorageState: 'machine_only',
    }));
    const updater = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0]?.updater;
    expect(typeof updater).toBe('function');
    const upgradedMetadata = updater(existingMetadata);
    expect(upgradedMetadata).toMatchObject({ tag: canonicalTag });
    expect(readLinkedExternalSessionV1FromMetadata(upgradedMetadata)).toMatchObject({
      agentId: 'opencode',
      remoteSessionId: 'oc_legacy_tag',
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:4096',
        directory: '/tmp/repo',
      },
      linkData: {
        opencodeSessionId: 'oc_legacy_tag',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096',
      },
    });
  });

  it('copies non-secret connected-service runtime identity from the tracked source session when creating a direct link', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 321,
        happySessionId: 'sess_source',
        happyHomeDir: '/tmp/happier-test-home',
        createdAt: 1,
        updatedAt: 10,
        flavor: 'codex',
        cwd: '/repo',
        metadata: {
          flavor: 'codex',
          codexSessionId: 'thread_runtime',
          connectedServices,
          connectedServicesUpdatedAt: 456,
        },
        respawn: {
          resume: 'thread_runtime',
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            OPENAI_API_KEY: 'must-not-copy',
          },
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_connected',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_runtime',
      source: { kind: 'codexHome', home: 'user' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 456,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(JSON.stringify(createdMetadata)).not.toContain('must-not-copy');
  });

  it('recovers connected-service runtime identity from a catalog-backed ohMyPi tracked marker when creating a direct link', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 322,
        happySessionId: 'sess_source_ohmypi',
        happyHomeDir: '/tmp/happier-test-home',
        createdAt: 1,
        updatedAt: 10,
        flavor: 'ohMyPi',
        cwd: '/repo',
        metadata: {
          flavor: 'ohMyPi',
          ohMyPiSessionId: 'omp_thread_runtime',
          connectedServices,
          connectedServicesUpdatedAt: 456,
        },
        respawn: {
          directory: '/repo',
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            GEMINI_API_KEY: 'must-not-copy',
          },
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_connected_ohmypi',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'ohMyPi',
      remoteSessionId: 'omp_thread_runtime',
      source: { kind: 'ohMyPiAgentDir', agentDir: null },
      titleHint: 'OhMyPi linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 456,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      ohMyPiSessionId: 'omp_thread_runtime',
    });
    expect(JSON.stringify(createdMetadata)).not.toContain('must-not-copy');
  });

  it('refreshes canonical runtime descriptor metadata when relinking an existing direct session', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } };
    const runtimeDescriptor = buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      providerSessionId: 'thread_runtime',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected-codex-home',
    });
    const linkInput = {
      credentials,
      machineId: 'machine_1',
      agentId: 'codex' as const,
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor,
      source: { kind: 'codexHome' as const, home: 'connectedService' as const, connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    };
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_existing',
        metadata: {},
      },
    });

    await ensureExternalSessionLink(linkInput);

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    const staleMetadata = JSON.parse(JSON.stringify(createdMetadata));
    staleMetadata.externalAgentObservationV1 = {
      v: 1,
      qualifiedLinkIdentity: staleMetadata.externalSessionV1.qualifiedIdentity,
      linkGeneration: String(staleMetadata.externalSessionV1.linkedAtMs),
      status: 'working',
      observedAtMs: 120,
      expiresAtMs: 220,
    };
    delete staleMetadata.runtimeDescriptorV1;
    delete staleMetadata.externalSessionV1.runtimeDescriptorV1;
    delete staleMetadata.externalSessionV1.linkData.runtimeDescriptorV1;
    delete staleMetadata.directSessionV1.agentRuntimeDescriptorV1;
    delete staleMetadata.externalSessionV1.qualifiedIdentity;
    const existingRawSession = {
      id: 'sess_direct_existing',
      metadata: 'encrypted-metadata-placeholder',
    };
    let refreshedMetadata: Record<string, unknown> | null = null;

    getOrCreateSessionByTagMock.mockClear();
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [existingRawSession],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionByIdMock.mockResolvedValue(existingRawSession);
    tryDecryptSessionMetadataMock.mockImplementation(({ rawSession }: { rawSession?: unknown }) =>
      rawSession === existingRawSession ? staleMetadata : null,
    );
    updateSessionMetadataWithRetryMock.mockImplementationOnce(async ({ updater }: { updater: (metadata: Record<string, unknown>) => Record<string, unknown> }) => {
      refreshedMetadata = updater(staleMetadata);
    });

    const relinked = await ensureExternalSessionLink(linkInput);

    expect(relinked).toEqual({
      sessionId: 'sess_direct_existing',
      created: false,
      tag: createdMetadata.tag,
    });
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledWith(expect.objectContaining({
      currentStorageState: 'machine_only',
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    expect(refreshedMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-codex-home',
        },
      },
      externalSessionV1: {
        linkedAtMs: 124,
        remoteSessionId: 'thread_runtime',
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
          source: { kind: 'codexHome', contractVersion: 1 },
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-codex-home',
          },
        },
        linkData: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'thread_runtime',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
              connectedServiceProfileId: 'work',
              homePath: '/tmp/connected-codex-home',
            },
          },
        },
      },
    });
    expect(Reflect.get(refreshedMetadata ?? {}, 'directSessionV1')).not.toHaveProperty('qualifiedIdentity');
    expect(refreshedMetadata).not.toHaveProperty('externalAgentObservationV1');
  });

  it('preserves runtime.externalAgent during a same-link metadata refresh', async () => {
    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex' as const,
      remoteSessionId: 'thread_same_link',
      source: { kind: 'codexHome' as const, home: 'user' as const },
      titleHint: 'Same linked session',
      nowMs: () => 123,
    };
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_same_link', metadata: {} },
    });
    await ensureExternalSessionLink(input);
    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    const currentMetadata = {
      ...createdMetadata,
      summary: undefined,
      externalAgentObservationV1: {
        v: 1,
        qualifiedLinkIdentity: createdMetadata.externalSessionV1.qualifiedIdentity,
        linkGeneration: String(createdMetadata.externalSessionV1.linkedAtMs),
        status: 'working',
        observedAtMs: 120,
        expiresAtMs: 220,
      },
    };
    const rawSession = {
      id: 'sess_same_link',
      metadata: 'encrypted-metadata-placeholder',
    };
    let refreshedMetadata: Record<string, unknown> | null = null;

    getOrCreateSessionByTagMock.mockClear();
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [rawSession],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionByIdMock.mockResolvedValue(rawSession);
    tryDecryptSessionMetadataMock.mockReturnValue(currentMetadata);
    updateSessionMetadataWithRetryMock.mockImplementationOnce(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      refreshedMetadata = updater(currentMetadata);
    });

    await ensureExternalSessionLink(input);

    expect(refreshedMetadata).toMatchObject({
      summary: { text: 'Same linked session' },
      externalSessionV1: { linkedAtMs: 123 },
      externalAgentObservationV1: currentMetadata.externalAgentObservationV1,
    });
  });

  it('does not let a replacement plugin overwrite an existing qualified link during relink', async () => {
    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex' as const,
      remoteSessionId: 'thread_qualified',
      source: { kind: 'codexHome' as const, home: 'user' as const },
      nowMs: () => 123,
    };
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_qualified', metadata: {} },
    });
    await ensureExternalSessionLink(input);
    const qualifiedMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(qualifiedMetadata).toMatchObject({
      externalSessionV1: {
        qualifiedIdentity: {
          agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
    });
    expect(readLinkedExternalSessionV1FromMetadata(qualifiedMetadata)?.qualifiedIdentity).toMatchObject({
      agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
    });
    const existingRawSession = { id: 'sess_qualified', metadata: 'encrypted-metadata-placeholder' };

    getOrCreateSessionByTagMock.mockClear();
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [existingRawSession],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionByIdMock.mockResolvedValue(existingRawSession);
    tryDecryptSessionMetadataMock.mockImplementation(({ rawSession }: { rawSession?: unknown }) =>
      rawSession === existingRawSession ? qualifiedMetadata : null,
    );
    currentAgentPluginIdOverride = 'com.example.replacement';

    await expect(ensureExternalSessionLink(input)).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: 'external_session_qualified_agent_unavailable',
    });
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('prefers providerExtra when linked direct-session runtime descriptors carry stale top-level codex fields', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_2',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'mcp',
          providerSessionId: 'thread_top_level',
          home: 'user',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              providerSessionId: 'thread_runtime',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
            },
          },
        },
      },
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      runtimeDescriptorV1: {
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
      externalSessionV1: {
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
    });
  });

  it('preserves the existing codex source identity when the runtime descriptor is only partially populated', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_codex_partial_source',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_legacy',
      runtimeDescriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: 'thread_runtime',
        home: 'connectedService',
      }),
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/connected-codex-home',
      },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata?.externalSessionV1?.source).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected-codex-home',
    });
  });

  it('normalizes legacy codex backend aliases when linking direct sessions without a runtime descriptor', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_alias',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_alias',
      codexBackendMode: legacyCodexBackendMode,
      source: { kind: 'codexHome', home: 'user' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_alias',
      codexBackendMode: 'acp',
      runtimeDescriptorV1: {
        agentId: 'codex',
        agent: {
          backendMode: 'acp',
          providerSessionId: 'thread_alias',
        },
      },
    });
  });

  it('stores the canonical OpenCode runtime descriptor for linked direct sessions', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_1',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptorV1({
        backendMode: 'server',
        providerSessionId: 'oc_runtime',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      }),
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      opencodeSessionId: 'oc_runtime',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'oc_runtime',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      externalSessionV1: {
        remoteSessionId: 'oc_runtime',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          agent: {
            backendMode: 'server',
            providerSessionId: 'oc_runtime',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
          },
        },
        linkData: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            agent: {
              backendMode: 'server',
              providerSessionId: 'oc_runtime',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            },
          },
          opencodeSessionId: 'oc_runtime',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
          opencodeServerBaseUrlExplicit: true,
        },
      },
    });
    expect(createdMetadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(createdMetadata?.externalSessionV1).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('forces OpenCode direct-session runtime descriptors to server mode when the source is opencodeServer', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_force_server',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'acp',
          providerSessionId: 'oc_runtime',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      } as any,
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      opencodeSessionId: 'oc_runtime',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'oc_runtime',
        },
      },
    });
  });

  it('prefers providerExtra when linked direct-session runtime descriptors carry stale top-level OpenCode fields', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_2',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'acp',
          providerSessionId: 'oc_top_level',
          serverBaseUrl: 'http://legacy.example/',
          providerExtra: {
            owner: 'opencode',
            schemaId: 'opencode.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeHandle: {
              backendMode: 'server',
              providerSessionId: 'oc_runtime',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            },
          },
        },
      },
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      opencodeSessionId: 'oc_runtime',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
    });
  });

  it('reports the server creation truth for a concurrent tag winner without rescanning', async () => {
    let scansBeforeCreate: number | null = null;
    getOrCreateSessionByTagMock.mockImplementationOnce(async () => {
      scansBeforeCreate = fetchSessionsPageMock.mock.calls.length;
      return {
        session: { id: 'sess_race_winner', metadata: {} },
        created: false,
      };
    });

    const result = await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_race',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    });

    expect(result).toEqual(expect.objectContaining({
      sessionId: 'sess_race_winner',
      created: false,
    }));
    expect(scansBeforeCreate).toBeGreaterThan(0);
    expect(fetchSessionsPageMock).toHaveBeenCalledTimes(scansBeforeCreate!);
  });

  it('uses one indexed lookup for an archived canonical link and never paginates when the route is available', async () => {
    const sourceInput = { kind: 'codexHome' as const, home: 'user' as const };
    const resolvedIdentity = await codexExternalSessionsContribution.resolveLinkIdentity({
      source: sourceInput,
      remoteSessionId: 'thread_indexed',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 5_000,
      maxSerializedBytes: 262_144,
    });
    if (!resolvedIdentity.ok) throw new Error('Expected Codex identity resolution');
    const source = resolvedIdentity.value.source;
    const lookupCandidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed',
      source,
      releasedPersistedSource: sourceInput,
      sourceKey: resolveExternalSessionsSourceKey(source),
      releasedSourceKeys:
        resolveExternalSessionsSourceKeysForPersistedTagLookup(sourceInput),
    });
    const tag = lookupCandidates[0].tag;
    const metadata = {
      tag,
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_indexed',
        source,
        linkedAtMs: 123,
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
          source: { kind: 'codexHome', contractVersion: 1 },
        },
      },
    };
    lookupSessionsByTagsMock.mockResolvedValueOnce({
      state: 'available',
      tags: lookupCandidates.map((candidate) => candidate.tag),
      sessions: [{
        id: 'sess_indexed',
        metadata: 'encrypted-metadata-placeholder',
        currentStorageState: 'machine_only',
        active: false,
        archivedAt: 1_000,
      }],
    });
    tryDecryptSessionMetadataMock.mockReturnValue(metadata);
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_indexed',
      metadata: 'encrypted-metadata-placeholder',
      currentStorageState: 'machine_only',
    });

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed',
      source: sourceInput,
      nowMs: () => 123,
    })).resolves.toEqual({
      sessionId: 'sess_indexed',
      created: false,
      tag,
    });

    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(lookupSessionsByTagsMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      tags: expect.arrayContaining([tag]),
    }));
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledOnce();
  });

  it('recovers an exact legacy-layout encrypted tag after indexed absence before creating', async () => {
    const sourceInput = { kind: 'codexHome' as const, home: 'user' as const };
    const resolvedIdentity = await codexExternalSessionsContribution.resolveLinkIdentity({
      source: sourceInput,
      remoteSessionId: 'thread_legacy_layout',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 5_000,
      maxSerializedBytes: 262_144,
    });
    if (!resolvedIdentity.ok) throw new Error('Expected Codex identity resolution');
    const source = resolvedIdentity.value.source;
    const lookupCandidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_legacy_layout',
      source,
      releasedPersistedSource: sourceInput,
      sourceKey: resolveExternalSessionsSourceKey(source),
      releasedSourceKeys:
        resolveExternalSessionsSourceKeysForPersistedTagLookup(sourceInput),
    });
    const tag = lookupCandidates[0].tag;
    const metadata = {
      tag,
      machineId: 'machine_1',
      flavor: 'codex',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_legacy_layout',
        source,
        linkedAtMs: 123,
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
          source: { kind: 'codexHome', contractVersion: 1 },
        },
        linkData: { source },
      },
    };
    const legacyLayoutRow = {
      id: 'sess_legacy_layout',
      metadataLayoutVersion: 0,
      metadata: 'encrypted-metadata-placeholder',
      currentStorageState: 'machine_only',
      active: false,
      archivedAt: null,
    };
    const wrongIdentityLegacyRow = {
      ...legacyLayoutRow,
      id: 'sess_wrong_legacy_layout',
    };
    const wrongIdentityMetadata = {
      ...metadata,
      externalSessionV1: {
        ...metadata.externalSessionV1,
        remoteSessionId: 'thread_other',
      },
    };
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [],
    }));
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [wrongIdentityLegacyRow, legacyLayoutRow],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { id: string } }) =>
        rawSession.id === wrongIdentityLegacyRow.id ? wrongIdentityMetadata : metadata,
    );
    fetchSessionByIdMock.mockResolvedValueOnce(legacyLayoutRow);
    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_legacy_layout',
      source: sourceInput,
      nowMs: () => 123,
    })).resolves.toEqual({
      sessionId: 'sess_legacy_layout',
      created: false,
      tag,
    });

    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(fetchSessionsPageMock).toHaveBeenCalledOnce();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('exactly revalidates a split-layout indexed owner hit from owner metadata, never shared metadata', async () => {
    const source = { kind: 'codexHome' as const, home: 'user' as const };
    const tagCandidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_owner_private',
      source,
      releasedPersistedSource: source,
      sourceKey: resolveExternalSessionsSourceKey(source),
      releasedSourceKeys: resolveExternalSessionsSourceKeysForPersistedTagLookup(source),
    });
    const tag = tagCandidates[0].tag;
    const privateMetadata = {
      tag,
      machineId: 'machine_1',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_owner_private',
        source,
        linkedAtMs: 10,
      },
    };
    const ownerMetadata = {
      v: 1 as const,
      workspace: {
        machineId: 'machine_1',
      },
      nativeSession: {
        externalSessionV1: privateMetadata.externalSessionV1,
      },
    };
    const sharedMetadata = {
      v: 1 as const,
      summary: { text: 'Safe title', updatedAt: 10 },
    };
    lookupSessionsByTagsMock.mockResolvedValueOnce({
      state: 'available',
      tags: tagCandidates.map((candidate) => candidate.tag),
      sessions: [{
        id: 'session_owner_private',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify(sharedMetadata),
        ownerMetadata: 'account-encrypted-owner-envelope',
        currentStorageState: 'machine_only',
      }],
    });
    tryDecryptSessionMetadataMock.mockReturnValue(sharedMetadata);
    tryDecryptSessionOwnerMetadataMock.mockReturnValue(ownerMetadata);

    const result = await resolveExternalSessionIndexedTagLookup({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_owner_private',
      source,
      tagCandidates,
      resolveSourceKey: resolveExternalSessionsSourceKey,
    });

    expect(result).toMatchObject({
      state: 'available',
      existing: {
        sessionId: 'session_owner_private',
        persistedTag: tag,
        kind: 'external_link',
        sharedMetadata,
        ownerMetadata,
      },
    });
    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(tryDecryptSessionOwnerMetadataMock).toHaveBeenCalledOnce();
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
  });

  it('does not scan legacy metadata or create until one indexed lookup returns no match', async () => {
    let releaseLookup!: () => void;
    lookupSessionsByTagsMock.mockImplementationOnce(
      async ({ tags }: { tags: string[] }) => await new Promise((resolve) => {
        releaseLookup = () => resolve({
          state: 'available',
          tags,
          sessions: [],
        });
      }),
    );
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_after_absence', metadata: {} },
      created: true,
    });

    const pending = ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_after_absence',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    });
    await vi.waitFor(() => {
      expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    });
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();

    releaseLookup();
    await expect(pending).resolves.toEqual(expect.objectContaining({
      sessionId: 'sess_after_absence',
      created: true,
    }));
    expect(fetchSessionsPageMock.mock.calls.length).toBeGreaterThan(0);
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledOnce();
  });

  it('fails closed on conflicting indexed rows without pagination or creation', async () => {
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [
        {
          id: 'sess_conflict_a',
          metadata: 'encrypted-a',
          currentStorageState: 'machine_only',
        },
        {
          id: 'sess_conflict_b',
          metadata: 'encrypted-b',
          currentStorageState: 'machine_only',
        },
      ],
    }));

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_conflict',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'conflict',
      operation: 'externalSession.lookupByTags',
    });

    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('fails closed for hook-required lookup when the old server route is unavailable', async () => {
    lookupSessionsByTagsMock.mockResolvedValueOnce({ state: 'unavailable' });

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_old_server',
      source: { kind: 'codexHome', home: 'user' },
      requireIndexedTagLookup: true,
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'agent_unavailable',
      operation: 'externalSession.lookupByTags',
    });

    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('preserves the indexed absence proof after legacy metadata recovery across a concurrent create winner', async () => {
    let scansBeforeCreate: number | null = null;
    lookupSessionsByTagsMock.mockImplementationOnce(async ({ tags }: { tags: string[] }) => ({
      state: 'available',
      tags,
      sessions: [],
    }));
    getOrCreateSessionByTagMock.mockImplementationOnce(async () => {
      scansBeforeCreate = fetchSessionsPageMock.mock.calls.length;
      return {
        session: { id: 'sess_indexed_race_winner', metadata: {} },
        created: false,
      };
    });

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed_race',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    })).resolves.toEqual(expect.objectContaining({
      sessionId: 'sess_indexed_race_winner',
      created: false,
    }));

    expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
    expect(scansBeforeCreate).toBeGreaterThan(0);
    expect(fetchSessionsPageMock).toHaveBeenCalledTimes(scansBeforeCreate!);
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledOnce();
  });

  it('propagates indexed lookup cancellation without pagination or creation', async () => {
    const aborted = new DOMException('aborted', 'AbortError');
    lookupSessionsByTagsMock.mockRejectedValueOnce(aborted);

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_cancelled',
      source: { kind: 'codexHome', home: 'user' },
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 500,
      requireIndexedTagLookup: true,
      nowMs: () => 123,
    })).rejects.toBe(aborted);

    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('threads hook ingress currentness into the canonical session-creation commit', async () => {
    let releaseScan!: () => void;
    let creationShouldCommit: (() => boolean) | undefined;
    fetchSessionsPageMock.mockImplementationOnce(
      async () => await new Promise((resolve) => {
        releaseScan = () => resolve({
          sessions: [],
          hasNext: false,
          nextCursor: null,
        });
      }),
    );
    getOrCreateSessionByTagMock.mockImplementationOnce(
      async (input: Readonly<{ shouldCommit?: () => boolean }>) => {
        creationShouldCommit = input.shouldCommit;
        throw new Error('Session creation commit precondition failed');
      },
    );
    let shouldCommit = true;
    const pending = ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_retired_before_commit',
      source: { kind: 'codexHome', home: 'user' },
      shouldCommit: () => shouldCommit,
      nowMs: () => 123,
    });
    await vi.waitFor(() => {
      expect(fetchSessionsPageMock).toHaveBeenCalledOnce();
    });

    shouldCommit = false;
    releaseScan();

    await expect(pending).rejects.toThrow();
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledOnce();
    expect(creationShouldCommit?.()).toBe(false);
  });

  it('reuses a hosted session that already owns the same Agent-native resume identity', async () => {
    const hostedMetadata = {
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_hosted',
    };
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{
        id: 'sess_other_machine',
        metadata: { ...hostedMetadata, machineId: 'machine_2' },
      }, {
        id: 'sess_other_agent',
        metadata: { ...hostedMetadata, flavor: 'claude' },
      }, {
        id: 'sess_hosted',
        metadata: hostedMetadata,
        currentStorageState: 'hosted',
      }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata,
    );

    const result = await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_hosted',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    });

    expect(result).toEqual(expect.objectContaining({
      sessionId: 'sess_hosted',
      created: false,
    }));
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it.each([
    'machine_only',
    'server_partial',
    'snapshot_complete',
    'legacy_external_unknown',
    undefined,
  ] as const)('does not reuse a row with explicit %s storage state from vendor resume metadata alone', async (currentStorageState) => {
    const metadata = {
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_non_hosted',
    };
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{
        id: 'sess_non_hosted',
        metadata,
        currentStorageState,
      }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata,
    );
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_new_link', metadata: {} },
      created: true,
    });

    const result = await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_non_hosted',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    });

    expect(result).toEqual(expect.objectContaining({
      sessionId: 'sess_new_link',
      created: true,
    }));
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed before lookup when the consent-bound source key is no longer current', async () => {
    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_source_policy_changed',
      source: { kind: 'codexHome', home: 'user' },
      expectedSourceKey: 'codexHome:connectedService:retired-policy',
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'source_invalid',
      operation: 'externalSession.resolveSourceKey',
    });
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('reuses a hosted owner from the released server row shape that omits storage state', async () => {
    const metadata = {
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_released_hosted',
    };
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{ id: 'sess_released_hosted', metadata }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata,
    );

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_released_hosted',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    })).resolves.toEqual(expect.objectContaining({
      sessionId: 'sess_released_hosted',
      created: false,
    }));
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('reopens a converted import tombstone without restoring link metadata or machine-only storage', async () => {
    const source = {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected-codex-home',
    };
    const tag = `direct:v1:${sha256Hex(
      `machine_1|codex|thread_imported|${resolveExternalSessionsSourceKey(source)}`,
    )}`;
    const importedMetadata = {
      tag,
      machineId: 'machine_1',
      externalHistoryImportV1: {
        v: 1,
        agentId: 'codex',
        remoteSessionId: 'thread_imported',
        importedAtMs: 456,
        source,
      },
    };
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{ id: 'sess_imported', metadata: importedMetadata }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata,
    );

    const result = await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_imported',
      source,
      nowMs: () => 123,
    });

    expect(result).toEqual({
      sessionId: 'sess_imported',
      created: false,
      tag,
    });
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('persists Antigravity linked identity through the generic vendor-resume contract', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_antigravity_linked',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'antigravity',
      remoteSessionId: 'conversation-1',
      source: { kind: 'antigravityCliPrint', brainDir: null },
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      antigravitySessionId: 'conversation-1',
      externalSessionV1: {
        agentId: 'antigravity',
        remoteSessionId: 'conversation-1',
      },
    });
    expect(evaluateVendorResumeEligibility({
      agentId: 'antigravity',
      metadata: createdMetadata,
      accountSettings: {},
      linkedSessionCurrentAgent: {
        identity: {
          pluginId: 'happier.agent.antigravity',
          localId: 'antigravity',
        },
        sourceKinds: ['antigravityCliPrint'],
      },
    })).toEqual({
      eligible: true,
      vendorResumeId: 'conversation-1',
    });
  });
});
