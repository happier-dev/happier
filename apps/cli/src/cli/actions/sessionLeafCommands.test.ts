import { describe, expect, it, vi } from 'vitest';

import { loadActionCliPresentation } from './commandPresentation';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { runCompiledActionCliCommand } from './executeCommand';

type Execution = Readonly<{ actionId: string; input: unknown }>;

function commandFor(path: readonly string[]) {
  const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
  if (!command || command.path.join(' ') !== path.join(' ')) {
    throw new Error(`No compiled command for "${path.join(' ')}"`);
  }
  return command;
}

function harness() {
  const executions: Execution[] = [];
  const executor = {
    resolveSessionTarget: async (sessionId: string) => ({ ok: true as const, sessionId }),
    execute: async (actionId: string, input: unknown) => {
      executions.push({ actionId, input });
      if (actionId === 'session.status.get') {
        return {
          ok: true as const,
          result: {
            session: {
              id: 'session_1',
              createdAt: 1,
              updatedAt: 1,
              activeAt: 1,
              active: true,
              encryption: null,
            },
          },
        };
      }
      if (actionId === 'session.stop') {
        return { ok: true as const, result: { sessionId: 'session_1', stopped: true } };
      }
      if (actionId === 'session.wait.idle') {
        return { ok: true as const, result: { sessionId: 'session_1', idle: true, observedAt: 1 } };
      }
      return { ok: true as const, result: { ok: true, sessionId: 'session_1' } };
    },
  };
  const createExecutorFn = vi.fn(() => executor);
  const deps = {
    readCredentialsFn: vi.fn(async () => ({ token: 'hap_v1_test' } as never)),
    readCredentialsForServerIdFn: vi.fn(async () => ({ token: 'selected-home-token' } as never)),
    getServerProfileFn: vi.fn(async (serverId: string) => ({
      id: serverId,
      serverUrl: 'https://selected-home.example.test',
      localServerUrl: null,
      homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: { homeServerIdentityId: 'selected-home-identity' },
    } as never)),
    createServerFeaturesSnapshotStoreFn: vi.fn(() => ({ refresh: vi.fn(async () => ({})) } as never)),
    createExecutorFn,
  };
  return { executions, deps, createExecutorFn };
}

async function run(argv: readonly string[], pathLength: number) {
  const { executions, deps } = harness();
  await runCompiledActionCliCommand({
    command: commandFor(argv.slice(0, pathLength)),
    argv,
    deps: deps as never,
  });
  return executions;
}

/**
 * Every migrated one-shot Session leaf, as friendly argv and the exact canonical
 * Action input it must produce.
 *
 * These rows are the contract the old hand-written parsers held: the same
 * spellings, the same established shorthands and the same canonical input. They
 * are asserted through the real compiled boundary and the real Action specs, so
 * a declaration that drifts from the schema fails here rather than at a user's
 * terminal.
 */
const CORRESPONDENCE: readonly Readonly<{
  argv: readonly string[];
  pathLength: number;
  actionId: string;
  input: Readonly<Record<string, unknown>>;
}>[] = [
  {
    argv: ['session', 'status', 'session_1'],
    pathLength: 2,
    actionId: 'session.status.get',
    input: { sessionId: 'session_1' },
  },
  {
    argv: ['session', 'status', 'session_1', '--live'],
    pathLength: 2,
    actionId: 'session.status.get',
    input: { sessionId: 'session_1', live: true },
  },
  {
    argv: ['session', 'set-title', 'session_1', 'A new title'],
    pathLength: 2,
    actionId: 'session.title.set',
    input: { sessionId: 'session_1', title: 'A new title' },
  },
  {
    argv: ['session', 'set-permission-mode', 'session_1', 'plan'],
    pathLength: 2,
    actionId: 'session.permission_mode.set',
    input: { sessionId: 'session_1', permissionMode: 'plan' },
  },
  {
    // An established alias resolves to the same canonical intent the incumbent
    // command sent, not to the caller's spelling.
    argv: ['session', 'set-permission-mode', 'session_1', 'accept-edits'],
    pathLength: 2,
    actionId: 'session.permission_mode.set',
    input: { sessionId: 'session_1', permissionMode: 'safe-yolo' },
  },
  {
    argv: ['session', 'set-model', 'session_1', 'gpt-5'],
    pathLength: 2,
    actionId: 'session.model.set',
    input: { sessionId: 'session_1', modelId: 'gpt-5' },
  },
  {
    argv: ['session', 'set-model', 'session_1', 'gpt-5', '--provider-connection', 'native'],
    pathLength: 2,
    actionId: 'session.model.set',
    input: { sessionId: 'session_1', modelId: 'gpt-5', providerConnectionId: null },
  },
  {
    argv: ['session', 'set-model', 'session_1', 'gpt-5', '--provider-connection', 'connection_9'],
    pathLength: 2,
    actionId: 'session.model.set',
    input: { sessionId: 'session_1', modelId: 'gpt-5', providerConnectionId: 'connection_9' },
  },
  {
    argv: ['session', 'archive', 'session_1'],
    pathLength: 2,
    actionId: 'session.archive',
    input: { sessionId: 'session_1' },
  },
  {
    argv: ['session', 'unarchive', 'session_1'],
    pathLength: 2,
    actionId: 'session.unarchive',
    input: { sessionId: 'session_1' },
  },
  {
    argv: ['session', 'read', 'session_1'],
    pathLength: 2,
    actionId: 'session.read_state.set',
    input: { sessionId: 'session_1', state: 'read' },
  },
  {
    argv: ['session', 'read', 'session_1', '--unread'],
    pathLength: 2,
    actionId: 'session.read_state.set',
    input: { sessionId: 'session_1', state: 'unread' },
  },
  {
    argv: ['session', 'stop', 'session_1'],
    pathLength: 2,
    actionId: 'session.stop',
    input: { sessionId: 'session_1' },
  },
  {
    argv: ['stop', 'session_1'],
    pathLength: 1,
    actionId: 'session.stop',
    input: { sessionId: 'session_1' },
  },
  {
    // The incumbent wait applies 300s when none is supplied.
    argv: ['session', 'wait', 'session_1'],
    pathLength: 2,
    actionId: 'session.wait.idle',
    input: { sessionId: 'session_1', timeoutSeconds: 300 },
  },
  {
    argv: ['session', 'wait', 'session_1', '--timeout', '42'],
    pathLength: 2,
    actionId: 'session.wait.idle',
    input: { sessionId: 'session_1', timeoutSeconds: 42 },
  },
  {
    // The incumbent wait clamps rather than rejecting an over-long timeout.
    argv: ['session', 'wait', 'session_1', '--timeout', '99999'],
    pathLength: 2,
    actionId: 'session.wait.idle',
    input: { sessionId: 'session_1', timeoutSeconds: 3600 },
  },
];

describe('migrated one-shot Session leaves', () => {
  it.each(CORRESPONDENCE.map((row) => [row.argv.join(' '), row] as const))(
    'binds `happier %s` to its canonical Action input',
    async (_label, row) => {
      const executions = await run(row.argv, row.pathLength);
      expect(executions).toEqual([{ actionId: row.actionId, input: row.input }]);
      expect(process.exitCode, `${row.actionId} presentation`).not.toBe(2);
      process.exitCode = undefined;
    },
  );

  it('exposes each migrated leaf under exactly one canonical friendly path', () => {
    const byAction = new Map<string, string[]>();
    for (const command of listCompiledActionCliCommands()) {
      if (command.visibility !== 'canonical') continue;
      byAction.set(command.actionId, [...(byAction.get(command.actionId) ?? []), command.path.join(' ')]);
    }
    for (const actionId of new Set(CORRESPONDENCE.map((row) => row.actionId))) {
      expect(byAction.get(actionId), actionId).toHaveLength(1);
    }
  });

  it('constructs the read-state executor with the exact selected Home', async () => {
    const { executions, deps, createExecutorFn } = harness();
    await runCompiledActionCliCommand({
      command: commandFor(['session', 'read']),
      argv: ['session', 'read', 'session_1', '--unread', '--server-id', 'home-b'],
      deps: deps as never,
    });

    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'home-b',
      serverApiUrl: 'https://selected-home.example.test',
      serverIdentityId: 'selected-home-identity',
    }));
    expect(executions).toEqual([{
      actionId: 'session.read_state.set',
      input: { sessionId: 'session_1', state: 'unread' },
    }]);
    process.exitCode = undefined;
  });

  it('rejects an unknown flag or surplus positional before reading credentials', async () => {
    for (const argv of [
      ['session', 'archive', 'session_1', '--bogus'],
      ['session', 'set-title', 'session_1', 'Title', 'surplus'],
      ['session', 'set-permission-mode', 'session_1', 'nonsense'],
      ['session', 'wait', 'session_1', '--timeout', 'soon'],
    ]) {
      const { executions, deps } = harness();
      await runCompiledActionCliCommand({
        command: commandFor(argv.slice(0, 2)),
        argv,
        deps: deps as never,
      });
      expect(executions, argv.join(' ')).toEqual([]);
      expect(deps.readCredentialsFn, argv.join(' ')).not.toHaveBeenCalled();
      process.exitCode = 0;
    }
  });

  it('keeps the released JSON envelope kind for every spelling of a migrated leaf', async () => {
    // The derived kind is the command path, so a root alias would otherwise
    // publish `stop` where scripts have always read `session_stop`.
    for (const [path, kind] of [
      [['stop'], 'session_stop'],
      [['session', 'stop'], 'session_stop'],
      [['session', 'wait'], 'session_wait'],
      [['session', 'set-title'], 'session_set_title'],
    ] as const) {
      const command = commandFor(path);
      const presentation = await loadActionCliPresentation(command.actionId);
      expect(presentation?.envelopeKind?.(command), path.join(' ')).toBe(kind);
    }
  });
});
