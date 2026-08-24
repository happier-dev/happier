import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, captureStdout } from '@/testkit/logger/captureOutput';

const {
  execute,
  createCliActionExecutor,
  createCliActionExecutorFromCredentials,
  readStoredCredentials,
  readSettings,
  readAgentCatalogSnapshot,
  fetchSessionById,
  fetchAccountEncryptionCurrentness,
  ensureCliActionPolicySettings,
  executorFactoryCredentials,
} = vi.hoisted(() => {
  const execute = vi.fn();
  const executorFactoryCredentials: unknown[] = [];
  return {
    execute,
    createCliActionExecutor: vi.fn((params: Readonly<{ credentials: unknown }>) => {
      executorFactoryCredentials.push(params.credentials);
      return { execute };
    }),
    createCliActionExecutorFromCredentials: vi.fn((params: Readonly<{ credentials: unknown }>) => {
      executorFactoryCredentials.push(params.credentials);
      return {
        execute,
        resolveSessionTarget: async () => ({ ok: true as const, sessionId: 'c012345678901234567890123' }),
      };
    }),
    readStoredCredentials: vi.fn(),
    readSettings: vi.fn(),
    readAgentCatalogSnapshot: vi.fn(),
    fetchSessionById: vi.fn(),
    fetchAccountEncryptionCurrentness: vi.fn(),
    ensureCliActionPolicySettings: vi.fn(),
    executorFactoryCredentials,
  };
});

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readStoredCredentials,
    readSettings,
  };
});

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness,
}));

vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return {
    ...actual,
    configuration: {
      ...actual.configuration,
      activeServerId: 'server-1',
    },
  };
});

import { FIRST_CLASS_SESSION_COMMANDS } from './firstClassSessionCommands';
import { handleSessionCliCommand } from './commands/session';

const sessionId = 'c012345678901234567890123';
const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

type ParityCase = Readonly<{
  command: 'spawn' | 'list' | 'send' | 'history' | 'wait' | 'stop' | 'delegate';
  nestedPath: readonly string[];
  args: readonly string[];
}>;

type Invocation = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  actionCalls: readonly unknown[][];
  factoryCredentials: readonly unknown[];
  readStoredCredentialsCalls: number;
}>;

function actionResult(actionId: string): unknown {
  switch (actionId) {
    case 'session.spawn_new':
      return {
        ok: true,
        result: {
          type: 'success',
          sessionId,
          disposition: 'created',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' },
        },
      };
    case 'session.list':
      return { ok: true, result: { sessions: [], nextCursor: null, hasNext: false } };
    case 'session.message.send':
      return { ok: true, result: { ok: true, sessionId, localId: 'local-1', waited: false } };
    case 'session.transcript.get':
      return {
        ok: true,
        result: {
          ok: true,
          sessionId,
          items: [],
          nextCursor: null,
          hasMore: false,
          diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
        },
      };
    case 'session.wait.idle':
      return { ok: true, result: { ok: true, sessionId, observedAt: 123 } };
    case 'session.stop':
      return { ok: true, result: { ok: true, sessionId, stopped: true } };
    case 'action.options.resolve':
      return {
        ok: true,
        result: {
          actionId: 'subagents.delegate.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }],
        },
      };
    case 'subagents.delegate.start':
      return { ok: true, result: { results: [{ key: 'agent:com.acme.agent/acme' }] } };
    default:
      throw new Error(`Unexpected action: ${actionId}`);
  }
}

function resetInvocationSpies(): void {
  execute.mockClear();
  createCliActionExecutor.mockClear();
  createCliActionExecutorFromCredentials.mockClear();
  readStoredCredentials.mockClear();
  executorFactoryCredentials.length = 0;
}

async function captureInvocation(invoke: () => Promise<void>): Promise<Invocation> {
  const stdout = captureStdout();
  const stderr = captureStderr();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await invoke();
    return {
      stdout: stdout.text(),
      stderr: stderr.text(),
      exitCode: process.exitCode ?? 0,
      actionCalls: execute.mock.calls.map((call) => [...call]),
      factoryCredentials: [...executorFactoryCredentials],
      readStoredCredentialsCalls: readStoredCredentials.mock.calls.length,
    };
  } finally {
    process.exitCode = previousExitCode;
    stderr.restore();
    stdout.restore();
  }
}

async function runNested(parityCase: ParityCase): Promise<Invocation> {
  resetInvocationSpies();
  return await captureInvocation(async () => {
    await handleSessionCliCommand({
      args: ['session', ...parityCase.nestedPath, ...parityCase.args],
      rawArgv: ['happier', 'session', ...parityCase.nestedPath, ...parityCase.args],
      terminalRuntime: null,
    });
  });
}

async function runFirstClass(parityCase: ParityCase): Promise<Invocation> {
  const command = FIRST_CLASS_SESSION_COMMANDS.find((entry) => entry.command === parityCase.command);
  if (!command) throw new Error(`Missing first-class command: ${parityCase.command}`);

  resetInvocationSpies();
  return await captureInvocation(async () => {
    await command.handler({
      args: [parityCase.command, ...parityCase.args],
      rawArgv: ['happier', parityCase.command, ...parityCase.args],
      terminalRuntime: null,
    });
  });
}

describe('first-class session command parity', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockImplementation(async (actionId: string) => actionResult(actionId));
    createCliActionExecutor.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
    readStoredCredentials.mockReset();
    readStoredCredentials.mockResolvedValue(credentials);
    readSettings.mockReset();
    readSettings.mockResolvedValue({ machineId: 'machine-1' });
    readAgentCatalogSnapshot.mockReset();
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['claude', {
          id: 'claude',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        }],
      ]),
    });
    fetchSessionById.mockReset();
    fetchSessionById.mockResolvedValue({ id: sessionId, encryptionMode: 'plain', dataEncryptionKey: null });
    fetchAccountEncryptionCurrentness.mockReset();
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain' });
    ensureCliActionPolicySettings.mockReset();
    ensureCliActionPolicySettings.mockResolvedValue(undefined);
  });

  it.each<ParityCase>([
    {
      command: 'spawn',
      nestedPath: ['create'],
      args: ['--path', '/tmp/project', '--agent', 'agent:claude', '--spawn-attempt-id', 'spawn-1', '--json'],
    },
    { command: 'list', nestedPath: ['list'], args: ['--json'] },
    { command: 'send', nestedPath: ['send'], args: [sessionId, 'Hello', '--local-id', 'local-1', '--json'] },
    { command: 'history', nestedPath: ['history'], args: [sessionId, '--json'] },
    { command: 'wait', nestedPath: ['wait'], args: [sessionId, '--json'] },
    { command: 'stop', nestedPath: ['stop'], args: [sessionId, '--json'] },
    {
      command: 'delegate',
      nestedPath: ['delegate', 'start'],
      args: [sessionId, 'Delegate this.', '--agent', 'Acme Agent', '--json'],
    },
  ])('$command projects to the same canonical action contract', async (parityCase) => {
    const nested = await runNested(parityCase);
    const firstClass = await runFirstClass(parityCase);

    expect(nested.actionCalls).toEqual(firstClass.actionCalls);
    expect(nested.stdout).toBe(firstClass.stdout);
    expect(nested.stderr).toBe(firstClass.stderr);
    expect(nested.exitCode).toBe(firstClass.exitCode);
    expect(nested.exitCode).toBe(0);
    expect(nested.factoryCredentials).toHaveLength(1);
    expect(firstClass.factoryCredentials).toHaveLength(1);
    expect(nested.factoryCredentials[0]).toBe(credentials);
    expect(firstClass.factoryCredentials[0]).toBe(credentials);
    expect(nested.readStoredCredentialsCalls).toBe(1);
    expect(firstClass.readStoredCredentialsCalls).toBe(1);
  });
});
