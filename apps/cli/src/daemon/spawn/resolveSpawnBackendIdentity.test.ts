import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import type {
  ExistingSessionAttachContext,
  ExistingSessionAttachContextFailure,
} from '../sessionEncryption/resolveExistingSessionAttachContext';

const {
  readStoredCredentialsMock,
  readAgentCatalogSnapshotMock,
  resolveExistingSessionAttachContextMock,
} = vi.hoisted(() => ({
  readStoredCredentialsMock: vi.fn(async (): Promise<StoredCredentials | null> => null),
  readAgentCatalogSnapshotMock: vi.fn(),
  resolveExistingSessionAttachContextMock: vi.fn(async (): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> => ({
    ok: true,
    attachPayload: { v: 2, encryptionMode: 'plain' },
    vendorResumeId: null,
    backendTarget: null,
  })),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: readStoredCredentialsMock,
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot: readAgentCatalogSnapshotMock,
}));

vi.mock('../sessionEncryption/resolveExistingSessionAttachContext', () => ({
  resolveExistingSessionAttachContext: resolveExistingSessionAttachContextMock,
}));

import { resolveSpawnBackendIdentity } from './resolveSpawnBackendIdentity';

function createLegacyCredentials(token: string, seed: number): Credentials {
  return {
    token,
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(seed),
    },
  };
}

describe('resolveSpawnBackendIdentity credential precedence', () => {
  beforeEach(() => {
    readAgentCatalogSnapshotMock.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        codex: { id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported' },
        claude: { id: 'claude', cliSubcommand: 'claude', vendorResumeSupport: 'supported' },
        antigravity: { id: 'antigravity', cliSubcommand: 'antigravity', vendorResumeSupport: 'supported' },
        'acme-agent': {
          id: 'acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
  });

  afterEach(() => {
    readStoredCredentialsMock.mockReset();
    readStoredCredentialsMock.mockResolvedValue(null);
    resolveExistingSessionAttachContextMock.mockReset();
    resolveExistingSessionAttachContextMock.mockResolvedValue({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: null,
      backendTarget: null,
    });
  });

  it('prefers caller-provided credentials over persisted credentials for existing-session attach context', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 1);
    const stalePersistedCredentials = createLegacyCredentials('stale-token', 9);
    readStoredCredentialsMock.mockResolvedValueOnce(stalePersistedCredentials);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-live',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result.ok).toBe(true);
    expect(resolveExistingSessionAttachContextMock).toHaveBeenCalledTimes(1);
    expect(resolveExistingSessionAttachContextMock).toHaveBeenCalledWith({
      token: 'live-token',
      sessionId: 'sess-live',
      credentials: liveCredentials,
    });
    expect(readStoredCredentialsMock).not.toHaveBeenCalled();
  });

  it('accepts canonical V2 backend targets directly on the spawn path', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 11);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-live-v2',
      resume: '',
      agentTarget: undefined,
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      catalogAgentId: 'codex',
    });
  });

  it('falls back to persisted credentials only when caller credentials are null', async () => {
    const persistedCredentials: StoredCredentials = {
      token: 'persisted-token',
      encryption: null,
    };
    readStoredCredentialsMock.mockResolvedValueOnce(persistedCredentials);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-persisted',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: null,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result.ok).toBe(true);
    expect(readStoredCredentialsMock).toHaveBeenCalledTimes(1);
    expect(resolveExistingSessionAttachContextMock).toHaveBeenCalledTimes(1);
    expect(resolveExistingSessionAttachContextMock).toHaveBeenCalledWith({
      token: 'persisted-token',
      sessionId: 'sess-persisted',
      credentials: persistedCredentials,
    });
  });

  it('backfills resume from attach context before loading local handoff overlay backend identity', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 4);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: 'sess-handoff-direct',
      backendTarget: null,
    });
    const loadLocalHandoffMetadataByVendorResumeId = vi.fn(async (vendorResumeId: string) =>
      vendorResumeId === 'sess-handoff-direct'
        ? {
            handoffV1: {
              v: 1,
              providerId: 'claude',
            },
          }
        : null,
    );

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff-source',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveResume: 'sess-handoff-direct',
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      catalogAgentId: 'claude',
    });
    expect(loadLocalHandoffMetadataByVendorResumeId).toHaveBeenCalledWith('sess-handoff-direct');
  });

  it('uses an active external Agent handoff identity without substituting a bundled Agent', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 14);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: 'acme-session-1',
      backendTarget: null,
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-external',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => ({
        handoffV1: { v: 1, agentId: 'acme-agent' },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'acme-agent',
        sourceKind: 'built_in',
      },
      catalogAgentId: 'acme-agent',
    });
  });

  it('fails closed when an external Agent is unavailable rather than falling back to Claude', async () => {
    readAgentCatalogSnapshotMock.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        codex: { id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported' },
      },
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'acme-agent', sourceKind: 'built_in' },
      credentials: createLegacyCredentials('live-token', 15),
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown backend target',
      },
    });
  });

  it('refuses an existing-session spawn when linked resume identity is unavailable', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 12);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: false,
      reason: 'linkedResumeIdentityUnavailable',
    });
    const loadLocalHandoffMetadataByVendorResumeId = vi.fn(async () => null);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-linked-stale',
      resume: 'caller-supplied-stale-id',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' },
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
    expect(loadLocalHandoffMetadataByVendorResumeId).not.toHaveBeenCalled();
  });

  it('uses the verified linked vendor resume id instead of a caller-supplied resume id', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 13);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: 'verified-linked-id',
      linkedVendorResumeId: 'verified-linked-id',
      backendTarget: { kind: 'builtInAgent', agentId: 'antigravity' },
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-linked-current',
      resume: 'caller-supplied-stale-id',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' },
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveResume: 'verified-linked-id',
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'antigravity',
        sourceKind: 'built_in',
      },
    });
  });

  it('preserves configured ACP backend targets as canonical V2 targets', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 5);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: null,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-configured',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      catalogAgentId: null,
    });
  });

  it('canonicalizes configured ACP targets that still carry the legacy customAcp family marker', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 8);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcp',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      } as never,
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      catalogAgentId: null,
    });
  });

  it('fails closed when a fresh spawn explicitly provides customAcp as a built-in backend target', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 6);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'customAcp', sourceKind: 'built_in' },
      credentials: liveCredentials,
      loadLocalHandoffMetadataByVendorResumeId: async () => null,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown Agent or backend target',
      },
    });
  });
});
