import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import axios from 'axios';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { collectBugReportMachineDiagnosticsSnapshot } from '@/diagnostics/bugReportMachineDiagnostics';
import { removeExecutionRunMarker, writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { registerMachineRpcHandlers } from './rpcHandlers';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import type { Credentials } from '@/persistence';

const { readCredentialsMock, psListMock } = vi.hoisted(() => ({
  readCredentialsMock: vi.fn<() => Promise<Credentials | null>>(async () => null),
  psListMock: vi.fn(async () => [] as any[]),
}));

const { updateSessionMetadataWithRetryMock } = vi.hoisted(() => ({
  updateSessionMetadataWithRetryMock: vi.fn(async (args: any) => ({
    version: Number(args?.rawSession?.metadataVersion ?? 0) + 1,
    metadata: (args?.updater ? args.updater({}) : {}) as Record<string, unknown>,
  })),
}));

const { forkOpenCodeSessionNativeMock } = vi.hoisted(() => ({
  forkOpenCodeSessionNativeMock: vi.fn(async () => null as any),
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readCredentials: readCredentialsMock,
    // Filesystem boundary: avoid noisy retries when configuration is mocked.
    readDaemonState: async () => null,
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://example.invalid',
    apiServerUrl: 'http://example.invalid',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    daemonStateFile: '/tmp/happier-test-home/daemon.state.json',
    isDaemonProcess: false,
  },
}));

vi.mock('@/sessionControl/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@/backends/opencode/server/nativeFork', () => ({
  forkOpenCodeSessionNative: forkOpenCodeSessionNativeMock,
}));

describe('registerMachineRpcHandlers', () => {
  it('normalizes empty modelId to undefined when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      modelId: '',
      modelUpdatedAt: 123,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, modelUpdatedAt: 123 }));
  });

  it('normalizes whitespace-only modelId to undefined when resuming a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      directory: '/tmp',
      sessionId: 'sess_old',
      agent: 'claude',
      modelId: '   ',
      modelUpdatedAt: 456,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, modelUpdatedAt: 456 }));
  });

  it('normalizes invalid permissionMode to undefined when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      permissionMode: 'not-a-mode',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: undefined }));
  });

  it('passes through valid permissionMode values when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      permissionMode: 'yolo',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'yolo' }));
  });

  it('registers bug report diagnostics handlers', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS)).toBe(true);
    expect(registered.has(RPC_METHODS.BUGREPORT_GET_LOG_TAIL)).toBe(true);
    expect(registered.has(RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT)).toBe(true);
  });

  it('registers daemon execution run listing handler', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has((RPC_METHODS as any).DAEMON_EXECUTION_RUNS_LIST)).toBe(true);

    const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await writeExecutionRunMarker({
        pid: 12345,
        happySessionId: 'sess-1',
        runId,
        callId: 'call-1',
        sidechainId: 'side-1',
        intent: 'review',
        backendId: 'claude',
        runClass: 'bounded',
        ioMode: 'request_response',
        retentionPolicy: 'ephemeral',
        status: 'running',
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const handler = registered.get((RPC_METHODS as any).DAEMON_EXECUTION_RUNS_LIST);
      expect(handler).toBeDefined();

      psListMock.mockResolvedValueOnce([
        { pid: 12345, name: 'node', cmd: '/secret', cpu: 1, memory: 2 },
      ]);

      const res = await handler!({});
      expect(res).toEqual(expect.objectContaining({
        runs: expect.any(Array),
      }));
      expect((res.runs as any[]).some((entry) => entry?.runId === runId)).toBe(true);

      const entry = (res.runs as any[]).find((r) => r?.runId === runId);
      expect(entry?.process?.cmd).toBeUndefined();
    } finally {
      await removeExecutionRunMarker(runId);
    }
  });

  it('continues a session by spawning a new one and storing a Happier replay seed in child metadata', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'one' } }),
    );
    const encryptedTwo = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'two' } }),
    );
    const encryptedThree = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'three' } }),
    );

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { createdAt: 1, content: { t: 'encrypted', c: encryptedOne } },
            { createdAt: 2, content: { t: 'encrypted', c: encryptedTwo } },
            { createdAt: 3, content: { t: 'encrypted', c: encryptedThree } },
          ],
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_new',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 2,
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo',
        agent: 'claude',
        approvedNewDirectoryCreation: true,
      }),
    );
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    expect((result as any).seedDraft).toBeUndefined();
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'claude' });
    expect(updated.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_prev', parentCutoffSeqInclusive: 3, strategy: 'replay' });
    expect(updated.replaySeedV1).toMatchObject({ v: 1, sourceSessionId: 'sess_prev', sourceCutoffSeqInclusive: 3 });
    expect(String(updated.replaySeedV1.seedText ?? '')).toContain('Assistant: two');
    expect(String(updated.replaySeedV1.seedText ?? '')).toContain('User: three');
    expect(String(updated.replaySeedV1.seedText ?? '')).not.toContain('User: one');
  });

  it('forks a session by replaying transcript context and storing forkV1/replaySeedV1 in child metadata', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { path: '/repo', flavor: 'claude', permissionMode: { v: 1, mode: 'default', updatedAt: 1 } }),
    );

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'hello fork' } }),
    );
    const encryptedTwo = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'hi fork' } }),
    );

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      // fetch parent session record (for fork handler)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchSessionById(previousSessionId)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } },
            { seq: 2, createdAt: 2, content: { t: 'encrypted', c: encryptedTwo } },
          ],
        },
      } as any)
      // fetch child session record for metadata update
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadata: encodeBase64(encrypt(sessionEncryptionKey, 'dataKey', { path: '/repo', flavor: 'claude' })),
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 2 },
      strategy: 'replay',
    });
    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo', agent: 'claude' }));
    expect(getSpy).toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'claude' });
    expect(updated.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_parent', parentCutoffSeqInclusive: 2 });
    expect(updated.replaySeedV1).toMatchObject({ v: 1, sourceSessionId: 'sess_parent', sourceCutoffSeqInclusive: 2 });
  });

  it('forks an OpenCode session via provider-native server fork when backendMode is server', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    forkOpenCodeSessionNativeMock.mockResolvedValueOnce({ vendorSessionId: 'op_ses_forked' });

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'server',
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(forkOpenCodeSessionNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      parentHappySessionId: 'sess_parent',
      parentOpenCodeSessionId: 'op_ses_parent',
      forkPoint: { type: 'latest' },
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      agent: 'opencode',
      resume: 'op_ses_forked',
      environmentVariables: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'opencode' });
    expect(updated.opencodeSessionId).toBe('op_ses_forked');
    expect(updated.opencodeBackendMode).toBe('server');
    expect(updated.forkV1).toMatchObject({
      v: 1,
      parentSessionId: 'sess_parent',
      parentCutoffSeqInclusive: 5,
      strategy: 'provider_native',
      providerHint: { providerId: 'opencode', backendMode: 'server', vendorSessionId: 'op_ses_forked' },
    });
  });

  it('preserves OpenCode backend mode when replay-forking an ACP-backed OpenCode session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'acp',
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      // fetch parent session record (for fork handler)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchSessionById(previousSessionId)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello fork' } } } },
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'hi fork' } } } },
          ],
        },
      } as any)
      // fetch child session record for metadata update
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 2 },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      agent: 'opencode',
      environmentVariables: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'opencode' });
    expect(updated.opencodeBackendMode).toBe('acp');
  });

  it('rejects unknown replay agent ids (fail closed)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const getSpy = vi.spyOn(axios, 'get').mockImplementation(() => {
      throw new Error('should not call axios.get for unknown agent ids');
    });

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const result = await handler!({
      directory: '/repo',
      agent: 'not-a-real-agent',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 2,
        seedMode: 'draft',
      },
    });

    expect(spawnSession).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'error' });
  });

  it('does not inject replay seeds as initial prompts (seed is stored in metadata)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'hello' } }),
    );

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [{ seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } }],
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_new',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

      const result = await handler!({
        directory: '/repo',
        agent: 'claude',
        approvedNewDirectoryCreation: true,
        replay: {
          previousSessionId: 'sess_prev',
          strategy: 'recent_messages',
          recentMessagesCount: 1,
          seedMode: 'daemon_initial_prompt',
        },
      });

      expect(spawnSession).toHaveBeenCalledTimes(1);
      // vitest's Mock type can infer a 0-arg function; use a narrow cast for call inspection.
      const arg = ((spawnSession as any).mock?.calls?.[0] as any[] | undefined)?.[0] ?? null;
      expect(arg && typeof arg === 'object' && 'initialPrompt' in arg).toBe(false);
      expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
      expect((result as any).seedDraft).toBeUndefined();
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('includes stack diagnostics context for bug report collection when stack env is set', async () => {
    const stackHome = await mkdtemp(join(tmpdir(), 'rpc-bugreport-stack-'));
    const stackName = 'qa-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'dev.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimePath,
      JSON.stringify({
        stackName,
        logs: {
          runner: runnerLogPath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(runnerLogPath, 'runner output\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimePath;

    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const collectHandler = registered.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
      expect(collectHandler).toBeDefined();
      const diagnostics = await collectHandler!({});
      expect(diagnostics.stackContext?.stackName).toBe(stackName);
      expect(diagnostics.stackContext?.runtimeStatePath).toBe(runtimePath);
      expect(diagnostics.stackContext?.logCandidates).toContain(runnerLogPath);
      expect(diagnostics.doctorSnapshot).toBeDefined();
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('rejects bug report log tail reads for paths outside diagnostics candidates', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rpc-bugreport-deny-'));
    const outsideLogPath = join(sandbox, 'outside.log');
    await writeFile(outsideLogPath, 'outside log\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const logTailHandler = registered.get(RPC_METHODS.BUGREPORT_GET_LOG_TAIL);
    expect(logTailHandler).toBeDefined();
    const result = await logTailHandler!({
      path: outsideLogPath,
      maxBytes: 2048,
    });

    expect(result).toMatchObject({
      ok: false,
    });
    expect(String(result.error ?? '')).toContain('not allowed');
  });

  it('bounds UTF-8 log tails by maxBytes for allowed log paths', async () => {
    const stackHome = await mkdtemp(join(tmpdir(), 'rpc-bugreport-utf8-'));
    const stackName = 'utf8-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'runner.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimePath,
      JSON.stringify({
        stackName,
        logs: {
          runner: runnerLogPath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(runnerLogPath, `${'😀'.repeat(2_000)}\nEND\n`, 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimePath;

    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const logTailHandler = registered.get(RPC_METHODS.BUGREPORT_GET_LOG_TAIL);
      expect(logTailHandler).toBeDefined();
      const result = await logTailHandler!({
        path: runnerLogPath,
        maxBytes: 1024,
      });

      expect(result).toMatchObject({
        ok: true,
      });
      const byteLength = Buffer.byteLength(String(result.tail ?? ''), 'utf8');
      expect(byteLength).toBeLessThanOrEqual(1024);
      expect(String(result.tail ?? '')).toContain('END');
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('ignores stack runtime runner paths outside stack logs directory', async () => {
    const stackHome = await mkdtemp(join(tmpdir(), 'rpc-bugreport-stack-scope-'));
    const stackName = 'scope-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'runner.log');
    const outsideRunnerPath = join(stackHome, 'outside-runner.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimePath,
      JSON.stringify({
        stackName,
        logs: {
          runner: outsideRunnerPath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(runnerLogPath, 'runner output\n', 'utf8');
    await writeFile(outsideRunnerPath, 'outside output\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimePath;

    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const collectHandler = registered.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
      expect(collectHandler).toBeDefined();
      const diagnostics = await collectHandler!({});

      expect(diagnostics.stackContext?.logCandidates).toContain(runnerLogPath);
      expect(diagnostics.stackContext?.logCandidates).not.toContain(outsideRunnerPath);
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('registers daemon memory handlers when memory worker is provided', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker: {
        stop: () => {},
        reloadSettings: async () => {},
        ensureUpToDate: async () => {},
	        getSettings: () => ({
	          v: 1,
          enabled: false,
          indexMode: 'hints',
          defaultScope: { type: 'global' as const },
          backfillPolicy: 'new_only' as const,
          deleteOnDisable: false,
          hints: {
            summarizerBackendId: 'claude',
            summarizerModelId: 'default',
            summarizerPermissionMode: 'no_tools',
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            paddingMessagesOnVerify: 8,
            updateMode: 'onIdle',
            idleDelayMs: 30_000,
            maxRunsPerHour: 12,
            failureBackoffBaseMs: 60_000,
            failureBackoffMaxMs: 900_000,
            maxShardsPerSession: 250,
            maxKeywords: 12,
            maxEntities: 12,
            maxDecisions: 12,
          },
	          deep: {
	            recentDays: 30,
	            maxChunkChars: 12_000,
	            maxChunkMessages: 50,
	            minChunkMessages: 5,
	            includeAssistantAcpMessage: true,
	            includeToolOutput: false,
	            candidateLimit: 200,
	            previewChars: 800,
	            failureBackoffBaseMs: 60_000,
	            failureBackoffMaxMs: 3_600_000,
	          },
          embeddings: {
            enabled: false,
            provider: 'local_transformers',
            modelId: '',
            wFts: 1,
            wEmb: 1,
          },
          budgets: {
            maxDiskMbLight: 64,
            maxDiskMbDeep: 512,
          },
          worker: {
            tickIntervalMs: 10_000,
            inventoryRefreshIntervalMs: 60_000,
            maxSessionsPerTick: 2,
            sessionListPageLimit: 50,
          },
	        }),
	        getTier1DbPath: () => null,
	        getDeepDbPath: () => null,
	      },
	    });

    expect(registered.has((RPC_METHODS as any).DAEMON_MEMORY_SEARCH)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_MEMORY_GET_WINDOW)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_MEMORY_STATUS)).toBe(true);
  });
});
