import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateVendorResumeEligibility } from '@happier-dev/agents';
import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';
import {
  readLinkedExternalSessionV1FromMetadata,
  updateLinkedExternalSessionFollowMetadataV1,
  resolveExternalSessionsSourceKey,
  resolveExternalSessionsSourceKeysForPersistedTagLookup,
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
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
import type {
  AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  createAgentExternalSessionsExecutionSurface,
} from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import {
  createBoundedAgentExternalSessionsContribution,
  createUnavailableAgentExternalSessionsManagedEndpointRead,
} from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
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
const fetchAccountEncryptionCurrentnessMock = vi.fn();

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
    fetchAccountEncryptionCurrentnessMock(...args),
}));

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

const unavailableManagedEndpointRead =
  createUnavailableAgentExternalSessionsManagedEndpointRead();
const unavailableInvocationExec = createUnavailablePluginServices().exec;

function bindExternalSessionsFixture(
  contribution: AgentExternalSessionsContribution,
  agentId: string,
) {
  const pluginId = `happier.agent.${agentId}`;
  return createBoundedAgentExternalSessionsContribution({
    contribution,
    identity: {
      pluginId,
      agentId,
      generation: 'fixture-generation',
      contributionQualifiedId: `${pluginId}/agents/${agentId}`,
      immutableGenerationId: null,
    },
    isCurrent: () => true,
    retirementSignal: new AbortController().signal,
    createInvocationExec: async () => unavailableInvocationExec,
  });
}

const externalSessionSurfaces = new Map<ExternalSessionsAgentId, ExternalSessionExecutionSurface>([
  ['codex', createAgentExternalSessionsExecutionSurface(
    bindExternalSessionsFixture(codexExternalSessionsContribution, 'codex'),
  )],
  ['opencode', createAgentExternalSessionsExecutionSurface(
    bindExternalSessionsFixture(openCodeExternalSessionsContribution, 'opencode'),
  )],
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

function createDivergentCodexLinkedMetadata(params: Readonly<{
  tag: string;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>): Record<string, unknown> {
  return {
    tag: params.tag,
    machineId: 'machine_1',
    flavor: 'codex',
    codexSessionId: params.remoteSessionId,
    externalSessionV1: {
      v: 1,
      agentId: 'codex',
      machineId: 'machine_1',
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      linkedAtMs: 123,
    },
    directSessionV1: {
      v: 1,
      providerId: 'codex',
      machineId: 'machine_1',
      remoteSessionId: params.remoteSessionId,
      source: { kind: 'codexHome', home: 'custom' },
      linkedAtMs: 123,
    },
  };
}

type MutableLinkedMetadataFixture = Record<string, unknown> & {
  externalSessionV1: Record<string, unknown>;
  directSessionV1?: Record<string, unknown>;
};

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
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
      mode: 'e2ee',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: 'content-key-fingerprint',
      updatedAt: 1,
    });
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

  it.each([
    {
      name: 'same-kind source rewrite',
      resolvedIdentity: {
        remoteSessionId: 'remote-1',
        source: { kind: 'codexHome', home: 'rewritten' },
      },
    },
    {
      name: 'remote-session id rewrite',
      resolvedIdentity: {
        remoteSessionId: 'remote-2',
        source: { kind: 'codexHome', home: 'user' },
      },
    },
  ])('rejects a $name before tag lookup, create, or persistence', async ({
    resolvedIdentity,
  }) => {
    const resolveSourceKeyOwner = vi.fn();

    await expect(ensureExternalSessionLinkWithDeps({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    }, {
      resolveExternalSessionProviderOps: async () => ({
        resolveLinkIdentity: async () => resolvedIdentity,
      }),
      resolveCurrentAgent: vi.fn(),
      resolveSourceKeyOwner,
    })).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveLinkIdentity',
    });

    expect(resolveSourceKeyOwner).not.toHaveBeenCalled();
    expect(lookupSessionsByTagsMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('allows link identity resolution to add source fields without rewriting admitted identity', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_additive', metadata: {} },
      created: true,
    });

    await expect(ensureExternalSessionLinkWithDeps({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    }, {
      resolveExternalSessionProviderOps: async () => ({
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          remoteSessionId,
          source: { ...source, canonicalRoot: '/resolved/root' },
        }),
      }),
      resolveCurrentAgent: async () => ({
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        sourceKinds: ['codexHome'],
      }),
      resolveSourceKeyOwner: async (_agentId, source) => ({
        sourceKey: JSON.stringify(source),
        resolveSourceKey: (candidate) => JSON.stringify(candidate),
        resolvePersistedSourceKeys: (candidate) => [JSON.stringify(candidate)],
      }),
    })).resolves.toMatchObject({
      sessionId: 'sess_additive',
    });

    expect(getOrCreateSessionByTagMock).toHaveBeenCalledOnce();
    expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      externalSessionV1: {
        remoteSessionId: 'remote-1',
        source: {
          kind: 'codexHome',
          home: 'user',
          canonicalRoot: '/resolved/root',
        },
      },
    });
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
      remoteSessionId: 'thread_runtime',
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
    });
    expect(createdMetadata).not.toHaveProperty('directSessionV1');
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
      tag: legacyTag,
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
    fetchAccountEncryptionCurrentnessMock.mockResolvedValueOnce({
      mode: 'plain',
      version: 2,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 2,
    });
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
    const ownerMetadataEnvelope =
      createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const splitLayoutArchivedRow = {
      id: 'sess_split_group',
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: ownerMetadataEnvelope,
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
      accountEncryptionMode: 'plain',
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
      accountEncryptionMode: 'e2ee',
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

  it('reuses an A13-proven persisted tag twice without rewriting its legacy lookup identity', async () => {
    const legacyTag = `direct:v1:${sha256Hex('machine_1|opencode|oc_legacy_tag|opencodeServer:http://127.0.0.1:4096:/tmp/repo')}`;
    const canonicalTag = `direct:v1:${sha256Hex('machine_1|opencode|oc_legacy_tag|opencodeServer:http%3A//127.0.0.1%3A4096:/tmp/repo')}`;
    let existingMetadata: Record<string, unknown> = {
      tag: legacyTag,
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'oc_legacy_tag',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:4096',
          directory: '/tmp/repo',
        },
        linkedAtMs: 1,
      },
    };
    lookupSessionsByTagsMock.mockImplementation(async ({ tags }: { tags: string[] }) => {
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
    fetchSessionByIdMock.mockImplementation(async () => ({
      id: 'sess_legacy_tag',
      metadata: 'encrypted-metadata-placeholder',
      currentStorageState: 'machine_only',
    }));
    tryDecryptSessionMetadataMock.mockImplementation(() => existingMetadata);
    updateSessionMetadataWithRetryMock.mockImplementation(async (
      { updater }: { updater: (metadata: Record<string, unknown>) => Record<string, unknown> },
    ) => {
      existingMetadata = updater(existingMetadata);
    });
    getOrCreateSessionByTagMock.mockResolvedValue({
      session: { id: 'sess_legacy_tag', metadata: 'encrypted-metadata-placeholder' },
      created: false,
    });

    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'opencode',
      remoteSessionId: 'oc_legacy_tag',
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:4096',
        directory: '/tmp/repo',
      },
      directoryHint: '/tmp/repo',
      nowMs: () => 123,
    } as const;
    const firstResult = await ensureExternalSessionLink(input);
    const secondResult = await ensureExternalSessionLink(input);

    expect(firstResult).toEqual({ sessionId: 'sess_legacy_tag', created: false, tag: canonicalTag });
    expect(secondResult).toEqual(firstResult);
    expect(lookupSessionsByTagsMock).toHaveBeenCalledTimes(2);
    expect(fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledTimes(2);
    expect(getOrCreateSessionByTagMock.mock.calls.every(
      ([call]) => call.tag === legacyTag && call.currentStorageState === 'machine_only',
    )).toBe(true);
    expect(existingMetadata).toMatchObject({ tag: legacyTag });
    expect(readLinkedExternalSessionV1FromMetadata(existingMetadata)).toMatchObject({
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

  it('never copies connected-service credentials from a same-directory marker owned by a different native session', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 999,
        happySessionId: 'sess_neighbour',
        happyHomeDir: '/tmp/happier-test-home',
        createdAt: 1,
        updatedAt: 10,
        flavor: 'codex',
        cwd: '/repo',
        metadata: {
          flavor: 'codex',
          codexSessionId: 'thread_neighbour',
          connectedServices,
          connectedServicesUpdatedAt: 456,
        },
        respawn: {
          resume: 'thread_neighbour',
          directory: '/repo',
          connectedServiceMaterializationIdentityV1: materializationIdentity,
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_unowned',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_mine',
      source: { kind: 'codexHome', home: 'user' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).not.toHaveProperty('connectedServices');
    expect(createdMetadata).not.toHaveProperty('connectedServicesUpdatedAt');
    expect(createdMetadata).not.toHaveProperty('connectedServiceMaterializationIdentityV1');
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
      remoteSessionId: 'thread_runtime',
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
    staleMetadata.externalSessionV1.followStatusV1 = {
      v: 1,
      status: 'active',
      reason: 'viewer_attached',
      updatedAtMs: 121,
    };
    staleMetadata.externalSessionV1.lastFollowIssueV1 = {
      v: 1,
      code: 'follow_refresh_failed',
      retryable: true,
      observedAtMs: 122,
    };
    delete staleMetadata.runtimeDescriptorV1;
    delete staleMetadata.externalSessionV1.runtimeDescriptorV1;
    delete staleMetadata.externalSessionV1.linkData.runtimeDescriptorV1;
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
    expect(refreshedMetadata).not.toHaveProperty('directSessionV1');
    expect(refreshedMetadata).not.toHaveProperty('externalAgentObservationV1');
    expect(Reflect.get(refreshedMetadata ?? {}, 'externalSessionV1')).not.toHaveProperty('followStatusV1');
    expect(Reflect.get(refreshedMetadata ?? {}, 'externalSessionV1')).not.toHaveProperty('lastFollowIssueV1');
  });

  it.each([
    {
      label: 'same-declaration relink',
      expectedError: 'linked_session_identity_mismatch',
      mutate: (metadata: MutableLinkedMetadataFixture) => {
        metadata.externalSessionV1 = {
          ...metadata.externalSessionV1,
          remoteSessionId: 'thread_refresh_relinked',
          source: { kind: 'opencodeServer', directory: '/repo/relinked' },
          linkedAtMs: 124,
        };
      },
    },
    {
      label: 'reconciliation-required snapshot',
      expectedError: 'linked_session_reconciliation_required',
      mutate: (metadata: MutableLinkedMetadataFixture) => {
        // This is a released row supplied by an old writer. Current link
        // creation remains canonical-only; dual rows are reader input only.
        metadata.directSessionV1 = {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine_1',
          remoteSessionId: 'thread_refresh_original',
          source: { kind: 'opencodeServer', directory: '/repo/original' },
          linkedAtMs: 123,
        };
        metadata.externalSessionV1 = {
          ...metadata.externalSessionV1,
          source: { kind: 'opencodeServer', directory: '/repo/divergent' },
        };
      },
    },
    {
      label: 'invalid linked snapshot',
      expectedError: 'linked_session_invalid',
      mutate: (metadata: MutableLinkedMetadataFixture) => {
        metadata.externalSessionV1 = { v: 1, agentId: 'opencode' };
        delete metadata.directSessionV1;
      },
    },
  ])('rejects a $label that wins during metadata refresh', async ({ mutate, expectedError }) => {
    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'opencode' as const,
      remoteSessionId: 'thread_refresh_original',
      source: { kind: 'opencodeServer' as const, directory: '/repo/original' },
      titleHint: 'Refreshed original link',
      nowMs: () => 123,
    };
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_refresh_race', metadata: {} },
    });
    await ensureExternalSessionLink({ ...input, titleHint: 'Original link' });
    const originalMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    const concurrentMetadata = JSON.parse(
      JSON.stringify(originalMetadata),
    ) as MutableLinkedMetadataFixture;
    mutate(concurrentMetadata);
    const existingRawSession = {
      id: 'sess_refresh_race',
      metadata: 'encrypted-metadata-placeholder',
    };

    getOrCreateSessionByTagMock.mockClear();
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [existingRawSession],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionByIdMock.mockResolvedValue(existingRawSession);
    tryDecryptSessionMetadataMock.mockImplementation(({ rawSession }: { rawSession?: unknown }) =>
      rawSession === existingRawSession ? originalMetadata : null,
    );
    updateSessionMetadataWithRetryMock.mockImplementationOnce(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      updater(concurrentMetadata);
    });

    await expect(ensureExternalSessionLink({
      ...input,
      directoryHint: '/repo/presentation',
    })).rejects.toMatchObject({
      code: 'conflict',
      message: expectedError,
    });
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledOnce();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('preserves a newer released-row follow policy during a same-link metadata refresh', async () => {
    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex' as const,
      remoteSessionId: 'thread_reconciled_policy',
      source: { kind: 'codexHome' as const, home: 'user' as const },
      nowMs: () => 123,
    };
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_reconciled_policy', metadata: {} },
    });
    await ensureExternalSessionLink(input);
    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    const {
      agentId: legacyAgentId,
      qualifiedIdentity: _canonicalQualifiedIdentity,
      linkData: _canonicalLinkData,
      runtimeDescriptorV1: legacyRuntimeDescriptor,
      ...releasedLinkFields
    } = createdMetadata.externalSessionV1;
    const currentMetadata = {
      ...createdMetadata,
      externalSessionV1: {
        ...createdMetadata.externalSessionV1,
        followPolicyV1: {
          v: 1,
          policy: 'attached_only',
          updatedAtMs: 1,
        },
      },
      directSessionV1: {
        // A released dual-row snapshot is accepted only as reader input.
        ...releasedLinkFields,
        providerId: legacyAgentId,
        ...(legacyRuntimeDescriptor === undefined
          ? {}
          : { agentRuntimeDescriptorV1: legacyRuntimeDescriptor }),
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 2,
        },
      },
    };
    delete currentMetadata.externalSessionV1.qualifiedIdentity;
    const rawSession = {
      id: 'sess_reconciled_policy',
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

    expect(Reflect.get(refreshedMetadata ?? {}, 'externalSessionV1')).toMatchObject({
      followPolicyV1: {
        policy: 'background_follow',
        updatedAtMs: 2,
      },
    });
    expect(refreshedMetadata).not.toHaveProperty('directSessionV1');
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
    const followStatusV1 = {
      v: 1,
      status: 'active',
      reason: 'viewer_attached',
      updatedAtMs: 121,
    } as const;
    const lastFollowIssueV1 = {
      v: 1,
      code: 'follow_refresh_recovered',
      retryable: false,
      observedAtMs: 122,
    } as const;
    const metadataWithFollow = updateLinkedExternalSessionFollowMetadataV1(
      createdMetadata,
      { followStatusV1, lastFollowIssueV1 },
    );
    const currentMetadata = {
      ...metadataWithFollow,
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
    expect(Reflect.get(refreshedMetadata ?? {}, 'externalSessionV1')).toMatchObject({
      followStatusV1,
      lastFollowIssueV1,
    });
    expect(refreshedMetadata).not.toHaveProperty('directSessionV1');
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
      remoteSessionId: 'thread_runtime',
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
      remoteSessionId: 'thread_runtime',
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
      remoteSessionId: 'oc_runtime',
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
      remoteSessionId: 'oc_runtime',
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
      remoteSessionId: 'oc_runtime',
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
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
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
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
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
        ownerMetadata: {
          t: 'encrypted',
          c: 'account-encrypted-owner-envelope',
        },
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
      accountEncryptionMode: 'e2ee',
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

  it('threads caller cancellation through the legacy metadata recovery scan', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('aborted', 'AbortError');
    lookupSessionsByTagsMock.mockResolvedValueOnce({ state: 'unavailable' });
    fetchSessionsPageMock.mockRejectedValueOnce(aborted);

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_legacy_scan_cancelled',
      source: { kind: 'codexHome', home: 'user' },
      signal: controller.signal,
      nowMs: () => 123,
    })).rejects.toBe(aborted);

    expect(fetchSessionsPageMock).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
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

  it('rejects an indexed exact-tag row whose canonical and rollback links require reconciliation', async () => {
    const sourceInput = { kind: 'codexHome' as const, home: 'user' as const };
    const resolvedIdentity = await codexExternalSessionsContribution.resolveLinkIdentity({
      source: sourceInput,
      remoteSessionId: 'thread_indexed_reconciliation',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 5_000,
      maxSerializedBytes: 262_144,
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
    });
    if (!resolvedIdentity.ok) throw new Error('Expected Codex identity resolution');
    const source = resolvedIdentity.value.source;
    const lookupCandidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed_reconciliation',
      source,
      releasedPersistedSource: sourceInput,
      sourceKey: resolveExternalSessionsSourceKey(source),
      releasedSourceKeys:
        resolveExternalSessionsSourceKeysForPersistedTagLookup(sourceInput),
    });
    const metadata = createDivergentCodexLinkedMetadata({
      tag: lookupCandidates[0].tag,
      remoteSessionId: 'thread_indexed_reconciliation',
      source,
    });
    lookupSessionsByTagsMock.mockResolvedValueOnce({
      state: 'available',
      tags: lookupCandidates.map((candidate) => candidate.tag),
      sessions: [{
        id: 'sess_indexed_reconciliation',
        metadata,
        currentStorageState: 'hosted',
      }],
    });
    tryDecryptSessionMetadataMock.mockReturnValue(metadata);

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed_reconciliation',
      source: sourceInput,
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'conflict',
      operation: 'externalSession.lookupByTags',
    });

    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('rejects an indexed exact-tag row whose linked-session metadata is invalid', async () => {
    const sourceInput = { kind: 'codexHome' as const, home: 'user' as const };
    const resolvedIdentity = await codexExternalSessionsContribution.resolveLinkIdentity({
      source: sourceInput,
      remoteSessionId: 'thread_indexed_invalid',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 5_000,
      maxSerializedBytes: 262_144,
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
    });
    if (!resolvedIdentity.ok) throw new Error('Expected Codex identity resolution');
    const source = resolvedIdentity.value.source;
    const lookupCandidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed_invalid',
      source,
      releasedPersistedSource: sourceInput,
      sourceKey: resolveExternalSessionsSourceKey(source),
      releasedSourceKeys:
        resolveExternalSessionsSourceKeysForPersistedTagLookup(sourceInput),
    });
    const metadata = {
      tag: lookupCandidates[0].tag,
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_indexed_invalid',
      externalSessionV1: { v: 1, agentId: 'codex' },
    };
    lookupSessionsByTagsMock.mockResolvedValueOnce({
      state: 'available',
      tags: lookupCandidates.map((candidate) => candidate.tag),
      sessions: [{
        id: 'sess_indexed_invalid',
        metadata,
        currentStorageState: 'hosted',
      }],
    });
    tryDecryptSessionMetadataMock.mockReturnValue(metadata);

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_indexed_invalid',
      source: sourceInput,
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'conflict',
      operation: 'externalSession.lookupByTags',
    });

    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
  });

  it('rejects a bounded-scan hosted identity whose canonical and rollback links require reconciliation', async () => {
    const sourceInput = { kind: 'codexHome' as const, home: 'user' as const };
    const resolvedIdentity = await codexExternalSessionsContribution.resolveLinkIdentity({
      source: sourceInput,
      remoteSessionId: 'thread_scanned_reconciliation',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 5_000,
      maxSerializedBytes: 262_144,
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
    });
    if (!resolvedIdentity.ok) throw new Error('Expected Codex identity resolution');
    const source = resolvedIdentity.value.source;
    const lookupCandidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_scanned_reconciliation',
      source,
      releasedPersistedSource: sourceInput,
      sourceKey: resolveExternalSessionsSourceKey(source),
      releasedSourceKeys:
        resolveExternalSessionsSourceKeysForPersistedTagLookup(sourceInput),
    });
    const metadata = createDivergentCodexLinkedMetadata({
      tag: lookupCandidates[0].tag,
      remoteSessionId: 'thread_scanned_reconciliation',
      source,
    });
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{
        id: 'sess_scanned_reconciliation',
        metadata,
        currentStorageState: 'hosted',
      }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockReturnValue(metadata);

    await expect(ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_scanned_reconciliation',
      source: sourceInput,
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'conflict',
      operation: 'externalSession.lookupByTags',
    });

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

  it('rejects a malformed present import tombstone before hosted lookup reuse or link effects', async () => {
    const metadata = {
      tag: 'direct:v1:malformed-import-tombstone',
      machineId: 'machine_1',
      flavor: 'codex',
      codexSessionId: 'thread_malformed_tombstone',
      externalHistoryImportV1: {
        v: 1,
        providerId: 'codex',
        remoteSessionId: 'thread_malformed_tombstone',
        importedAtMs: 100,
        source: { kind: 'codexHome', home: 'user' },
        linkData: { projectId: 'canonical-only' },
      },
    };
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{ id: 'sess_malformed_tombstone', metadata }],
      hasNext: false,
      nextCursor: null,
    });
    tryDecryptSessionMetadataMock.mockImplementation(
      ({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata,
    );

    await expect(ensureExternalSessionLink({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      machineId: 'machine_1',
      agentId: 'codex',
      remoteSessionId: 'thread_malformed_tombstone',
      source: { kind: 'codexHome', home: 'user' },
      nowMs: () => 123,
    })).rejects.toMatchObject({
      code: 'conflict',
      message: 'external_history_import_invalid',
    });
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('reopens a released converted import tombstone without restoring link metadata or machine-only storage', async () => {
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
        providerId: 'codex',
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

  it('keeps host identity and custody authoritative when an Agent link payload collides with owner metadata', async () => {
    const source = { kind: 'syntheticExternal', root: '/synthetic' } as const;
    const hostileLinkData = {
      tag: 'attacker-tag',
      path: '/attacker/path',
      host: 'attacker-host',
      machineId: 'attacker-machine',
      flavor: 'attacker-flavor',
      agentId: 'attacker-agent',
      remoteSessionId: 'attacker-remote',
      // Same source kind as the admitted source: a shadowed identity a strict
      // schema cannot reject, unlike an obviously foreign kind.
      source: { kind: 'syntheticExternal', root: '/attacker' },
      linkedAtMs: 1,
      claudeSessionId: 'attacker-session',
      syntheticSessionId: 'attacker-session',
      projectId: 'attacker-project',
      qualifiedIdentity: {
        v: 1,
        agent: { pluginId: 'happier.agent.attacker', localId: 'attacker' },
        source: { kind: 'syntheticExternal', contractVersion: 1 },
      },
    };
    const contribution: AgentExternalSessionsContribution = {
      resolveSource: async ({ source: requested }) => ({ ok: true, value: { source: requested } }),
      listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
      resolveLinkIdentity: async ({ source: requested, remoteSessionId }) => ({
        ok: true,
        value: { source: requested, remoteSessionId, linkData: hostileLinkData },
      }),
      resolveLinkedIdentity: async ({ source: requested, remoteSessionId }) => ({
        ok: true,
        value: { source: requested, remoteSessionId, linkData: hostileLinkData },
      }),
      pageTranscript: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readAfterTranscript: async () => ({ ok: true, value: { outcome: 'already_current' } }),
    };
    const surface = createAgentExternalSessionsExecutionSurface(
      bindExternalSessionsFixture(contribution, 'synthetic'),
    );
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_synthetic_link', metadata: {} },
      created: true,
    });

    const { tag } = await ensureExternalSessionLinkWithDeps({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      agentId: 'synthetic',
      remoteSessionId: 'remote-1',
      source,
      directoryHint: '/host/path',
      nowMs: () => 123,
    }, {
      resolveExternalSessionProviderOps: async () => surface,
      resolveCurrentAgent: async () => ({
        identity: { pluginId: 'happier.agent.synthetic', localId: 'synthetic' },
        sourceKinds: ['syntheticExternal'],
      }),
      // A third-party Agent's source kind is not in the built-in catalog, so the
      // owner is resolved from the contributed source itself.
      resolveSourceKeyOwner: async (_agentId, candidateSource) => ({
        sourceKey: JSON.stringify(candidateSource),
        resolveSourceKey: (candidate: ExternalSessionsSource) => JSON.stringify(candidate),
        resolvePersistedSourceKeys: (candidate: ExternalSessionsSource) => [JSON.stringify(candidate)],
      }),
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(createdMetadata).toMatchObject({
      tag,
      path: '/host/path',
      host: hostname(),
      machineId: 'machine_1',
      flavor: 'synthetic',
    });
    expect(createdMetadata.externalSessionV1).toMatchObject({
      v: 1,
      agentId: 'synthetic',
      machineId: 'machine_1',
      remoteSessionId: 'remote-1',
      source,
      linkedAtMs: 123,
      qualifiedIdentity: {
        v: 1,
        agent: { pluginId: 'happier.agent.synthetic', localId: 'synthetic' },
      },
      linkData: hostileLinkData,
    });
    // The Agent payload survives only inside its own nested carrier: nothing
    // else in the persisted envelope may carry an Agent-authored value.
    const persistedWithoutLinkData = JSON.parse(JSON.stringify(createdMetadata)) as Record<string, unknown>;
    delete (persistedWithoutLinkData.externalSessionV1 as Record<string, unknown>).linkData;
    delete (persistedWithoutLinkData.directSessionV1 as Record<string, unknown> | undefined)?.linkData;
    expect(JSON.stringify(persistedWithoutLinkData)).not.toContain('attacker');

    expect(createSessionOwnerMetadataV1({ metadata: createdMetadata })).toMatchObject({
      ok: true,
      ownerMetadata: { nativeSession: { tag } },
    });
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
