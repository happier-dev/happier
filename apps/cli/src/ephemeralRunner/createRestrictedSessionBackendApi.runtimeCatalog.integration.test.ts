import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';

import { encodeBase64, encrypt } from '@/api/encryption';
import { createMockSession } from '@/testkit/backends/sessionFixtures';

const { fetchSessionByIdCompatMock, patchSessionMetadataEnvelopeTupleMock } = vi.hoisted(() => ({
  fetchSessionByIdCompatMock: vi.fn(),
  patchSessionMetadataEnvelopeTupleMock: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionByIdCompat: fetchSessionByIdCompatMock,
  patchSessionMetadataEnvelopeTuple: patchSessionMetadataEnvelopeTupleMock,
}));

import {
  createRestrictedSessionBackendApiContextInitializer,
  createRestrictedSessionClientTransport,
  EphemeralRunnerMaterializedSessionRequiredError,
} from './createRestrictedSessionBackendApi';

const principal = Object.freeze({
  kind: 'ephemeral_session_runner',
  authority: 'session_runtime',
  accountId: 'account_1',
  activationId: 'activation_1',
  sessionId: 'session_1',
  machineId: 'machine_1',
  installationId: 'installation_1',
  installationPublicKey: 'installation_public_key',
  creatorTokenEpoch: 1,
}) as VerifiedEphemeralSessionRunnerPrincipal;

const SESSION_KEY = new Uint8Array(32).fill(7);

function createRunnerSession() {
  return createMockSession({
    id: principal.sessionId,
    encryptionKey: SESSION_KEY,
    metadataLayoutVersion: 1,
  });
}

function createRunnerSessionRow(session: ReturnType<typeof createRunnerSession>) {
  return {
    ...session,
    metadata: encodeBase64(encrypt(SESSION_KEY, 'legacy', {
      v: 1,
      summary: { text: 'Runner Session', updatedAt: 1 },
    })),
    ownerMetadata: null,
    agentState: null,
    dataEncryptionKey: null,
  };
}

describe('restricted ephemeral Runner Session API', () => {
  beforeEach(() => {
    fetchSessionByIdCompatMock.mockReset();
    patchSessionMetadataEnvelopeTupleMock.mockReset();
  });

  it('opens only the exact preestablished Session/Machine socket and no Account socket', async () => {
    const createSessionSocketTransportFn = vi.fn(() => ({
      socket: {} as never,
      transport: {} as never,
    }));
    const transport = createRestrictedSessionClientTransport({
      principal,
      serverId: 'runner-home-id',
      runtimeOrigin: 'https://home.example',
      runtimeToken: 'runtime-token',
      transportEnvironment: { HOME: '/runner-home', TMPDIR: '/runner-home/tmp' },
    }, { createSessionSocketTransportFn });

    transport.createSessionSocketTransport({
      sessionId: 'session_1',
      machineId: 'machine_1',
    });

    expect(createSessionSocketTransportFn).toHaveBeenCalledExactlyOnceWith({
      token: 'runtime-token',
      serverUrl: 'https://home.example',
      sessionId: 'session_1',
      machineId: 'machine_1',
      accessKeyBinding: 'preestablished',
      env: { HOME: '/runner-home', TMPDIR: '/runner-home/tmp' },
    });
    expect({ serverId: transport.serverId, serverUrl: transport.serverUrl }).toEqual({
      serverId: 'runner-home-id',
      serverUrl: 'https://home.example',
    });
    expect(transport.createAccountUpdatesSocket).toBeUndefined();
    await expect(transport.resolveToken?.()).resolves.toBe('runtime-token');
    expect(() => transport.createSessionSocketTransport({
      sessionId: 'session_other',
      machineId: 'machine_1',
    })).toThrow('ephemeral_runner_session_transport_scope_mismatch');
    expect(() => transport.createSessionSocketTransport({
      sessionId: 'session_1',
      machineId: 'machine_other',
    })).toThrow('ephemeral_runner_session_transport_scope_mismatch');
  });

  it('refuses Session creation before it can escape the materialized binding', async () => {
    const initialize = createRestrictedSessionBackendApiContextInitializer({
      principal,
      serverId: 'runner-home-id',
      runtimeOrigin: 'https://home.example',
      runtimeToken: 'runtime-token',
      transportEnvironment: { HOME: '/runner-home' },
      actionsSettingsProvider: {
        getActionsSettings: () => ({ v: 1, actions: {} }),
      },
    });
    const context = await initialize({
      credentials: { token: 'ignored' } as never,
      machineMetadata: {} as never,
    });

    expect(context.machineId).toBe('machine_1');
    expect(context.api.push()).toBeNull();
    await expect(context.api.getOrCreateSession({} as never)).rejects.toBeInstanceOf(
      EphemeralRunnerMaterializedSessionRequiredError,
    );
  });

  it('binds Action confirmation to the verified runtime Account and fails aborted custody closed', async () => {
    const session = createRunnerSession();
    fetchSessionByIdCompatMock.mockResolvedValue(createRunnerSessionRow(session));
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 1 },
    });
    const initialize = createRestrictedSessionBackendApiContextInitializer({
      principal,
      serverId: 'runner-home-id',
      runtimeOrigin: 'https://home.example',
      runtimeToken: 'runtime-token',
      transportEnvironment: { HOME: '/runner-home' },
      actionsSettingsProvider: {
        getActionsSettings: () => ({ v: 1, actions: {} }),
      },
    });
    const context = await initialize({
      credentials: { token: 'ignored' } as never,
      machineMetadata: {} as never,
    });
    const client = await context.api.sessionSyncClient(session);
    const lifetime = new AbortController();
    lifetime.abort();

    await expect(client.confirmSessionAction({
      actionId: 'session.activity.get',
      input: { sessionId: principal.sessionId },
      preview: { sessionId: principal.sessionId },
      context: {
        surface: 'agent',
        authority: 'account_automation',
        defaultSessionId: principal.sessionId,
        sessionInputSource: {
          sourceSessionId: principal.sessionId,
          sourceTurnId: 'turn-1',
          via: 'action',
        },
      },
      sessionId: principal.sessionId,
    }, {
      turnId: 'turn-1',
      lifetimeSignal: lifetime.signal,
      isCurrent: () => true,
    })).resolves.toMatchObject({ decision: 'canceled' });

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledWith({
      token: 'runtime-token',
      sessionId: principal.sessionId,
      reason: 'waitForMetadataUpdate',
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    await client.close();
  });
});
