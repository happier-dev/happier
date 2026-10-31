import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session wait (integration)', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
  let sessionId = 'sess_integration_wait_123';
  let initialAgentStateCiphertext = '';
  let idleAgentStateCiphertext = '';
  let sessionMetadataCiphertext = '';
  let sessionDataEncryptionKeyBase64 = '';
  let transcriptMessages: Array<Record<string, unknown>> = [];
  let transcriptFetchCount = 0;
  let pendingCount = 0;
  let latestTurnStatus: 'in_progress' | 'completed' | null | undefined;
  let socketOnConnect: ((socket: ReturnType<typeof createApiSessionSocketStub>) => void) | null = null;

  const waitForTranscriptFetch = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (transcriptFetchCount > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(transcriptFetchCount).toBeGreaterThan(0);
  };

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    happyHomeDir = await createTempDir('happier-cli-session-wait-');

    sessionId = 'sess_integration_wait_123';
    transcriptMessages = [];
    transcriptFetchCount = 0;
    pendingCount = 0;
    latestTurnStatus = undefined;
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    sessionMetadataCiphertext = encodeBase64Session(
      encryptWithDataKey({ path: '/tmp', tag: 'MyTag' }, dek),
      'base64',
    );
    const busyAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: { r1: { createdAt: 1 } } }, dek),
      'base64',
    );
    idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: {} }, dek),
      'base64',
    );
    initialAgentStateCiphertext = busyAgentStateCiphertext;
    sessionDataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: false,
              activeAt: 0,
              metadata: sessionMetadataCiphertext,
              metadataVersion: 0,
              agentState: initialAgentStateCiphertext,
              agentStateVersion: 0,
              pendingCount,
              ...(latestTurnStatus !== undefined ? {
                latestTurnStatus,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
              } : {}),
              pendingVersion: 0,
              dataEncryptionKey: sessionDataEncryptionKeyBase64,
              share: null,
            },
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        transcriptFetchCount += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: transcriptMessages }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const socket = createApiSessionSocketStub({
      onConnect(currentSocket) {
        socketOnConnect?.(currentSocket);
      },
    });
    const trigger = socket.trigger;
    socket.trigger = (event, payload) => {
      const parsed = UpdateContainerSchema.safeParse(payload);
      if (event === 'update' && parsed.success && parsed.data.body.t === 'new-message') {
        // The server persists each message before emitting its socket update.
        const message = parsed.data.body.message;
        if (!transcriptMessages.some((row) => row.id === message.id)) transcriptMessages.push({ ...message });
      }
      trigger(event, payload);
    };
    bindApiSessionSocketMock(mockIo, socket);

    socketOnConnect = (currentSocket) => {
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u1',
          seq: 2,
          createdAt: Date.now(),
          body: {
            t: 'update-session',
            id: sessionId,
            agentState: { value: idleAgentStateCiphertext, version: 1 },
          },
        });
      }, 10);
    };
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) await removeTempDir(happyHomeDir);
    envScope.restore();

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('waits for idle and returns a session_wait JSON envelope', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['wait', 'sess_integration_wait_123', '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe('sess_integration_wait_123');
      expect(parsed.data?.idle).toBe(true);
      expect(typeof parsed.data?.observedAt).toBe('number');
    } finally {
      output.restore();
    }
  });

  it.each([
    { name: 'after a completed turn', status: 'completed' as const },
    { name: 'before the first turn', status: null },
  ])('waits for queued input $name until its turn completes', async ({ status }) => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    pendingCount = 1;
    latestTurnStatus = status;
    let notifySocketConnected: () => void = () => undefined;
    const socketConnected = new Promise<void>((resolve) => { notifySocketConnected = resolve; });
    socketOnConnect = (socket) => {
      notifySocketConnected();
      const publish = (status: 'in_progress' | 'completed', seq: number) => {
        latestTurnStatus = status;
        pendingCount = 0;
        socket.trigger('update', {
          id: `u-queued-${seq}`, seq, createdAt: Date.now(),
          body: {
            t: 'update-session', id: sessionId, latestTurnStatus: status,
            pendingCount, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
          },
        });
      };
      setTimeout(() => socket.trigger('update', {
          id: 'u-previous-turn-ready', seq: 2, createdAt: Date.now(),
          body: {
            t: 'new-message', sid: sessionId,
            message: {
              id: 'previous-ready', seq: 2, localId: null, createdAt: Date.now(), updatedAt: Date.now(),
              content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } },
            },
          },
      }), status === 'completed' ? 325 : 100);
      setTimeout(() => publish('in_progress', 3), 450);
      setTimeout(() => publish('completed', 4), 600);
    };
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);
    try {
      const result = handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed), machineKey: machineKeySeed,
          },
        }),
      });
      let settled = false;
      void result.then(() => { settled = true; });
      await socketConnected;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      await result;
      expect(output.json()).toMatchObject({ ok: true, data: { idle: true } });
    } finally {
      output.restore();
    }
  });

  it('does not resolve from an initially idle snapshot before a fresh busy update settles back to idle', async () => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    socketOnConnect = (currentSocket) => {
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_busy',
          seq: 2,
          createdAt: Date.now(),
          body: {
            t: 'update-session',
            id: sessionId,
            agentState: { value: initialAgentStateCiphertext, version: 1 },
          },
        });
      }, 10);
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_idle',
          seq: 3,
          createdAt: Date.now(),
          body: {
            t: 'update-session',
            id: sessionId,
            agentState: { value: idleAgentStateCiphertext, version: 2 },
          },
        });
      }, 60);
    };

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);

    try {
      const waitPromise = handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      let settled = false;
      void waitPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      await waitPromise;

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.idle).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('does not resolve from an initially idle active session while transcript activity still shows an in-flight task', async () => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    transcriptMessages = [
      {
        id: 'm2',
        seq: 2,
        createdAt: 2,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'claude',
              data: { type: 'task_started', id: 'task_wait_1' },
            },
          },
        },
      },
      {
        id: 'm1',
        seq: 1,
        createdAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'hello' },
          },
        },
      },
    ];

    socketOnConnect = (currentSocket) => {
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_task_complete',
          seq: 3,
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: sessionId,
            message: {
              id: 'm3',
              seq: 3,
              localId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    provider: 'claude',
                    data: { type: 'task_complete', id: 'task_wait_1' },
                  },
                },
              },
            },
          },
        });
      }, 450);
    };

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);

    try {
      const waitPromise = handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      let settled = false;
      void waitPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await waitPromise;

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.idle).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('treats a session ready event as completion for a pending user turn without ACP lifecycle events', async () => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    transcriptMessages = [
      {
        id: 'm1',
        seq: 1,
        createdAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'hello' },
          },
        },
      },
    ];

    socketOnConnect = (currentSocket) => {
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_ready',
          seq: 2,
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: sessionId,
            message: {
              id: 'm2',
              seq: 2,
              localId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    id: 'ready_evt_1',
                    type: 'event',
                    data: { type: 'ready' },
                  },
                },
              },
            },
          },
        });
      }, 450);
    };

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);

    try {
      const waitPromise = handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      let settled = false;
      void waitPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await waitPromise;

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.idle).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('treats a transcript ready event as completion for a settled pending user turn before the socket connects', async () => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    transcriptMessages = [
      {
        id: 'm2',
        seq: 2,
        createdAt: 2,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              id: 'ready_evt_existing',
              type: 'event',
              data: { type: 'ready' },
            },
          },
        },
      },
      {
        id: 'm1',
        seq: 1,
        createdAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'already done' },
          },
        },
      },
    ];

    socketOnConnect = () => {
      // No fresh lifecycle updates arrive after wait attaches; the initial transcript must be enough.
    };

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);

    try {
      await handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.idle).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('does not resolve when a turn starts after the initial transcript snapshot but before the socket observes completion', async () => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    transcriptMessages = [];

    socketOnConnect = (currentSocket) => {
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_task_complete_race',
          seq: 4,
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: sessionId,
            message: {
              id: 'm4',
              seq: 4,
              localId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    provider: 'claude',
                    data: { type: 'task_complete', id: 'task_wait_race_1' },
                  },
                },
              },
            },
          },
        });
      }, 450);
    };

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);

    try {
      const waitPromise = handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      await waitForTranscriptFetch();

      transcriptMessages = [
        {
          id: 'm2',
          seq: 2,
          createdAt: 2,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello after snapshot' },
            },
          },
        },
        {
          id: 'm3',
          seq: 3,
          createdAt: 3,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'claude',
                data: { type: 'task_started', id: 'task_wait_race_1' },
              },
            },
          },
        },
      ];

      let settled = false;
      void waitPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await waitPromise;

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.idle).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('treats a follow-up user turn as still in flight even if the previous task_complete lands after that user message', async () => {
    initialAgentStateCiphertext = idleAgentStateCiphertext;
    transcriptMessages = [
      {
        id: 'm1',
        seq: 1,
        createdAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'initial prompt' },
          },
        },
      },
      {
        id: 'm2',
        seq: 2,
        createdAt: 2,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'claude',
              data: { type: 'task_started', id: 'task_old' },
            },
          },
        },
      },
      {
        id: 'm3',
        seq: 3,
        createdAt: 3,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'follow-up prompt' },
          },
        },
      },
      {
        id: 'm4',
        seq: 4,
        createdAt: 4,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'claude',
              data: { type: 'task_complete', id: 'task_old' },
            },
          },
        },
      },
    ];

    socketOnConnect = (currentSocket) => {
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_task_started_followup',
          seq: 5,
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: sessionId,
            message: {
              id: 'm5',
              seq: 5,
              localId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    provider: 'claude',
                    data: { type: 'task_started', id: 'task_followup' },
                  },
                },
              },
            },
          },
        });
      }, 700);
      setTimeout(() => {
        currentSocket.trigger('update', {
          id: 'u_task_complete_followup',
          seq: 6,
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: sessionId,
            message: {
              id: 'm6',
              seq: 6,
              localId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    provider: 'claude',
                    data: { type: 'task_complete', id: 'task_followup' },
                  },
                },
              },
            },
          },
        });
      }, 950);
    };

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    const machineKeySeed = new Uint8Array(32).fill(8);

    try {
      const waitPromise = handleSessionCommand(['wait', sessionId, '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      let settled = false;
      void waitPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);

      await waitPromise;

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_wait');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.idle).toBe(true);
    } finally {
      output.restore();
    }
  });
});
