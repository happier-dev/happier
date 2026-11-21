import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStateSchema } from '@happier-dev/session-core/state';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { EncryptionScopeInput } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { SecretBoxEncryption } from '@/sync/encryption/encryptor';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { createSessionAccessFixture, createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
  buildNewSessionFromSocketUpdate,
  buildUpdatedSessionFromSocketUpdate,
  buildUpdatedSessionListRenderablePatchFromSocketUpdate,
} from './syncSessions';

function createSession(params: { sessionId: string; encryptionMode: 'plain' | 'e2ee' }): Session {
  const now = 1_700_000_000_000;
  return {
    id: params.sessionId,
    seq: 1,
    encryptionMode: params.encryptionMode,
    createdAt: now,
    updatedAt: now,
    active: true,
    activeAt: now,
    metadata: { path: '/tmp', host: 'localhost' },
    metadataVersion: 1,
    agentState: {},
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    optimisticThinkingAt: null,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('buildUpdatedSessionFromSocketUpdate (plaintext)', () => {
  it('applies a key-only publication to locked list rows without opening metadata or reopening the Session', async () => {
    const renderable = createSessionListRenderableSessionFixture({ id: 'accepted-key', metadata: null,
      encryptedContentAvailability: 'encrypted_content_unavailable', projectKey: null });
    const params = { renderable, updateBody: { projectKey: 'anchor' }, updateSeq: 2, updateCreatedAt: 2, sessionEncryption: null };
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate(params);
    expect({ ...renderable, ...patch }).toMatchObject({ projectKey: 'anchor', metadata: null });
    const { buildSessionListViewData } = await import('@/sync/domains/session/listing/sessionListViewData');
    const projected = { ...renderable, ...patch };
    const index = buildSessionListViewData({ [projected.id]: projected }, {}, { layoutV1: 'projects', serverScope: { serverId: 'home-a' } });
    expect(index.find(item => item.type === 'header' && item.headerKind === 'project')?.groupKey)
      .toBe(JSON.stringify(['project', 'home-a', 'anchor']));
    const omitted = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({ ...params, renderable: projected, updateBody: {} });
    expect({ ...projected, ...omitted }.projectKey).toBe('anchor');
  });
  it('retains the same observed presence in detail and list projections across durable active updates', async () => {
    for (const presence of ['online', 123, undefined] as const) {
      const session = createSessionFixture({ encryptionMode: 'plain', active: true, presence });
      const renderable = createSessionListRenderableSessionFixture({ encryptionMode: 'plain', active: true, presence });
      const update = { updateBody: { active: true, activeAt: session.activeAt + 1 },
        updateSeq: 2, updateCreatedAt: session.updatedAt + 1, sessionEncryption: null };
      const detail = await buildUpdatedSessionFromSocketUpdate({ ...update, session });
      const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({ ...update, renderable });
      expect(detail.nextSession.presence).toBe(presence);
      expect({ ...renderable, ...patch }.presence).toBe(presence);
    }
  });

  it.each([
    { name: 'opened owner', layout: 1, access: createSessionAccessFixture(), ownerMetadataView: { path: '/private', host: 'localhost' }, availability: 'ready' as const, retained: true },
    { name: 'recipient with a stale owner view', layout: 1, access: createSessionAccessFixture('view'), ownerMetadataView: { path: '/private', host: 'localhost' }, availability: 'ready' as const, retained: false },
    { name: 'unavailable access with a stale owner view', layout: 1, access: null, ownerMetadataView: { path: '/private', host: 'localhost' }, availability: 'ready' as const, retained: false },
    { name: 'unopened owner', layout: 1, access: createSessionAccessFixture(), ownerMetadataView: null, availability: 'ready' as const, retained: false },
    { name: 'locked owner visibility', layout: 1, access: createSessionAccessFixture(), ownerMetadataView: { path: '/private', host: 'localhost' }, availability: 'encrypted_content_unavailable' as const, retained: false },
    { name: 'unsupported layout', layout: 2, access: createSessionAccessFixture(), ownerMetadataView: { path: '/private', host: 'localhost' }, availability: 'ready' as const, retained: false },
    { name: 'legacy layout', layout: 0, access: createSessionAccessFixture('view'), ownerMetadataView: null, availability: 'ready' as const, retained: true },
  ])('uses $name authority for both new and retained AgentState', async ({ layout, access, ownerMetadataView, availability, retained }) => {
    const state = AgentStateSchema.parse({ controlledByUser: true, requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } });
    const session = createSessionFixture({ metadataLayoutVersion: layout, access, ownerMetadataView,
      encryptedContentAvailability: availability, agentState: state });
    const updated = await buildUpdatedSessionFromSocketUpdate({ session,
      updateBody: { metadataLayoutVersion: layout, agentState: { version: 2, value: JSON.stringify(state) } },
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: null });
    expect(updated.agentState).toEqual(retained ? state : null);
    const withoutPayload = await buildUpdatedSessionFromSocketUpdate({ session,
      updateBody: { metadataLayoutVersion: layout, active: true }, updateSeq: 2, updateCreatedAt: 2, sessionEncryption: null });
    expect(withoutPayload.agentState).toBe(retained ? state : null);
    const renderable = createSessionListRenderableSessionFixture({ metadataLayoutVersion: layout, access,
      metadata: ownerMetadataView ? { path: '/private' } : null, encryptedContentAvailability: availability });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({ renderable,
      updateBody: { metadataLayoutVersion: layout, agentState: { version: 2, value: JSON.stringify(state) } },
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: null });
    expect(patch.hasPendingPermissionRequests).toBe(retained);
  });

  it('contracts owner AgentState when the same encrypted socket tuple fails shared-metadata authentication', async () => {
    const state = AgentStateSchema.parse({ requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } });
    const session = createSessionFixture({ metadataLayoutVersion: 1, encryptionMode: 'e2ee',
      ownerMetadataView: { path: '/private', host: 'localhost' }, agentState: state });
    const reader = new SessionEncryption(session.id, new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
    const updateBody = { metadataLayoutVersion: 1, metadata: { version: 2, value: 'invalid-ciphertext' },
      agentState: { version: 2, value: await reader.encryptRaw(state) } };
    const updated = await buildUpdatedSessionFromSocketUpdate({ session, updateBody,
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: reader });
    expect(updated.nextSession.encryptedContentAvailability).toBe('encrypted_content_unavailable');
    expect(updated.agentState).toBeNull();
    const renderable = createSessionListRenderableSessionFixture({ metadataLayoutVersion: 1, encryptionMode: 'e2ee' });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({ renderable, updateBody,
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: reader });
    expect(patch.encryptedContentAvailability).toBe('encrypted_content_unavailable');
    expect(patch.hasPendingPermissionRequests).toBe(false);
  });

  it('does not let combined encrypted metadata and AgentState bypass unsupported-layout visibility', async () => {
    const state = AgentStateSchema.parse({ requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } });
    const session = createSessionFixture({ metadataLayoutVersion: 2, encryptionMode: 'e2ee',
      ownerMetadataView: { path: '/private', host: 'localhost' }, agentState: state });
    const reader = new SessionEncryption(session.id, new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
    const updateBody = { metadataLayoutVersion: 2, metadata: { version: 2, value: await reader.encryptRaw({ path: '/private' }) },
      agentState: { version: 2, value: await reader.encryptRaw(state) } };
    const updated = await buildUpdatedSessionFromSocketUpdate({ session, updateBody,
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: reader });
    expect(updated.agentState).toBeNull();
  });

  it('hydrates a recovered owner command from the same newly authenticated encrypted tuple', async () => {
    const state = AgentStateSchema.parse({ requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } });
    const session = createSessionFixture({ metadataLayoutVersion: 1, encryptionMode: 'e2ee',
      encryptedContentAvailability: 'encrypted_content_unavailable', ownerMetadataView: { path: '/private', host: 'localhost' } });
    const reader = new SessionEncryption(session.id, new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
    const updateBody = { metadataLayoutVersion: 1, metadata: { version: 2, value: await reader.encryptRaw({ v: 1 }) },
      agentState: { version: 2, value: await reader.encryptRaw(state) } };
    const updated = await buildUpdatedSessionFromSocketUpdate({ session, updateBody,
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: reader });
    expect(updated.nextSession.encryptedContentAvailability).toBe('ready');
    expect(updated.agentState).toEqual(state);
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: createSessionListRenderableSessionFixture({ metadataLayoutVersion: 1, encryptionMode: 'e2ee',
        encryptedContentAvailability: 'encrypted_content_unavailable' }),
      updateBody, updateSeq: 2, updateCreatedAt: 2, sessionEncryption: reader,
    });
    expect(patch.encryptedContentAvailability).toBe('ready');
    expect(patch.hasPendingPermissionRequests).toBe(true);
  });

  it('does not treat a legacy owner list view as an opened layout-1 owner envelope during contraction', async () => {
    const state = AgentStateSchema.parse({ requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: createSessionListRenderableSessionFixture({ metadataLayoutVersion: 0 }),
      updateBody: { metadataLayoutVersion: 1, agentState: { version: 2, value: JSON.stringify(state) } },
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: null,
    });
    expect(patch.hasPendingPermissionRequests).toBe(false);
  });

  it('does not admit a malformed layout into a list row when the Session tuple owner rejects it', async () => {
    const renderable = createSessionListRenderableSessionFixture({
      metadataLayoutVersion: 0, metadataVersion: 1,
      metadata: { path: '/current', name: 'Current' },
    });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable,
      updateBody: {
        metadataLayoutVersion: -1,
        metadata: { version: 2, value: JSON.stringify({ path: '/invalid', name: 'Invalid' }) },
      },
      updateSeq: 2, updateCreatedAt: 2, sessionEncryption: null,
    });
    expect(patch.metadataVersion).not.toBe(2);
    expect(patch.metadata).not.toMatchObject({ name: 'Invalid' });
  });
  it('keeps an owner-projected layout-1 list row intact until its by-id refresh', async () => {
    const renderable = createSessionListRenderableSessionFixture({
      metadataLayoutVersion: 1,
      metadataVersion: 1,
      metadata: { path: '/worktree', host: 'machine', name: 'My session' },
    });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable,
      updateBody: {
        metadataLayoutVersion: 1,
        metadata: { version: 2, value: JSON.stringify({ v: 1, summary: { text: 'Shared summary', updatedAt: 2 } }) },
      },
      updateSeq: 2,
      updateCreatedAt: 2,
      sessionEncryption: null,
    });

    // The retained projection is revision 1's, so the row keeps revision 1: stamping it with 2
    // would let the warm cache and the next list refresh treat the stale owner title as current.
    expect(patch.metadataVersion).toBe(1);
    expect(patch.metadataLayoutVersion).toBe(1);
    expect(patch.metadata).toBe(renderable.metadata);
  });

  // A row without an access projection is the legacy owner shape. The rule that says its
  // composed metadata is the owner view (`buildSessionFromListRenderable`) must be the same
  // rule that decides whether a shared-only frame may replace it.
  it('keeps a legacy owner layout-1 list row intact until its by-id refresh', async () => {
    const renderable = createSessionListRenderableSessionFixture({
      access: undefined,
      accessLevel: undefined,
      metadataLayoutVersion: 1,
      metadataVersion: 1,
      metadata: { path: '/worktree', host: 'machine', name: 'My session' },
    });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable,
      updateBody: {
        metadataLayoutVersion: 1,
        metadata: { version: 2, value: JSON.stringify({ v: 1, summary: { text: 'Shared summary', updatedAt: 2 } }) },
      },
      updateSeq: 2,
      updateCreatedAt: 2,
      sessionEncryption: null,
    });

    // The retained projection is revision 1's, so the row keeps revision 1: stamping it with 2
    // would let the warm cache and the next list refresh treat the stale owner title as current.
    expect(patch.metadataVersion).toBe(1);
    expect(patch.metadataLayoutVersion).toBe(1);
    expect(patch.metadata).toBe(renderable.metadata);
  });

  it('still projects a layout-1 recipient shared-metadata update', async () => {
    const renderable = createSessionListRenderableSessionFixture({
      access: createSessionAccessFixture('view'),
      metadataLayoutVersion: 1,
      metadata: { path: '', summaryText: 'Old summary' },
    });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable,
      updateBody: {
        metadataLayoutVersion: 1,
        metadata: { version: 2, value: JSON.stringify({ v: 1, summary: { text: 'New summary', updatedAt: 2 } }) },
      },
      updateSeq: 2,
      updateCreatedAt: 2,
      sessionEncryption: null,
    });

    expect(patch.metadata?.summaryText).toBe('New summary');
  });

  // The cache-only recipient patch and the full-Session row builder read shared metadata through
  // one projection: strict shared schema, Agent presentation as the row's flavor.
  it('projects a recipient shared-metadata frame through the same projection as the row builder', async () => {
    const renderable = createSessionListRenderableSessionFixture({
      access: createSessionAccessFixture('view'),
      metadataLayoutVersion: 1,
      metadata: { path: '', summaryText: 'Old summary', flavor: 'codex' },
    });
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable,
      updateBody: {
        metadataLayoutVersion: 1,
        metadata: {
          version: 2,
          value: JSON.stringify({ v: 1, summary: { text: 'New summary', updatedAt: 2 }, agentPresentation: { agentId: 'codex' } }),
        },
      },
      updateSeq: 2,
      updateCreatedAt: 2,
      sessionEncryption: null,
    });

    expect(patch.metadata?.summaryText).toBe('New summary');
    expect(patch.metadata?.flavor).toBe('codex');
  });

  it('projects a newer Agent headline into the exact list-row socket patch', async () => {
    const renderable: SessionListRenderableSession = {
      ...createSession({ sessionId: 'same-id', encryptionMode: 'plain' }),
      agentActivityHeadline: { v: 1, backendId: 'claude', updatedAt: 1, activeEntries: [] },
    };
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable,
      updateBody: {
        metadata: {
          version: 2,
          value: JSON.stringify({
            agentRuntimeCapabilitiesV1: { backend: { session: { media: { acceptsImageInput: { supported: false } } } } },
            sessionAgentActivityHeadlineV1: {
              v: 1, backendId: 'claude', updatedAt: 2,
              activeEntries: [{ entryId: 'workflow_agent:wf_1:toolu_1', kind: 'workflow_agent', title: 'Home A', status: 'running', updatedAt: 2 }],
            },
          }),
        },
      },
      updateSeq: 2,
      updateCreatedAt: 2,
      sessionEncryption: null,
    });

    expect(patch.agentActivityHeadline).toEqual(expect.objectContaining({
      updatedAt: 2,
      activeEntries: [expect.objectContaining({ title: 'Home A' })],
    }));
    expect(patch.imageInputAvailability).toEqual({ available: false, reason: 'image_input_unsupported' });
  });

  it.each(['wrong_key', 'unsupported', 'ready'] as const)('uses authenticated metadata outcome for socket availability (%s)', async (kind) => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(8)]]));
    const writer = await Encryption.create(new Uint8Array(32).fill(7));
    await writer.initializeSessions(new Map([['s1', new Uint8Array(32).fill(kind === 'wrong_key' ? 9 : 8)]]));
    const value = await writer.getSessionEncryption('s1')!.encryptRaw(kind === 'unsupported' ? null : { path: '/work', host: 'host' });
    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: { ...createSession({ sessionId: 's1', encryptionMode: 'e2ee' }), encryptedContentAvailability: 'encrypted_access_pending' },
      updateBody: { metadata: { version: 2, value } },
      updateSeq: 2, updateCreatedAt: 2,
      sessionEncryption: encryption.getSessionEncryption('s1'),
    });
    expect(nextSession.encryptedContentAvailability).toBe(kind === 'wrong_key' ? 'encrypted_content_unavailable' : 'ready');
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: { ...createSession({ sessionId: 's1', encryptionMode: 'e2ee' }), encryptedContentAvailability: 'encrypted_access_pending' },
      updateBody: { metadata: { version: 2, value } },
      updateSeq: 2, updateCreatedAt: 2,
      sessionEncryption: encryption.getSessionEncryption('s1'),
    });
    expect(patch.encryptedContentAvailability).toBe(nextSession.encryptedContentAvailability);
  });

  it('preserves a content failure through activity updates and clears it when later metadata authenticates', async () => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(8)]]));
    const sessionEncryption = encryption.getSessionEncryption('s1')!;
    const locked: Session = {
      ...createSession({ sessionId: 's1', encryptionMode: 'e2ee' }),
      metadata: null,
      encryptedContentAvailability: 'encrypted_content_unavailable',
    };
    const activity = { updateBody: { active: true, activeAt: 3 }, updateSeq: 3, updateCreatedAt: 3, sessionEncryption };
    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({ session: locked, ...activity });
    const activityPatch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({ renderable: locked, ...activity });
    expect(nextSession.encryptedContentAvailability).toBe('encrypted_content_unavailable');
    expect({ ...locked, ...activityPatch }.encryptedContentAvailability).toBe('encrypted_content_unavailable');

    const value = await sessionEncryption.encryptRaw({ path: '/work', host: 'host' });
    const recovery = { updateBody: { metadata: { version: 2, value } }, updateSeq: 4, updateCreatedAt: 4, sessionEncryption };
    const recovered = await buildUpdatedSessionFromSocketUpdate({ session: nextSession, ...recovery });
    const recoveredPatch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({ renderable: { ...locked, ...activityPatch }, ...recovery });
    expect(recovered.nextSession.encryptedContentAvailability).toBe('ready');
    expect(recovered.nextSession.metadata).toMatchObject({ path: '/work', host: 'host' });
    expect(recoveredPatch.encryptedContentAvailability).toBe('ready');
    expect(recoveredPatch.metadata).toMatchObject({ path: '/work', host: 'host' });
  });

  afterEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
  });

  it('never installs an Account fallback reader for an unopenable new-session envelope', async () => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const otherRecipient = await Encryption.create(new Uint8Array(32).fill(8));
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(32).fill(9),
      recipientPublicKey: otherRecipient.contentDataKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });

    const nextSession = await buildNewSessionFromSocketUpdate({
      updateBody: {
        t: 'new-session', id: 'socket_unopenable_envelope',
        encryptionMode: 'e2ee', dataEncryptionKey: encodeBase64(envelope, 'base64'),
        metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'encrypted-metadata',
        agentStateVersion: 1, agentState: null,
      },
      updateSeq: 1,
      updateCreatedAt: 1,
      encryption,
    });

    expect(nextSession).toBeNull();
    expect(encryption.getSessionEncryption('socket_unopenable_envelope')).toBeNull();
  });

  it('drops a new-session socket bootstrap when Account encryption changes during initialization', async () => {
    let generation = 4;
    const decryptMetadata = vi.fn(async () => ({ path: '/stale', host: 'stale' }));
    const nextSession = await buildNewSessionFromSocketUpdate({
      updateBody: {
        t: 'new-session', id: 'socket_generation_changed',
        encryptionMode: 'e2ee', dataEncryptionKey: 'present-envelope',
        metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'encrypted-metadata',
        agentStateVersion: 1, agentState: null,
      },
      updateSeq: 1,
      updateCreatedAt: 1,
      sourceServerId: 'server-a',
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array(32).fill(7),
        initializeSessions: async (_sessionKeys, options) => {
          generation += 1;
          if (options?.shouldContinue?.() === false) return null;
          return { accountId: 'account-a', serverId: 'server-a', generation };
        },
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload: decryptMetadata,
          decryptAgentState: async () => ({}),
        }),
        getCurrentEncryptionGenerationScope: () => ({
          accountId: 'account-a', serverId: 'server-a', generation,
        }),
        isCurrentEncryptionGenerationScope: scope => scope.generation === generation,
      },
    });

    expect(nextSession).toBeNull();
    expect(decryptMetadata).not.toHaveBeenCalled();
  });

  it('rejects an explicitly malformed new-session encryption mode instead of inferring E2EE from its envelope', async () => {
    const initializeSessions = vi.fn(async (
        _sessions: Map<string, Uint8Array | null>,
        _scopeInput?: EncryptionScopeInput,
    ) => null);
    const decryptMetadata = vi.fn(async () => ({ path: '/must-not-open', host: 'must-not-open' }));
    const nextSession = await buildNewSessionFromSocketUpdate({
      updateBody: {
        t: 'new-session',
        id: 'socket_invalid_encryption_mode',
        encryptionMode: 'encrypted-somehow',
        dataEncryptionKey: 'present-envelope',
        metadataVersion: 1,
        metadata: 'encrypted-metadata',
        agentStateVersion: 1,
        agentState: null,
      },
      updateSeq: 1,
      updateCreatedAt: 1,
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array(32).fill(7),
        initializeSessions,
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload: decryptMetadata,
          decryptAgentState: async () => ({}),
        }),
      },
    });

    expect(nextSession).toBeNull();
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(decryptMetadata).not.toHaveBeenCalled();
  });

  it('parses plaintext metadata and agentState when session encryptionMode is plain', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const updateBody = {
      metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
      agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody,
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: {
        decryptMetadataPayload: async () => {
          throw new Error('decryptMetadataPayload should not be called for plaintext sessions');
        },
        decryptAgentState: async () => {
          throw new Error('decryptAgentState should not be called for plaintext sessions');
        },
        decryptMetadata: async () => {
          throw new Error('decryptMetadata should not be called for plaintext sessions');
        },
      },
    });

    expect(nextSession.encryptionMode).toBe('plain');
    expect(nextSession.metadataVersion).toBe(2);
    expect(nextSession.metadata).toEqual({ path: '/work', host: 'devbox' });
    expect(nextSession.agentStateVersion).toBe(3);
    const agentState = nextSession.agentState as unknown as { controlledByUser?: unknown };
    expect(agentState.controlledByUser).toBe(true);
  });

  it('applies a layout-v1 privacy contraction over higher legacy socket state versions', async () => {
    const base = {
      ...createSession({ sessionId: 's_privacy_socket', encryptionMode: 'plain' }),
      metadataVersion: 9,
      metadata: {
        path: '/private/worktree',
        host: 'private-host',
        machineId: 'private-machine',
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'private-machine',
          remoteSessionId: 'private-native-id',
          source: { kind: 'codexHome', home: 'local' },
        },
      },
      agentStateVersion: 8,
      agentState: {
        requests: {
          privateRequest: {
            tool: 'private-tool',
            arguments: 'private-tool-arguments',
          },
        },
      },
    } satisfies Session;
    const updateBody = {
      metadataLayoutVersion: 1,
      metadata: {
        version: 1,
        value: JSON.stringify({
          v: 1,
          summary: { text: 'Safe title', updatedAt: 10 },
        }),
      },
      agentState: { version: 1, value: null },
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody,
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });
    const renderablePatch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: base.id,
        seq: base.seq,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        active: base.active,
        activeAt: base.activeAt,
        metadataVersion: 9,
        agentStateVersion: 8,
        metadata: {
          path: '/private/worktree',
          host: 'private-host',
          machineId: 'private-machine',
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'private-machine',
            remoteSessionId: 'private-native-id',
            source: { kind: 'codexHome', home: 'local' },
          },
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        hasPendingPermissionRequests: true,
        hasPendingUserActionRequests: true,
      },
      updateBody,
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession).toMatchObject({
      metadataLayoutVersion: 1,
      metadataVersion: 1,
      agentStateVersion: 1,
      metadata: {
        v: 1,
        summary: { text: 'Safe title', updatedAt: 10 },
      },
      agentState: null,
    });
    expect(renderablePatch).toMatchObject({
      metadataLayoutVersion: 1,
      metadataVersion: 1,
      agentStateVersion: 1,
      hasPendingPermissionRequests: false,
      hasPendingUserActionRequests: false,
    });
    expect(JSON.stringify(nextSession)).not.toMatch(/private-native-id|private-tool-arguments|private-worktree/);
    expect(JSON.stringify(renderablePatch)).not.toMatch(/private-native-id|private-worktree/);
  });

  // A Session created by an external-session import arrives over the socket as `machine_only`.
  // Dropping the field let the transcript authority fall back to "legacy linked session".
  it('keeps the storage state a new-session socket payload carries', async () => {
    const build = (currentStorageState?: string) => buildNewSessionFromSocketUpdate({
      updateBody: {
        t: 'new-session',
        id: 's_imported',
        metadataLayoutVersion: 0,
        metadataVersion: 1,
        metadata: JSON.stringify({ path: '/tmp/project', host: 'mac' }),
        agentStateVersion: 1,
        agentState: null,
        encryptionMode: 'plain',
        ...(currentStorageState === undefined ? {} : { currentStorageState }),
      } as never,
      updateSeq: 1,
      updateCreatedAt: 1,
      encryption: null,
    });

    expect((await build('machine_only'))?.currentStorageState).toBe('machine_only');
    // An unknown value is not guessed into a state.
    expect((await build('bogus'))?.currentStorageState).toBeUndefined();
  });

  it('treats a layout-v1 new-session socket payload as a recipient projection with an Agent tombstone', async () => {
    const nextSession = await buildNewSessionFromSocketUpdate({
      updateBody: {
        t: 'new-session',
        id: 's_layout1_recipient',
        metadataLayoutVersion: 1,
        metadataVersion: 2,
        metadata: JSON.stringify({
          v: 1,
          summary: { text: 'Safe title', updatedAt: 10 },
        }),
        agentStateVersion: 3,
        agentState: JSON.stringify({
          requests: {
            privateRequest: {
              arguments: 'private-tool-arguments',
            },
          },
        }),
        encryptionMode: 'plain',
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      encryption: null,
    });

    expect(nextSession).toMatchObject({
      metadataLayoutVersion: 1,
      metadataVersion: 2,
      agentStateVersion: 3,
      metadata: {
        v: 1,
        summary: { text: 'Safe title', updatedAt: 10 },
      },
      agentState: null,
    });
    expect(JSON.stringify(nextSession)).not.toContain('private-tool-arguments');
  });

  it('strict-parses layout-v1 E2EE socket metadata from the raw decrypted envelope', async () => {
    const base = {
      ...createSession({ sessionId: 's_privacy_socket_e2ee', encryptionMode: 'e2ee' }),
      metadataLayoutVersion: 0,
      metadataVersion: 9,
      metadata: {
        path: '/private/worktree',
        host: 'private-host',
        externalSessionV1: { remoteSessionId: 'private-native-id' },
      },
      agentStateVersion: 8,
      agentState: {
        requests: {
          privateRequest: {
            tool: 'private-tool',
            arguments: { secret: 'private-tool-arguments' },
          },
        },
      },
    } satisfies Session;
    const sharedMetadata = {
      v: 1 as const,
      summary: { text: 'Safe title', updatedAt: 10 },
    };
    const decryptMetadataPayload = vi.fn(async () => sharedMetadata);
    const decryptMetadata = vi.fn(async () => ({
      ...sharedMetadata,
      path: '',
      host: '',
      externalSessionV1: { remoteSessionId: 'private-native-id' },
    }));
    const decryptAgentState = vi.fn(async () => ({}));

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        metadataLayoutVersion: 1,
        metadata: { version: 1, value: 'encrypted-shared-envelope' },
        agentState: { version: 1, value: null },
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: {
        decryptMetadataPayload,
        decryptMetadata,
        decryptAgentState,
      } as any,
    });

    expect(decryptMetadataPayload.mock.calls[0]?.slice(0, 2)).toEqual([1, 'encrypted-shared-envelope']);
    expect(decryptMetadata).not.toHaveBeenCalled();
    expect(nextSession.metadata).toEqual(sharedMetadata);
    expect(JSON.stringify(nextSession)).not.toMatch(/private-native-id|private-tool|private-worktree/);
  });

  it('applies archivedAt changes from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: { archivedAt: 1_700_000_000_000 },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.archivedAt).toBe(1_700_000_000_000);
  });

  it('stops an open Session and its list row when the Home retires its Machine', async () => {
    const session = { ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      active: true, thinking: true, latestTurnStatus: 'in_progress' as const };
    const closure = { updateBody: { active: false, activeAt: 1_100, latestTurnStatus: 'cancelled',
      lifecycleStateReason: 'machine_deleted' }, updateSeq: 10, updateCreatedAt: 1_100, sessionEncryption: null };
    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({ session, ...closure });
    expect(nextSession).toMatchObject({ active: false, thinking: false, latestTurnStatus: 'cancelled',
      lifecycleStateReason: 'machine_deleted' });
    const listPatch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: { ...session, presence: 'online', metadata: null }, ...closure,
    });
    expect(listPatch).toMatchObject({ active: false, thinking: false, latestTurnStatus: 'cancelled',
      lifecycleStateReason: 'machine_deleted' });

    const resumed = await buildUpdatedSessionFromSocketUpdate({
      session: nextSession, updateBody: { active: true, activeAt: 1_200 },
      updateSeq: 11, updateCreatedAt: 1_200, sessionEncryption: null,
    });
    expect(resumed.nextSession.lifecycleStateReason).toBeUndefined();
  });

  it('applies primary runtime issue projection from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });
    const issue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'agent_status_error',
      source: 'agent_status_error',
      occurredAt: 100,
      sanitizedPreview: 'Provider reported an error',
    } as const;

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnStatus: 'failed',
        lastRuntimeIssue: issue,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnStatus).toBe('failed');
    expect(nextSession.lastRuntimeIssue).toEqual(issue);
  });

  it('clears stale thinking for terminal primary turn projections', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      thinking: true,
      thinkingAt: 999,
      latestTurnStatus: 'in_progress' as const,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnStatus: 'completed',
        lastRuntimeIssue: null,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnStatus).toBe('completed');
    expect(nextSession.thinking).toBe(false);
  });

  it('applies runtime activity projection fields from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityRevision: 2_000,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.runtimeActivityActiveCount).toBe(1);
    expect(nextSession.runtimeActivityObservedAt).toBe(1_000);
    expect(nextSession.runtimeActivityRevision).toBe(2_000);
  });

  it('applies inactive projection changes without leaving stale thinking active', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      active: true,
      activeAt: 100,
      thinking: true,
      thinkingAt: 100,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        active: false,
        activeAt: 123_456,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.active).toBe(false);
    expect(nextSession.activeAt).toBe(123_456);
    expect(nextSession.thinking).toBe(false);
    expect(nextSession.thinkingAt).toBe(123_456);
  });

  it('clears stale renderable thinking for terminal primary turn projections', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: true,
        thinkingAt: 999,
        presence: 'online',
        latestTurnStatus: 'in_progress',
      },
      updateBody: {
        latestTurnStatus: 'completed',
        lastRuntimeIssue: null,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.latestTurnStatus).toBe('completed');
    expect(patch.thinking).toBe(false);
  });

  it('does not infer runtime presence from durable active fields in renderable socket patches', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 100,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: true,
        thinkingAt: 100,
        presence: 'online',
      },
      updateBody: {
        active: false,
        activeAt: 123_456,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.active).toBe(false);
    expect(patch.activeAt).toBe(123_456);
    expect(patch.thinking).toBe(false);
    expect(patch.thinkingAt).toBe(123_456);
    expect(patch.presence).toBeUndefined();
  });

  it('applies pending request observation timestamps to renderable socket patches', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        pendingRequestObservedAt: null,
      },
      updateBody: {
        pendingRequestObservedAt: 1_700,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.pendingRequestObservedAt).toBe(1_700);
  });

  it('applies flattened rollback eligibility from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        rollbackEligibleTurnStarts: [1, 3],
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.rollbackEligibleTurnStarts).toEqual([1, 3]);
  });

  it('applies flattened rollback eligibility to renderable socket patches', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
      },
      updateBody: {
        rollbackEligibleTurnStarts: [1, 3],
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.rollbackEligibleTurnStarts).toEqual([1, 3]);
  });

  it('marks renderable unread when ready projection advances past the read cursor', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 945,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        lastViewedSessionSeq: 945,
        latestReadyEventSeq: null,
        hasUnreadMessages: false,
      },
      updateBody: {
        latestReadyEventSeq: 946,
      },
      updateSeq: 946,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.latestReadyEventSeq).toBe(946);
    expect(patch.hasUnreadMessages).toBe(true);
  });

  it('clears renderable unread when read cursor reaches the latest ready projection', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 946,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        lastViewedSessionSeq: 945,
        latestReadyEventSeq: 946,
        hasUnreadMessages: true,
      },
      updateBody: {
        lastViewedSessionSeq: 946,
      },
      updateSeq: 947,
      updateCreatedAt: 1235,
      sessionEncryption: null,
    });

    expect(patch.lastViewedSessionSeq).toBe(946);
    expect(patch.hasUnreadMessages).toBe(false);
  });

  it('clears renderable unread when read cursor reaches the latest displayable message but update-session seq trails with usage activity', async () => {
    const previousState = storage.getState();
    try {
      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          s1: {
            messageIdsOldestFirst: ['m-visible'],
            messagesById: {
              'm-visible': {
                id: 'm-visible',
                kind: 'agent-text',
                seq: 945,
                localId: null,
                createdAt: 1,
                text: 'Visible assistant message',
              },
            },
          },
        },
      } as never));

      const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
        renderable: {
          id: 's1',
          seq: 946,
          createdAt: 0,
          updatedAt: 0,
          active: true,
          activeAt: 0,
          metadataVersion: 1,
          agentStateVersion: 1,
          metadata: null,
          thinking: false,
          thinkingAt: 0,
          presence: 'online',
          latestTurnStatus: 'in_progress',
          hasUnreadMessages: true,
        },
        updateBody: {
          lastViewedSessionSeq: 945,
        },
        updateSeq: 946,
        updateCreatedAt: 1234,
        sessionEncryption: null,
      });

      expect(patch.hasUnreadMessages).toBe(false);
    } finally {
      storage.setState(previousState);
    }
  });

  it('decrypts encrypted metadata and agent-state socket updates in one batch when available', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'e2ee' });
    syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 1_000_000, flushIntervalMs: 60_000 });
    syncPerformanceTelemetry.reset();
    const reader = new SessionEncryption(base.id,
      new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
    const metadata = await reader.encryptMetadata({ path: '/work', host: 'devbox' });
    const agentState = await reader.encryptAgentState({ controlledByUser: true });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        metadata: { version: 2, value: metadata },
        agentState: { version: 3, value: agentState },
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: reader,
    });

    expect(nextSession.metadataVersion).toBe(2);
    expect(nextSession.agentStateVersion).toBe(3);
    expect(nextSession.metadata).toEqual({ path: '/work', host: 'devbox' });
    expect(nextSession.agentState).toEqual({ controlledByUser: true });
    expect(syncPerformanceTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
      name: 'sync.sessions.socket.updateSession.decryptState',
      count: 1,
      fields: expect.objectContaining({
        encrypted: 1,
        metadata: 1,
        agentState: 1,
        batched: 1,
      }),
    }));
  });
});
