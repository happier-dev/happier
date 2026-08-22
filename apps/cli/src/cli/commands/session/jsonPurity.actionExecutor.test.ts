import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, captureStdout } from '@/testkit/logger/captureOutput';

const executeFromCredentials = vi.fn();
const executeDirect = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute: executeFromCredentials }));
const createCliActionExecutor = vi.fn(() => ({ execute: executeDirect }));
const resolveSessionTransportContext = vi.fn();
const resolveSessionIdOrPrefix = vi.fn();
const fetchSessionById = vi.fn();
const listExecutionRuns = vi.fn();

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/session/services/executionRuns', () => ({
  listExecutionRuns,
}));

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

type JsonCommandCase = Readonly<{
  name: string;
  argv: string[];
  expectedKind: string;
}>;

function actionResultFor(actionId: string): unknown {
  switch (actionId) {
    case 'session.list':
      return { ok: true, result: { sessions: [], nextCursor: null, hasNext: false } };
    case 'session.status.get':
      return { ok: true, result: { session: { id: 'sess-1', active: false } } };
    case 'session.transcript.get':
      return {
        ok: true,
        result: {
          ok: true,
          sessionId: 'sess-1',
          items: [],
          nextCursor: null,
          hasMore: false,
          diagnostics: { rawRowsScanned: 0, pagesFetched: 0, scanLimitReached: false, payloadTruncations: 0 },
        },
      };
    case 'session.wait.idle':
      return { ok: true, result: { sessionId: 'sess-1', observedAt: 123 } };
    case 'session.stop':
      return { ok: true, result: { ok: true, sessionId: 'sess-1', stopped: true } };
    case 'session.archive':
      return { ok: true, result: { ok: true, sessionId: 'sess-1', archivedAt: 123 } };
    case 'execution.run.start':
      return { ok: true, result: { ok: true, runId: 'run-1' } };
    case 'execution.run.list':
      return { ok: true, result: { ok: true, runs: [] } };
    case 'execution.run.get':
      return { ok: true, result: { ok: true, run: { id: 'run-1', status: 'completed' } } };
    case 'execution.run.send':
    case 'execution.run.stop':
      return { ok: true, result: { ok: true } };
    case 'execution.run.action':
      return { ok: true, result: { ok: true, accepted: true } };
    case 'execution.run.wait':
      return { ok: true, result: { status: 'completed' } };
    case 'session.fork':
      return { ok: true, result: { childSessionId: 'sess-child' } };
    case 'session.continue_with_replay':
      return { ok: true, result: { sessionId: 'sess-child' } };
    case 'session.rollback':
      return { ok: true, result: { ok: true, changed: true } };
    case 'session.checkpoint_code_rollback':
      return { ok: true, result: { status: 'applied', changedPaths: [], skippedPaths: [], receipts: [] } };
    case 'session.checkpoint':
      return { ok: true, result: { ok: true, checkpointId: 'checkpoint-1' } };
    default:
      throw new Error(`unexpected action:${actionId}`);
  }
}

function captureJsonProcessOutput(): Readonly<{
  parse: () => unknown;
  assertPure: () => void;
  restore: () => void;
}> {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const stdout = captureStdout();
  const stderr = captureStderr();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(' '));
  });

  return {
    parse: () => JSON.parse(logs.join('\n').trim()),
    assertPure: () => {
      expect(logs).toHaveLength(1);
      expect(logs[0]?.trim().startsWith('{')).toBe(true);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toBe('');
    },
    restore: () => {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
      stderr.restore();
      stdout.restore();
    },
  };
}

describe('happier session --json output purity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeFromCredentials.mockImplementation(async (actionId: string) => actionResultFor(actionId));
    executeDirect.mockImplementation(async (actionId: string) => actionResultFor(actionId));
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1', metadata: {}, encryptionMode: 'plain' },
      ctx: null,
      mode: 'plain' as const,
    });
    resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-1' });
    fetchSessionById.mockResolvedValue({ id: 'sess-1', metadata: {}, encryptionMode: 'plain' });
    listExecutionRuns.mockResolvedValue({ ok: true, data: { runs: [] } });
  });

  const cases: readonly JsonCommandCase[] = [
    { name: 'list', argv: ['list', '--json'], expectedKind: 'session_list' },
    { name: 'status', argv: ['status', 'sess-1', '--live', '--json'], expectedKind: 'session_status' },
    { name: 'history', argv: ['history', 'sess-1', '--json'], expectedKind: 'session_history' },
    { name: 'wait', argv: ['wait', 'sess-1', '--timeout', '1', '--json'], expectedKind: 'session_wait' },
    { name: 'stop', argv: ['stop', 'sess-1', '--json'], expectedKind: 'session_stop' },
    { name: 'archive', argv: ['archive', 'sess-1', '--json'], expectedKind: 'session_archive' },
    { name: 'actions list', argv: ['actions', 'list', '--json'], expectedKind: 'session_actions_list' },
    { name: 'actions describe', argv: ['actions', 'describe', 'review.start', '--json'], expectedKind: 'session_actions_describe' },
    { name: 'actions execute fork', argv: ['actions', 'execute', 'sess-1', 'session.fork', '--input-json', '{"forkPoint":{"type":"latest"}}', '--json'], expectedKind: 'session_actions_execute' },
    { name: 'actions execute replay', argv: ['actions', 'execute', 'sess-1', 'session.continue_with_replay', '--input-json', '{"replay":{"seedDraft":"continue"}}', '--json'], expectedKind: 'session_actions_execute' },
    { name: 'actions execute rollback', argv: ['actions', 'execute', 'sess-1', 'session.rollback', '--input-json', '{"target":{"type":"latest_turn"}}', '--json'], expectedKind: 'session_actions_execute' },
    { name: 'actions execute checkpoint rollback', argv: ['actions', 'execute', 'sess-1', 'session.checkpoint_code_rollback', '--input-json', '{"v":1}', '--json'], expectedKind: 'session_actions_execute' },
    { name: 'actions execute checkpoint', argv: ['actions', 'execute', 'sess-1', 'session.checkpoint', '--input-json', '{"v":1,"scopes":["workspace"],"candidate":{"source":"happier_scm"}}', '--json'], expectedKind: 'session_actions_execute' },
    { name: 'run start', argv: ['run', 'start', 'sess-1', '--intent', 'review', '--backend', 'agent:claude', '--json'], expectedKind: 'session_run_start' },
    { name: 'run list', argv: ['run', 'list', 'sess-1', '--json'], expectedKind: 'session_run_list' },
    { name: 'run get', argv: ['run', 'get', 'sess-1', 'run-1', '--json'], expectedKind: 'session_run_get' },
    { name: 'run send', argv: ['run', 'send', 'sess-1', 'run-1', 'hello', '--json'], expectedKind: 'session_run_send' },
    { name: 'run stop', argv: ['run', 'stop', 'sess-1', 'run-1', '--json'], expectedKind: 'session_run_stop' },
    { name: 'run action', argv: ['run', 'action', 'sess-1', 'run-1', 'review.triage', '--input-json', '{}', '--json'], expectedKind: 'session_run_action' },
    { name: 'run wait', argv: ['run', 'wait', 'sess-1', 'run-1', '--timeout', '1', '--json'], expectedKind: 'session_run_wait' },
  ];

  it.each(cases)('prints only one JSON envelope for $name', async ({ argv, expectedKind }) => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureJsonProcessOutput();
    try {
      await handleSessionCommand(argv, { readCredentialsFn: async () => credentials });

      const parsed = output.parse() as { ok?: unknown; kind?: unknown };
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe(expectedKind);
      output.assertPure();
    } finally {
      output.restore();
    }
  });
});
