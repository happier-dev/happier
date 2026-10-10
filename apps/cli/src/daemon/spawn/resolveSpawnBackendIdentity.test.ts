import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import type {
  ExistingSessionAttachContext,
  ExistingSessionAttachContextFailure,
} from '../sessionEncryption/resolveExistingSessionAttachContext';

const {
  readStoredCredentialsMock,
  resolveExistingSessionAttachContextMock,
} = vi.hoisted(() => ({
  readStoredCredentialsMock: vi.fn(async (): Promise<StoredCredentials | null> => null),
  resolveExistingSessionAttachContextMock: vi.fn(async (): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> => ({
    ok: true,
    metadata: null,
    attachPayload: { v: 2, encryptionMode: 'plain' },
    vendorResumeId: null,
    backendTarget: null,
  })),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: readStoredCredentialsMock,
}));

vi.mock('../sessionEncryption/resolveExistingSessionAttachContext', () => ({
  resolveExistingSessionAttachContext: resolveExistingSessionAttachContextMock,
}));

import { resolveSpawnBackendIdentity } from './resolveSpawnBackendIdentity';
import { createCustomAcpAdmissionRuntimeFixture } from '../startup/customAcpAdmission.testkit';

let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
beforeAll(async () => { runtime = await createCustomAcpAdmissionRuntimeFixture(); });
afterAll(async () => { await runtime?.dispose(); });
beforeEach(() => { readStoredCredentialsMock.mockClear(); });

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
  afterEach(() => {
    readStoredCredentialsMock.mockReset();
    readStoredCredentialsMock.mockResolvedValue(null);
    resolveExistingSessionAttachContextMock.mockReset();
    resolveExistingSessionAttachContextMock.mockResolvedValue({
      ok: true,
      metadata: null,
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

  it('requires canonical attach identity instead of reviving a local handoff overlay backend identity', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 4);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      metadata: null,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: 'sess-handoff-direct',
      backendTarget: null,
    });
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff-source',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
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

  it('rejects a resume whose canonical attach context has no backend target', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 16);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      metadata: null,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: 'sess-handoff-direct',
      backendTarget: null,
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff-source',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
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

  it('does not infer an external Agent identity from retired handoff metadata', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 14);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      metadata: null,
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

  it('fails closed when an external Agent is unavailable rather than falling back to Claude', async () => {
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'acme-agent', sourceKind: 'built_in' },
      credentials: createLegacyCredentials('live-token', 15),
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
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-linked-stale',
      resume: 'caller-supplied-stale-id',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' },
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
  });

  it('uses the verified linked vendor resume id instead of a caller-supplied resume id', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 13);
    resolveExistingSessionAttachContextMock.mockResolvedValueOnce({
      ok: true,
      metadata: null,
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
      metadata: null,
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
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'custom-acp',
        sourceKind: 'built_in',
      },
      effectiveAgentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
      catalogAgentId: 'custom-acp',
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
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'custom-acp',
        sourceKind: 'built_in',
      },
      effectiveAgentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
      catalogAgentId: 'custom-acp',
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

describe('resolveSpawnBackendIdentity opaque Agent resume id', () => {
  /** The Agent minted these bytes; the daemon hands them straight back. */
  const OPAQUE_RESUME_ID = ' provider\nsession ';

  afterEach(() => {
    readStoredCredentialsMock.mockReset();
    readStoredCredentialsMock.mockResolvedValue(null);
  });

  it('carries the exact resume bytes into the resolved backend identity', async () => {
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: OPAQUE_RESUME_ID,
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: null,
    });

    expect(result).toMatchObject({ ok: true, effectiveResume: OPAQUE_RESUME_ID });
  });

  it('does not use resume bytes as a retired local metadata lookup key', async () => {
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff',
      resume: OPAQUE_RESUME_ID,
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: null,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it('adopts an attached Session vendor resume id without renormalizing its bytes', async () => {
    resolveExistingSessionAttachContextMock.mockResolvedValue({
      ok: true,
      metadata: null,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: OPAQUE_RESUME_ID,
      backendTarget: null,
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-attached',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: null,
    });

    expect(result).toMatchObject({ ok: true, effectiveResume: OPAQUE_RESUME_ID });
  });
});
