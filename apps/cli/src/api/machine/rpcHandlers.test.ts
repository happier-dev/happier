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
import { registerMachineRpcHandlers } from './rpcHandlers';
import type { Credentials } from '@/persistence';

const { readCredentialsMock } = vi.hoisted(() => ({
  readCredentialsMock: vi.fn<() => Promise<Credentials | null>>(async () => null),
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
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    daemonStateFile: '/tmp/happier-test-home/daemon.state.json',
    isDaemonProcess: false,
  },
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

  it('continues a session by spawning a new one and returning a Happier replay seed draft', async () => {
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
        data: { session: { id: 'sess_prev', dataEncryptionKey: encodeBase64(envelope) } },
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
      } as any);

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 2,
        seedMode: 'draft',
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo',
        agent: 'claude',
        approvedNewDirectoryCreation: true,
      }),
    );
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    expect(String(result.seedDraft ?? '')).toContain('Previous session id: sess_prev');
    expect(String(result.seedDraft ?? '')).toContain('Assistant: two');
    expect(String(result.seedDraft ?? '')).toContain('User: three');
    expect(String(result.seedDraft ?? '')).not.toContain('User: one');
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

  it('does not env-inject oversized seed drafts (falls back to draft mode)', async () => {
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

    const prevMaxSeed = process.env.HAPPIER_REPLAY_MAX_ENV_SEED_CHARS;
    const prevMaxText = process.env.HAPPIER_REPLAY_MAX_TEXT_CHARS;
    process.env.HAPPIER_REPLAY_MAX_ENV_SEED_CHARS = '50';
    process.env.HAPPIER_REPLAY_MAX_TEXT_CHARS = '100';

    try {
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

      const longText = 'x'.repeat(120);
      const encryptedOne = encodeBase64(
        encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: longText } }),
      );

      const getSpy = vi.spyOn(axios, 'get');
      getSpy
        .mockResolvedValueOnce({
          status: 200,
          data: { session: { id: 'sess_prev', dataEncryptionKey: encodeBase64(envelope) } },
        } as any)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            messages: [
              { seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } },
            ],
          },
        } as any);

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
      expect(String(result.seedDraft ?? '')).toContain('Previous session id: sess_prev');
    } finally {
      if (prevMaxSeed === undefined) delete process.env.HAPPIER_REPLAY_MAX_ENV_SEED_CHARS;
      else process.env.HAPPIER_REPLAY_MAX_ENV_SEED_CHARS = prevMaxSeed;
      if (prevMaxText === undefined) delete process.env.HAPPIER_REPLAY_MAX_TEXT_CHARS;
      else process.env.HAPPIER_REPLAY_MAX_TEXT_CHARS = prevMaxText;
    }
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
      const expected = await collectBugReportMachineDiagnosticsSnapshot({
        daemonLogLimit: 5,
        stackLogLimit: 3,
        stackRuntimeMaxChars: 400_000,
      });

      expect(diagnostics).toEqual(expected);
      expect(diagnostics.stackContext?.stackName).toBe(stackName);
      expect(diagnostics.stackContext?.runtimeStatePath).toBe(runtimePath);
      expect(diagnostics.stackContext?.logCandidates).toContain(runnerLogPath);
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
});
