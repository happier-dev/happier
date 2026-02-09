import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  VOICE_MEDIATOR_ERROR_CODES,
  type VoiceMediatorCommitRequest,
  type VoiceMediatorCommitResponse,
  type VoiceMediatorGetModelsRequest,
  type VoiceMediatorGetModelsResponse,
  type VoiceMediatorSendTurnRequest,
  type VoiceMediatorSendTurnResponse,
  type VoiceMediatorStartRequest,
  type VoiceMediatorStartResponse,
  type VoiceMediatorStopRequest,
  type VoiceMediatorStopResponse,
} from '@happier-dev/protocol';
import type { AgentModelConfig } from '@happier-dev/agents';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

function fakeClaudeSource(): string {
  return `
const readline = require('node:readline');
let turn = 0;
let didInit = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = String(line||'').trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg || msg.type !== 'user') return;
  turn++;
  if (!didInit) {
    didInit = true;
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ASSIST_' + turn }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: 'fake' }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;
}

type VoiceMediatorRpcError = Readonly<{ error: string; errorCode?: string }>;

function isVoiceMediatorRpcError(value: unknown): value is VoiceMediatorRpcError {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { error?: unknown }).error === 'string';
}

function expectVoiceMediatorSuccess<T>(value: T | VoiceMediatorRpcError): T {
  if (isVoiceMediatorRpcError(value)) {
    throw new Error(`Expected success response, got: ${value.errorCode ?? value.error}`);
  }
  return value;
}

function expectVoiceMediatorErrorCode(value: unknown, code: string): void {
  expect(isVoiceMediatorRpcError(value)).toBe(true);
  if (!isVoiceMediatorRpcError(value)) {
    throw new Error('Expected voice mediator error response');
  }
  expect(value.errorCode).toBe(code);
}

describe.sequential('voice mediator RPC handlers', () => {
  let originalClaudePath: string | undefined;
  let originalDebug: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    originalClaudePath = process.env.HAPPIER_CLAUDE_PATH;
    originalDebug = process.env.DEBUG;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;

    if (originalClaudePath === undefined) {
      delete process.env.HAPPIER_CLAUDE_PATH;
    } else {
      process.env.HAPPIER_CLAUDE_PATH = originalClaudePath;
    }

    if (originalDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = originalDebug;
    }
  });

  it('start/sendTurn/commit/stop works via RpcHandlerManager', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-voice-mediator-rpc-'));
    const entry = join(dir, 'fake-claude.cjs');
    await writeFile(entry, fakeClaudeSource(), 'utf8');
    try {
      process.env.HAPPIER_CLAUDE_PATH = entry;
      delete process.env.DEBUG;

      const key = new Uint8Array(randomBytes(32));
      const { registerVoiceMediatorHandlers } = await import('./voiceMediator');
      const { call } = createEncryptedRpcTestClient({
        scopePrefix: 'session-1',
        encryptionKey: key,
        logger: () => {},
        registerHandlers: (manager) => registerVoiceMediatorHandlers(manager, { cwd: dir, flavor: 'claude' }),
      });

      const models = await call<VoiceMediatorGetModelsResponse, VoiceMediatorGetModelsRequest>(
        SESSION_RPC_METHODS.VOICE_MEDIATOR_GET_MODELS,
        {},
      );
      expect(models.supportsFreeform).toBe(true);
      expect(Array.isArray(models.availableModels)).toBe(true);
      expect(models.availableModels.some((model) => model.id === 'default')).toBe(true);

      const started = expectVoiceMediatorSuccess(
        await call<VoiceMediatorStartResponse | VoiceMediatorRpcError, VoiceMediatorStartRequest>(
          SESSION_RPC_METHODS.VOICE_MEDIATOR_START,
          {
            chatModelId: 'chat-model',
            commitModelId: 'commit-model',
            permissionPolicy: 'no_tools',
            idleTtlSeconds: 60,
            initialContext: 'CTX',
          },
        ),
      );

      const turn1 = expectVoiceMediatorSuccess(
        await call<VoiceMediatorSendTurnResponse | VoiceMediatorRpcError, VoiceMediatorSendTurnRequest>(
          SESSION_RPC_METHODS.VOICE_MEDIATOR_SEND_TURN,
          {
            mediatorId: started.mediatorId,
            userText: 'hi',
          },
        ),
      );
      expect(turn1.assistantText).toContain('ASSIST_1');

      const committed = expectVoiceMediatorSuccess(
        await call<VoiceMediatorCommitResponse | VoiceMediatorRpcError, VoiceMediatorCommitRequest>(
          SESSION_RPC_METHODS.VOICE_MEDIATOR_COMMIT,
          {
            mediatorId: started.mediatorId,
            kind: 'session_instruction',
          },
        ),
      );
      expect(typeof committed.commitText).toBe('string');

      const stopped = expectVoiceMediatorSuccess(
        await call<VoiceMediatorStopResponse | VoiceMediatorRpcError, VoiceMediatorStopRequest>(
          SESSION_RPC_METHODS.VOICE_MEDIATOR_STOP,
          {
            mediatorId: started.mediatorId,
          },
        ),
      );
      expect(stopped).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects daemon mediator start when requesting an unsupported agent backend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-voice-mediator-rpc-unsupported-'));
    const entry = join(dir, 'fake-claude.cjs');
    await writeFile(entry, fakeClaudeSource(), 'utf8');
    try {
      process.env.HAPPIER_CLAUDE_PATH = entry;
      delete process.env.DEBUG;

      const key = new Uint8Array(randomBytes(32));
      const { registerVoiceMediatorHandlers } = await import('./voiceMediator');
      const { call } = createEncryptedRpcTestClient({
        scopePrefix: 'session-1',
        encryptionKey: key,
        logger: () => {},
        registerHandlers: (manager) => registerVoiceMediatorHandlers(manager, { cwd: dir, flavor: 'claude' }),
      });

      const started = await call<VoiceMediatorStartResponse | VoiceMediatorRpcError, VoiceMediatorStartRequest>(
        SESSION_RPC_METHODS.VOICE_MEDIATOR_START,
        {
          agentSource: 'agent',
          agentId: 'not-a-real-agent',
          chatModelId: 'chat-model',
          commitModelId: 'commit-model',
          permissionPolicy: 'no_tools',
          idleTtlSeconds: 60,
          initialContext: 'CTX',
        },
      );

      expectVoiceMediatorErrorCode(started, VOICE_MEDIATOR_ERROR_CODES.UNSUPPORTED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes backend factory failures to VOICE_MEDIATOR_UNSUPPORTED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-voice-mediator-rpc-unsupported-backend-'));
    try {
      delete process.env.DEBUG;

      const key = new Uint8Array(randomBytes(32));
      const { call, manager } = createEncryptedRpcTestClient({
        scopePrefix: 'session-1',
        encryptionKey: key,
        logger: () => {},
        registerHandlers: () => undefined,
      });

      await vi.resetModules();
      vi.doMock('@/backends/opencode/acp/backend', () => ({
        createOpenCodeBackend: () => {
          throw new Error('opencode backend unavailable');
        },
      }));

      try {
        const { registerVoiceMediatorHandlers } = await import('./voiceMediator');
        registerVoiceMediatorHandlers(manager, { cwd: dir, flavor: 'opencode' });

        const started = await call<VoiceMediatorStartResponse | VoiceMediatorRpcError, VoiceMediatorStartRequest>(
          SESSION_RPC_METHODS.VOICE_MEDIATOR_START,
          {
            chatModelId: 'chat-model',
            commitModelId: 'commit-model',
            permissionPolicy: 'no_tools',
            idleTtlSeconds: 60,
            initialContext: 'CTX',
          },
        );

        expectVoiceMediatorErrorCode(started, VOICE_MEDIATOR_ERROR_CODES.UNSUPPORTED);
      } finally {
        vi.doUnmock('@/backends/opencode/acp/backend');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns default-only models when allowedModes is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-voice-mediator-rpc-models-'));
    try {
      const key = new Uint8Array(randomBytes(32));

      await vi.resetModules();
      vi.doMock('@happier-dev/agents', async () => {
        const actual = await vi.importActual<typeof import('@happier-dev/agents')>('@happier-dev/agents');
        return {
          ...actual,
          getAgentModelConfig: () =>
            ({
              supportsSelection: true,
              supportsFreeform: false,
              nonAcpApplyScope: 'next_prompt',
              defaultMode: 'default',
              allowedModes: [],
            }) satisfies AgentModelConfig,
        };
      });

      try {
        const { registerVoiceMediatorHandlers } = await import('./voiceMediator');
        const { call } = createEncryptedRpcTestClient({
          scopePrefix: 'session-1',
          encryptionKey: key,
          logger: () => {},
          registerHandlers: (manager) => registerVoiceMediatorHandlers(manager, { cwd: dir, flavor: 'claude' }),
        });

        const models = await call<VoiceMediatorGetModelsResponse, VoiceMediatorGetModelsRequest>(
          SESSION_RPC_METHODS.VOICE_MEDIATOR_GET_MODELS,
          {},
        );
        expect(models.availableModels).toEqual([{ id: 'default', name: 'Default' }]);
      } finally {
        vi.doUnmock('@happier-dev/agents');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
