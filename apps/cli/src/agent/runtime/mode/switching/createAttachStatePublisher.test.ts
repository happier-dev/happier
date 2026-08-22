import { describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createAgentAttachStatePublisher } from './createAttachStatePublisher';

describe('createAgentAttachStatePublisher', () => {
  it('keeps an ordinary OpenCode layout 0 attach-state mutation on the legacy socket owner', async () => {
    const credentials: StoredCredentials = {
      token: 'token-1',
      encryption: null,
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_ordinary',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '/workspace',
        host: 'owner-host',
        agent: 'opencode',
        opencode: {
          baseUrl: 'http://127.0.0.1:4096',
          sessionId: 'remote-session-1',
        },
      }),
      metadataVersion: 3,
      agentState: JSON.stringify({ existing: 'value' }),
      agentStateVersion: 4,
    });
    const socket = createApiSessionSocketStub();
    type CreateSessionScopedSocket = NonNullable<
      Parameters<
        typeof createAgentAttachStatePublisher
      >[0]['createSessionScopedSocketFn']
    >;
    // Socket.IO's concrete class has runtime-only members outside this boundary.
    const createSessionScopedSocketSpy = vi.fn(
      () => socket as unknown as ReturnType<CreateSessionScopedSocket>,
    );
    const createSessionScopedSocketFn: CreateSessionScopedSocket =
      createSessionScopedSocketSpy;
    const waitForSocketConnectFn = vi.fn(async () => undefined);
    const legacyWrites: unknown[] = [];
    const updateSessionAgentStateWithAckFn = vi.fn(async (params: any) => {
      expect(params).toMatchObject({ sessionEncryptionMode: 'plain' });
      expect(params).not.toHaveProperty('encryptionKey');
      expect(params).not.toHaveProperty('encryptionVariant');
      const next = params.handler(params.getAgentState() ?? {});
      legacyWrites.push(next);
      const version = params.getAgentStateVersion() + 1;
      const ciphertext = JSON.stringify(next);
      params.setAgentState(next);
      params.setAgentStateVersion(version);
      return {
        agentState: next,
        version,
        ciphertext,
      };
    });
    const updateSessionMetadataEnvelopeTupleWithRetryFn = vi.fn(
      async (params: any) => {
        expect(params).toMatchObject({ mode: 'plain' });
        expect(params.ctx).toBeNull();
        expect(params.initialSnapshot).toMatchObject({
          mode: 'legacy_owner',
          metadataLayoutVersion: 0,
        });
        const updatedAgentState = await params.mutation.update(
          params.initialSnapshot.value.agentState ?? {},
        );
        return await params.mutateLegacy({
          kind: 'agentState',
          current: params.initialSnapshot,
          updatedAgentState,
          mutation: params.mutation,
        });
      },
    );

    const publisher = createAgentAttachStatePublisher({
      agentId: 'opencode',
      sessionId: 'sid_opencode_ordinary',
      credentials,
      getAccountEncryptionCurrentness: async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      }),
      rawSession,
      createSessionScopedSocketFn,
      waitForSocketConnectFn,
      updateSessionAgentStateWithAckFn,
      updateSessionMetadataEnvelopeTupleWithRetryFn,
    });

    await publisher?.publishAttached(true);
    await publisher?.publishAttached(false);

    expect(legacyWrites).toEqual([
      expect.objectContaining({
        existing: 'value',
        localControl: expect.objectContaining({ attached: true }),
      }),
      expect.objectContaining({
        existing: 'value',
        localControl: expect.objectContaining({ attached: false }),
      }),
    ]);
    expect(updateSessionAgentStateWithAckFn).toHaveBeenCalledTimes(2);
    expect(createSessionScopedSocketSpy).toHaveBeenCalledTimes(2);
    expect(waitForSocketConnectFn).toHaveBeenCalledTimes(2);
    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it('keeps a linked layout-0 attach-state mutation on the legacy socket owner while activation is frozen', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_1',
      encryptionMode: 'plain',
      agentState: JSON.stringify({ existing: 'value' }),
      agentStateVersion: 4,
      metadata: JSON.stringify({
        externalSessionV1: {
          v: 1,
          agentId: 'opencode',
          machineId: 'machine-1',
          remoteSessionId: 'remote-session-1',
          source: {
            kind: 'opencodeServer',
            endpoint: 'http://127.0.0.1:4096',
          },
        },
      }),
    });
    const socket = createApiSessionSocketStub();
    type CreateSessionScopedSocket = NonNullable<
      Parameters<
        typeof createAgentAttachStatePublisher
      >[0]['createSessionScopedSocketFn']
    >;
    // Socket.IO's concrete class has runtime-only members outside this boundary.
    const createSessionScopedSocketFn: CreateSessionScopedSocket = vi.fn(
      () => socket as unknown as ReturnType<CreateSessionScopedSocket>,
    );
    const waitForSocketConnectFn = vi.fn(async () => undefined);
    const publishedStates: unknown[] = [];
    const updateSessionAgentStateWithAckFn = vi.fn(async (params: any) => {
      const next = params.handler(params.getAgentState() ?? {});
      publishedStates.push(next);
      const version = params.getAgentStateVersion() + 1;
      const ciphertext = JSON.stringify(next);
      params.setAgentState(next);
      params.setAgentStateVersion(version);
      return {
        agentState: next,
        version,
        ciphertext,
      };
    });
    const updateSessionMetadataEnvelopeTupleWithRetryFn = vi.fn(async (
      params: any,
    ) => {
      expect(params.initialSnapshot).toMatchObject({
        mode: 'legacy_owner',
        metadataLayoutVersion: 0,
      });
      const updatedAgentState = await params.mutation.update(
        params.initialSnapshot.value.agentState ?? {},
      );
      return await params.mutateLegacy({
        kind: 'agentState',
        current: params.initialSnapshot,
        updatedAgentState,
        mutation: params.mutation,
      });
    });

    const publisher = createAgentAttachStatePublisher({
      agentId: 'opencode',
      sessionId: 'sid_opencode_1',
      credentials,
      getAccountEncryptionCurrentness: async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      }),
      rawSession,
      createSessionScopedSocketFn,
      waitForSocketConnectFn,
      updateSessionAgentStateWithAckFn,
      updateSessionMetadataEnvelopeTupleWithRetryFn,
    });

    expect(publisher).not.toBeNull();
    await publisher?.publishAttached(true);
    await publisher?.publishAttached(false);

    expect(updateSessionMetadataEnvelopeTupleWithRetryFn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sid_opencode_1',
      initialSnapshot: expect.objectContaining({
        mode: 'legacy_owner',
        metadataLayoutVersion: 0,
        metadataCiphertext: rawSession.metadata,
        agentStateCiphertext: rawSession.agentState,
      }),
      mutation: expect.objectContaining({ kind: 'agentState' }),
    }));

    expect(publishedStates[0]).toEqual({
      existing: 'value',
      controlledByUser: false,
      localControl: {
        attached: true,
        topology: 'shared',
        remoteWritable: true,
        canAttach: true,
        canDetach: true,
      },
    });

    expect(publishedStates[1]).toEqual({
      existing: 'value',
      controlledByUser: false,
      localControl: {
        attached: false,
        topology: 'shared',
        remoteWritable: true,
        canAttach: true,
        canDetach: false,
      },
    });
  });

  it('returns null for agents without agent-native attach', () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_claude_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude' }),
    });

    const publisher = createAgentAttachStatePublisher({
      agentId: 'claude',
      sessionId: 'sid_claude_1',
      credentials,
      getAccountEncryptionCurrentness: async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      }),
      rawSession,
    });

    expect(publisher).toBeNull();
  });

  it('publishes layout-1 attach state through the canonical owner tuple adapter', async () => {
    const ownerSecret = new Uint8Array(32).fill(3);
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: ownerSecret },
    };
    const metadata = {
      path: '/private/worktree',
      host: 'private-host',
      flavor: 'opencode',
    };
    const agentState = { existing: 'value' };
    const tuple = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata,
      agentState,
      storedContentMode: 'e2ee',
      encryptionKey: ownerSecret,
      encryptionVariant: 'legacy',
    });
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_layout_1',
      encryptionMode: 'e2ee',
      metadataLayoutVersion: 1,
      metadata: tuple.sharedMetadata.ciphertext,
      metadataVersion: 4,
      ownerMetadata: tuple.ownerMetadata,
      agentState: tuple.agentState,
      agentStateVersion: 7,
    });
    const updateSessionMetadataEnvelopeTupleWithRetryFn = vi.fn(
      async (params: any) => {
        const next = params.mutation.update(
          params.initialSnapshot.value.agentState ?? {},
        );
        return {
          ...params.initialSnapshot,
          agentStateVersion: params.initialSnapshot.agentStateVersion + 1,
          value: {
            ...params.initialSnapshot.value,
            agentState: next,
          },
        };
      },
    );

    const publisher = createAgentAttachStatePublisher({
      agentId: 'opencode',
      sessionId: 'sid_opencode_layout_1',
      credentials,
      getAccountEncryptionCurrentness: async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      }),
      rawSession,
      updateSessionMetadataEnvelopeTupleWithRetryFn,
    });

    await publisher?.publishAttached(true);

    expect(updateSessionMetadataEnvelopeTupleWithRetryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token-1',
        sessionId: 'sid_opencode_layout_1',
        mutation: expect.objectContaining({ kind: 'agentState' }),
      }),
    );
  });
});
