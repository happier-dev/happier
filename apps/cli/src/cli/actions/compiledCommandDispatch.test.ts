import { describe, expect, it, vi } from 'vitest';

import { getActionSpec } from '@happier-dev/protocol';
import { encodeTerminalStreamBytes, TerminalStreamReadOkResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

import { compileActionCliCommands, findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { renderActionCliCommandHelp } from './commandHelp';
import { runCompiledActionCliCommand } from './executeCommand';

type Execution = Readonly<{ actionId: string; input: unknown }>;

function runState(runId: string, status: 'running' | 'succeeded') {
  return {
    runId,
    callId: `call_${runId}`,
    sidechainId: `sidechain_${runId}`,
    intent: 'review' as const,
    backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
    permissionMode: 'workspace_write',
    retentionPolicy: 'ephemeral' as const,
    runClass: 'bounded' as const,
    ioMode: 'request_response' as const,
    status,
    startedAtMs: 1,
  };
}

function commandFor(path: readonly string[]) {
  const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
  if (!command || command.path.join(' ') !== path.join(' ')) {
    throw new Error(`No compiled command for "${path.join(' ')}"`);
  }
  return command;
}

function harness() {
  const executions: Execution[] = [];
  const deps = {
    readCredentialsFn: vi.fn(async () => ({ token: 'hap_v1_test' } as never)),
    createExecutorFn: () => ({
      resolveSessionTarget: async (sessionId: string) => ({ ok: true as const, sessionId }),
      execute: async (actionId: string, input: unknown) => {
        executions.push({ actionId, input });
        if (actionId === 'execution.run.list') {
          return { ok: true as const, result: { runs: [] } };
        }
        if (actionId === 'execution.run.wait') {
          return {
            ok: true as const,
            result: {
              ok: true,
              status: 'running',
              disposition: 'observation_timeout',
              runId: 'run_1',
              timeoutMs: 7_000,
              observedAtMs: 7_000,
              deadlineAtMs: 7_000,
            },
          };
        }
        if (actionId === 'execution.run.get') {
          return { ok: true as const, result: { run: runState('run_1', 'running') } };
        }
        if (actionId === 'execution.run.stop') {
          return { ok: true as const, result: { ok: true } };
        }
        if (actionId === 'execution.run.stream.start') {
          return { ok: true as const, result: { streamId: 'stream_1' } };
        }
        if (actionId === 'execution.run.stream.read') {
          return { ok: true as const, result: { streamId: 'stream_1', events: [], nextCursor: 0, done: false } };
        }
        if (actionId === 'execution.run.stream.cancel') {
          return { ok: true as const, result: { ok: true } };
        }
        if (actionId === 'execution.run.start') {
          return { ok: true as const, result: { runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' } };
        }
        return { ok: true as const, result: { ok: true, sessionId: 'session_1', localId: 'local_1', waited: false } };
      },
    }),
  };
  return { executions, deps };
}

async function run(path: readonly string[], rest: readonly string[]) {
  const { executions, deps } = harness();
  await runCompiledActionCliCommand({
    command: commandFor(path),
    argv: [...path, ...rest],
    deps: deps as never,
  });
  return executions;
}

/** The host-stamped retry identity differs per invocation by design. */
function withoutLocalId(execution: Execution): Execution {
  const { localId: _localId, ...input } = execution.input as Record<string, unknown>;
  return { actionId: execution.actionId, input };
}

describe('compiled Action CLI command dispatch', () => {
  it('fails a provider lifecycle command before credential lookup when --server-id is absent', async () => {
    const command = commandFor(['identity', 'providers', 'list']);
    const readCredentialsFn = vi.fn(async () => ({ token: 'ambient-token' } as never));
    const output = captureConsoleText();
    try {
      await runCompiledActionCliCommand({
        command,
        argv: [...command.path],
        deps: { readCredentialsFn, createExecutorFn: vi.fn() } as never,
      });
    } finally {
      output.restore();
    }

    expect(output.text()).toContain('--server-id');
    expect(readCredentialsFn).not.toHaveBeenCalled();
    process.exitCode = undefined;
  });

  it('binds a provider lifecycle command to the selected Home endpoint and observed server identity', async () => {
    const command = commandFor(['identity', 'providers', 'list']);
    const execute = vi.fn(async () => ({ ok: true as const, result: { items: [], unreadableCount: 0 } }));
    const createExecutorFn = vi.fn(() => ({ resolveSessionTarget: vi.fn(), execute }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => ({ token: 'selected-home-token' }));
    const getServerProfileFn = vi.fn(async () => ({
      id: 'selected-home-profile',
      name: 'Selected Home',
      serverUrl: 'https://selected-home.example.test',
      localServerUrl: 'http://127.0.0.1:43100',
      webappUrl: 'https://app.selected-home.example.test',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: {
        v: 1 as const,
        homeServerIdentityId: 'selected-home-server-identity',
        canonicalServerUrl: 'https://selected-home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://selected-home.example.test' }],
      },
    }));
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledActionCliCommand({
        command,
        argv: [...command.path, '--server-id', 'selected-home-profile', '--json'],
        deps: {
          readCredentialsFn,
          readCredentialsForServerIdFn,
          getServerProfileFn,
          createExecutorFn,
        } as never,
      });

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'identity_providers_list',
        data: { items: [], unreadableCount: 0 },
      });
    } finally {
      output.restore();
    }

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('selected-home-profile');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'selected-home-token' },
      serverId: 'selected-home-profile',
      serverApiUrl: 'http://127.0.0.1:43100',
      serverIdentityId: 'selected-home-server-identity',
    }));
    expect(execute).toHaveBeenCalledWith(
      'identity.providers.list',
      { owner: { kind: 'home' } },
      expect.objectContaining({
        surface: 'cli',
        actionRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      }),
    );
  });

  it('fails a Team identity command before credential lookup when --server-id is absent', async () => {
    const command = commandFor(['teams', 'identity', 'connections', 'list']);
    const readCredentialsFn = vi.fn(async () => ({ token: 'ambient-token' } as never));
    const output = captureConsoleText();
    try {
      await runCompiledActionCliCommand({
        command,
        argv: [...command.path, '--v', '1', '--team-id', 'team_1'],
        deps: {
          readCredentialsFn,
          createExecutorFn: vi.fn(),
        } as never,
      });
    } finally {
      output.restore();
    }

    expect(output.text()).toContain('--server-id');
    expect(readCredentialsFn).not.toHaveBeenCalled();
    process.exitCode = undefined;
  });

  it('binds a Team identity command to the selected Home endpoint and observed server identity', async () => {
    const command = commandFor(['teams', 'identity', 'connections', 'list']);
    const createExecutorFn = vi.fn(() => ({
      resolveSessionTarget: vi.fn(),
      execute: vi.fn(async () => ({ ok: true as const, result: { connections: [] } })),
    }));

    const output = captureConsoleJsonOutput();
    try {
      await runCompiledActionCliCommand({
        command,
        argv: [...command.path, '--v', '1', '--team-id', 'team_1', '--server-id', 'home-b', '--json'],
        deps: {
          readCredentialsFn: vi.fn(async () => null),
          readCredentialsForServerIdFn: vi.fn(async () => ({ token: 'home-b-token' } as never)),
          getServerProfileFn: vi.fn(async () => ({
            id: 'home-b',
            serverUrl: 'https://home-b.example.test',
            localServerUrl: null,
            homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { homeServerIdentityId: 'server-identity-b' },
          } as never)),
          createServerFeaturesSnapshotStoreFn: vi.fn(() => ({ refresh: vi.fn(async () => ({})) } as never)),
          createExecutorFn,
        },
      });
    } finally {
      output.restore();
    }

    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'home-b',
      serverApiUrl: 'https://home-b.example.test',
      serverIdentityId: 'server-identity-b',
      credentials: expect.objectContaining({ token: 'home-b-token' }),
    }));
  });

  it.each([
    {
      path: ['credentials', 'list'],
      argv: ['--team-id', 'team_1'],
      actionId: 'teams.credentials.list',
      input: { teamId: 'team_1', filter: 'all', limit: 50 },
    },
    {
      path: ['credentials', 'test'],
      argv: ['--team-id', 'team_1', '--resource-id', 'resource_1'],
      actionId: 'teams.credentials.test',
      input: { teamId: 'team_1', resourceId: 'resource_1' },
    },
    {
      path: ['credentials', 'activity', 'list'],
      argv: ['--resource-id', 'resource_1'],
      actionId: 'teams.credentials.activity.list',
      input: { resourceId: 'resource_1', limit: 50 },
    },
    {
      path: ['credentials', 'usage', 'query'],
      argv: ['--resource-id', 'resource_1', '--start-ms', '10', '--end-ms', '20'],
      actionId: 'teams.credentials.usage.query',
      input: { resourceId: 'resource_1', startMs: 10, endMs: 20, granularity: 'day', costMode: 'auto' },
    },
    {
      path: ['credentials', 'external-keys', 'list'],
      argv: ['--resource-id', 'resource_1'],
      actionId: 'teams.credentials.externalKeys.list',
      input: { resourceId: 'resource_1' },
    },
    {
      path: ['secrets', 'shared', 'list'],
      argv: [],
      actionId: 'secrets.shared.list',
      input: {},
    },
  ])('executes $actionId through the selected Home and canonical Action executor', async ({
    path,
    argv,
    actionId,
    input,
  }) => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { items: [] } }));
    const createExecutorFn = vi.fn(() => ({ resolveSessionTarget: vi.fn(), execute }));
    const readCredentialsFn = vi.fn(async () => ({ token: 'ambient-token' } as never));
    const readCredentialsForServerIdFn = vi.fn(async () => ({ token: 'selected-home-token' } as never));

    const output = captureConsoleJsonOutput();
    try {
      await runCompiledActionCliCommand({
        command: commandFor(path),
        argv: [...path, ...argv, '--server-id', 'home-b', '--json'],
        deps: {
          readCredentialsFn,
          readCredentialsForServerIdFn,
          getServerProfileFn: vi.fn(async () => ({
            id: 'home-b',
            serverUrl: 'https://home-b.example.test',
            localServerUrl: null,
            homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { homeServerIdentityId: 'server-identity-b' },
          } as never)),
          createServerFeaturesSnapshotStoreFn: vi.fn(() => ({ refresh: vi.fn(async () => ({})) } as never)),
          createExecutorFn,
        },
      });
    } finally {
      output.restore();
    }

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('home-b');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'home-b',
      serverApiUrl: 'https://home-b.example.test',
      serverIdentityId: 'server-identity-b',
    }));
    expect(execute).toHaveBeenCalledWith(
      actionId,
      input,
      expect.objectContaining({ surface: 'cli' }),
    );
    process.exitCode = undefined;
  });

  it('derives resource-test help from the canonical Action schema', () => {
    const help = renderActionCliCommandHelp(commandFor(['credentials', 'test']));
    expect(help).toContain('happier credentials test');
    expect(help).toContain('--team-id <value>');
    expect(help).toContain('--resource-id <value>');
    expect(help).toContain('--server-id <serverId>');
    expect(help).toContain('Canonical Action: teams.credentials.test');
  });

  it('refuses a selected Home whose cryptographic server identity is not established', async () => {
    const command = commandFor(['teams', 'directory', 'sources', 'list']);
    const createExecutorFn = vi.fn();
    const output = captureConsoleText();
    try {
      await runCompiledActionCliCommand({
        command,
        argv: [...command.path, '--v', '1', '--team-id', 'team_1', '--server-id', 'legacy-home'],
        deps: {
          readCredentialsFn: vi.fn(async () => null),
          readCredentialsForServerIdFn: vi.fn(async () => ({ token: 'legacy-token' } as never)),
          getServerProfileFn: vi.fn(async () => ({
            id: 'legacy-home',
            serverUrl: 'https://legacy.example.test',
            localServerUrl: null,
            homeConnectionDescriptorAuthority: 'legacy',
            homeConnectionDescriptor: null,
          } as never)),
          createExecutorFn,
        } as never,
      });
    } finally {
      output.restore();
    }

    expect(output.text()).toContain('server identity');
    expect(createExecutorFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('declares one canonical and two alias spellings of the same send Action', () => {
    const spellings = listCompiledActionCliCommands()
      .filter((command) => command.actionId === 'session.message.send')
      .map((command) => `${command.path.join(' ')}:${command.visibility}`);
    expect(spellings).toEqual([
      'session send:canonical',
      'send:alias',
      'session run send:alias',
    ]);
  });

  it('sends without a recipient when no run is named, from every spelling', async () => {
    const nested = await run(['session', 'send'], ['session_1', 'Continue.']);
    const root = await run(['send'], ['session_1', 'Continue.']);
    expect(nested.map(withoutLocalId)).toEqual(root.map(withoutLocalId));
    expect(nested).toHaveLength(1);
    expect(nested[0]!.actionId).toBe('session.message.send');
    expect(nested[0]!.input).toMatchObject({ sessionId: 'session_1', message: 'Continue.' });
    expect(nested[0]!.input).not.toHaveProperty('recipient');
  });

  it('overlays friendly flags onto canonical whole-input JSON and rejects a duplicate source', async () => {
    const partialBase = await run(['session', 'send'], [
      '--input-json', '{"sessionId":"session_1"}', '--message', 'Hello',
    ]);
    expect(partialBase).toHaveLength(1);
    expect(partialBase[0]!.input).toMatchObject({ sessionId: 'session_1', message: 'Hello' });

    const completeBase = await run(['session', 'send'], [
      '--input-json', '{"sessionId":"session_1","message":"Hello"}', '--run', 'run1',
    ]);
    expect(completeBase).toHaveLength(1);
    expect(completeBase[0]!.input).toMatchObject({
      sessionId: 'session_1',
      message: 'Hello',
      recipient: { kind: 'execution_run', runId: 'run1' },
    });

    // A canonical field the binder normalizes out of a friendly flag is still
    // one source: supplying both is rejected, never silently resolved.
    const output = captureConsoleText();
    let duplicate: readonly Execution[];
    try {
      duplicate = await run(['session', 'send'], [
        '--input-json',
        '{"sessionId":"session_1","message":"Hello","recipient":{"kind":"execution_run","runId":"run0"}}',
        '--run', 'run1',
      ]);
    } finally {
      output.restore();
    }
    expect(duplicate).toEqual([]);
    expect(output.text()).toContain('recipient');
    process.exitCode = undefined;
  });

  it('binds --run and the compatibility positional to the same strict recipient', async () => {
    const flagged = await run(['session', 'send'], ['session_1', 'Focus.', '--run', 'run_9']);
    const compatibility = await run(['session', 'run', 'send'], ['session_1', 'run_9', 'Focus.']);
    expect(flagged[0]!.input).toMatchObject({
      sessionId: 'session_1',
      message: 'Focus.',
      recipient: { kind: 'execution_run', runId: 'run_9' },
    });
    expect(withoutLocalId(compatibility[0]!)).toEqual(withoutLocalId(flagged[0]!));
  });

  it('preserves the exact message bytes, including flag-looking literals after --', async () => {
    const literal = ' leading and trailing \n"quoted" \\ 🙂 $(touch sentinel) ; & | < > ';
    const executions = await run(['session', 'send'], ['session_1', literal]);
    expect((executions[0]!.input as { message: string }).message).toBe(literal);

    const flagLike = await run(['session', 'send'], ['session_1', '--', '--not-a-flag']);
    expect((flagLike[0]!.input as { message: string }).message).toBe('--not-a-flag');
  });

  it('keeps --help and --json literal after the argv terminator', async () => {
    const helpLiteral = await run(['session', 'send'], ['session_1', '--', '--help']);
    expect((helpLiteral[0]!.input as { message: string }).message).toBe('--help');

    const jsonLiteral = await run(['session', 'send'], ['session_1', '--', '--json']);
    expect((jsonLiteral[0]!.input as { message: string }).message).toBe('--json');
  });

  it('applies the established caller shorthands through the Action binder', async () => {
    const executions = await run(['session', 'send'], [
      'session_1', 'Go.',
      '--permission-mode', 'plan',
      '--model', 'default',
      '--timeout', '42',
      '--wait',
      '--local-id', 'retry_1',
    ]);
    expect(executions[0]!.input).toMatchObject({
      permissionModeOverride: 'plan',
      modelOverride: null,
      timeoutSeconds: 42,
      wait: true,
      localId: 'retry_1',
    });
  });

  it('keeps whole-input JSON canonical so nested recipient and retry identity survive unchanged', async () => {
    const canonicalInput = {
      sessionId: 'session_1',
      message: 'Go.',
      recipient: { kind: 'execution_run', runId: 'run_9' },
      localId: 'retry_from_json',
      wait: true,
      timeoutSeconds: 19,
    };
    const executions = await run(['session', 'send'], [
      '--input-json',
      JSON.stringify(canonicalInput),
    ]);
    expect(executions).toEqual([{ actionId: 'session.message.send', input: canonicalInput }]);
  });

  it('retains a durable local id when the caller supplied none', async () => {
    const executions = await run(['session', 'send'], ['session_1', 'Go.']);
    expect(typeof (executions[0]!.input as { localId: unknown }).localId).toBe('string');
    expect((executions[0]!.input as { localId: string }).localId.length).toBeGreaterThan(0);
  });

  it('applies the incumbent default timeout when none is supplied', async () => {
    const executions = await run(['session', 'send'], ['session_1', 'Go.']);
    expect((executions[0]!.input as { timeoutSeconds: number }).timeoutSeconds).toBe(300);
  });

  it('starts an execution run from friendly scalar fields through the canonical Action', async () => {
    const executions = await run(['session', 'run', 'start'], [
      'session_1',
      '--intent', 'delegate',
      '--agent', 'agent:happier.agent.codex/codex',
      '--instructions', 'Investigate the failure.',
    ]);
    expect(executions).toEqual([{
      actionId: 'execution.run.start',
      input: {
        sessionId: 'session_1',
        intent: 'delegate',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        instructions: 'Investigate the failure.',
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    }]);
  });

  it('starts and observes detached runs on the explicit Machine without resolving a Session', async () => {
    for (const operation of ['start', 'get', 'wait', 'stop'] as const) {
      const { executions, deps } = harness();
      const resolveSessionTarget = vi.fn(async (sessionId: string) => ({ ok: true as const, sessionId }));
      const createExecutor = deps.createExecutorFn;
      const execute = vi.fn(async (actionId: string, input: unknown, _context: unknown) => createExecutor().execute(actionId, input));
      const createExecutorFn = vi.fn(() => ({ ...createExecutor(), execute, resolveSessionTarget }));
      const path = ['session', 'run', operation];
      await runCompiledActionCliCommand({
        command: commandFor(path),
        argv: [...path, '--machine', 'machine_7', ...(operation === 'start'
          ? ['--cwd', '/repo', '--intent', 'scm_commit_message', '--agent', 'codex']
          : ['--run-id', 'run_1']), '--json'],
        deps: { ...deps, createExecutorFn } as never,
      });
      expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine_7' }));
      expect(resolveSessionTarget).not.toHaveBeenCalled();
      expect(executions).toHaveLength(1);
      expect(executions[0]!.actionId).toBe(`execution.run.${operation}`);
      expect(execute).toHaveBeenCalledWith(`execution.run.${operation}`, expect.anything(), expect.objectContaining({ defaultSessionId: null }));
      expect(executions[0]!.input).not.toHaveProperty('machineId');
      if (operation === 'start') expect(executions[0]!.input).toMatchObject({ sessionId: null, cwd: '/repo', intent: 'scm_commit_message' });
      expect(renderActionCliCommandHelp(commandFor(path))).toContain('--machine');
    }
  });

  it('preserves explicit null Session in canonical Run input even with an explicit Machine', async () => {
    const executions = await run(['session', 'run', 'get'], [
      '--input-json', '{"sessionId":null,"runId":"run_1"}', '--machine-id', 'machine_7', '--json',
    ]);
    expect(executions).toEqual([{ actionId: 'execution.run.get', input: { sessionId: null, runId: 'run_1' } }]);
  });

  it('keeps an explicitly authored canonical Session when cwd is supplied as a friendly overlay', async () => {
    const canonicalInput = {
      sessionId: 'session_1', intent: 'delegate',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      permissionMode: 'workspace_write', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    };
    const executions = await run(['session', 'run', 'start'], [
      '--input-json', JSON.stringify(canonicalInput),
      '--cwd', '/repo', '--machine', 'machine_7', '--json',
    ]);
    expect(executions).toEqual([{ actionId: 'execution.run.start', input: { ...canonicalInput, cwd: '/repo' } }]);
  });

  it('rejects conflicting Machine spellings before authenticating or dispatching', async () => {
    const { executions, deps } = harness();
    await runCompiledActionCliCommand({ command: commandFor(['session', 'run', 'get']),
      argv: ['session', 'run', 'get', '--machine', 'machine_7', '--machine-id', 'machine_8', '--run-id', 'run_1'],
      deps: deps as never });
    expect(executions).toEqual([]);
    expect(deps.readCredentialsFn).not.toHaveBeenCalled();
    process.exitCode = 0;
  });

  it('routes every execution-run leaf through the one compiled Action dispatcher', async () => {
    const cases = [
      [['session', 'run', 'list'], ['session_1'], 'execution.run.list'],
      [['session', 'run', 'get'], ['session_1', 'run_1'], 'execution.run.get'],
      [['session', 'run', 'stop'], ['session_1', 'run_1'], 'execution.run.stop'],
      [['session', 'run', 'wait'], ['session_1', 'run_1', '--timeout', '7'], 'execution.run.wait'],
      [['session', 'run', 'stream-start'], ['session_1', 'run_1', 'Continue.', '--resume'], 'execution.run.stream.start'],
      [['session', 'run', 'stream-read'], ['session_1', 'run_1', 'stream_1', '--cursor', '0'], 'execution.run.stream.read'],
      [['session', 'run', 'stream-cancel'], ['session_1', 'run_1', 'stream_1'], 'execution.run.stream.cancel'],
    ] as const;
    for (const [path, rest, actionId] of cases) {
      const executions = await run(path, rest);
      expect(executions, path.join(' ')).toHaveLength(1);
      expect(executions[0]!.actionId).toBe(actionId);
    }
  });

  it('rejects an unknown flag, a duplicate source and a surplus positional before authenticating', async () => {
    for (const rest of [
      ['session_1', 'Go.', '--bogus'],
      ['session_1', 'Go.', '--message', 'other'],
      ['session_1', 'Go.', 'surplus'],
      ['session_1', 'Go.', '--run', 'run_9', '--input-json', '{"run":"run_2"}'],
      ['session_1', 'Go.', '--run', '--wait'],
    ]) {
      const { executions, deps } = harness();
      await runCompiledActionCliCommand({
        command: commandFor(['session', 'send']),
        argv: ['session', 'send', ...rest],
        deps: deps as never,
      });
      expect(executions).toEqual([]);
      expect(deps.readCredentialsFn).not.toHaveBeenCalled();
      process.exitCode = 0;
    }
  });

  it('rejects an invalid permission mode at the caller boundary', async () => {
    const { executions, deps } = harness();
    await runCompiledActionCliCommand({
      command: commandFor(['session', 'send']),
      argv: ['session', 'send', 'session_1', 'Go.', '--permission-mode', 'nonsense'],
      deps: deps as never,
    });
    expect(executions).toEqual([]);
    process.exitCode = 0;
  });

  it('invokes the canonical machines.list Action with the friendly page bound', async () => {
    const { executions, deps } = harness();
    await runCompiledActionCliCommand({
      command: commandFor(['machines', 'list']),
      argv: ['machines', 'list'],
      deps: deps as never,
    });
    expect(executions).toEqual([{ actionId: 'machines.list', input: { limit: 200 } }]);
  });

  it('keeps --machine-id physical routing out of Action input', async () => {
    const { executions, deps } = harness();
    await runCompiledActionCliCommand({
      command: commandFor(['session', 'send']),
      argv: ['session', 'send', 'session_1', 'Go.', '--machine-id', 'machine_7'],
      deps: deps as never,
    });
    expect(executions[0]!.input).not.toHaveProperty('machineId');
    expect(renderActionCliCommandHelp(commandFor(['session', 'send'])))
      .toContain('--machine-id <machineId>');
  });

  it('never lets one spelling mean both physical routing and Action input', () => {
    // `--machine-id` is the CLI's routing flag. An Action that declares its own
    // `machineId` field owns the spelling instead; the declaration decides, so
    // no runtime precedence rule has to.
    for (const command of listCompiledActionCliCommands()) {
      const declaresMachineId = command.fields.some((field) => field.path === 'machineId');
      expect(command.routesByTransportMachineId).toBe(!declaresMachineId);
    }
  });

  it('offers no friendly path for a cli-surfaced Action that declares none', () => {
    const spec = getActionSpec('action.options.resolve');
    expect(spec.surfaces.cli).toBe(true);
    expect(spec.cli).toBeUndefined();
    expect(listCompiledActionCliCommands().some((command) => command.actionId === 'action.options.resolve')).toBe(false);
  });

  it('does not turn a successful JSON Action into a failed/replayed invocation when its human presenter rejects the payload', async () => {
    const output = captureConsoleJsonOutput();
    const execute = vi.fn(async () => ({ ok: true as const, result: { preserved: 'canonical-result' } }));
    try {
      await runCompiledActionCliCommand({
        command: commandFor(['session', 'status']),
        argv: ['session', 'status', 'session_1', '--json'],
        deps: {
          readCredentialsFn: async () => ({ token: 'hap_v1_test' } as never),
          createExecutorFn: () => ({
            resolveSessionTarget: async () => ({ ok: true as const, sessionId: 'session_1' }),
            execute,
          }),
        } as never,
      });

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'session_status',
        data: { preserved: 'canonical-result' },
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('reports a secret-free presentation failure after a successful human Action without replaying it', async () => {
    const output = captureConsoleText();
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { session: 'presenter-secret-must-not-escape' },
    }));
    try {
      await runCompiledActionCliCommand({
        command: commandFor(['session', 'status']),
        argv: ['session', 'status', 'session_1'],
        deps: {
          readCredentialsFn: async () => ({ token: 'hap_v1_test' } as never),
          createExecutorFn: () => ({
            resolveSessionTarget: async () => ({ ok: true as const, sessionId: 'session_1' }),
            execute,
          }),
        } as never,
      });

      expect(output.text()).toContain('presentation_failed');
      expect(output.text()).toContain('Action completed');
      expect(output.text()).not.toContain('presenter-secret-must-not-escape');
      expect(process.exitCode).toBe(2);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('resolves the longest declared path so a nested alias is not shadowed by its prefix', () => {
    const commands = compileActionCliCommands();
    expect(findCompiledActionCliCommand(['session', 'run', 'send', 'a', 'b', 'c'], commands)?.path.join(' '))
      .toBe('session run send');
    expect(findCompiledActionCliCommand(['session', 'history', 'a'], commands)).toBeNull();
  });

  describe('Project execution output presentation', () => {
    const input = {
      serverId: 'home_1', machineId: 'machine_1', operationId: 'operation_1',
      byteOffset: 0, controlCursor: 2, ackedByteOffset: 0, creditBytes: 64, maxBytes: 64,
    };

    function retainedOutput() {
      // Includes invalid UTF-8, NUL, terminal controls and a character split
      // across frames: a text round-trip would corrupt the permitted bytes.
      const bytes = Buffer.from([0x00, 0xff, 0xc3, 0xa9, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x0d, 0x0a]);
      const output = TerminalStreamReadOkResponseSchema.parse({
        ok: true, terminalId: 'terminal_1',
        frames: [
          { t: 'gap', terminalId: 'terminal_1', droppedBeforeByteOffset: 7,
            nextAvailableByteOffset: 7, reason: 'ring_overflow' },
          ...[bytes.subarray(0, 3), bytes.subarray(3)].map((chunk, index) => ({
            t: 'bytes', terminalId: 'terminal_1', seq: index,
            byteOffset: index === 0 ? 7 : 10, byteLength: chunk.length,
            encoding: 'base64', data: encodeTerminalStreamBytes(chunk),
          })),
          { t: 'exit', terminalId: 'terminal_1', byteOffset: 18, exitCode: 1, signal: null },
        ],
        nextByteOffset: 18, availableByteOffset: 18, droppedBeforeByteOffset: 7,
        nextControlCursor: 4, done: true,
      });
      return { bytes, output };
    }

    it.each(['read', 'copy'] as const)('prints exact binary Project output for human %s and reports gaps on stderr', async (operation) => {
      const { bytes, output } = retainedOutput();
      const path = ['projects', 'execution', 'output', operation];
      const { deps } = harness();
      const execute = vi.fn(async () => ({ ok: true as const,
        result: operation === 'read' ? output : { kind: 'bytes' as const, output } }));
      const chunks: Buffer[] = [];
      // Vitest virtualizes console.error before it reaches stderr.write.
      const diagnostics = captureConsoleText();
      // The shared text capture intentionally decodes UTF-8. Capture this OS
      // stream boundary as bytes to prove binary output survives unchanged.
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
        if (typeof encoding === 'function') encoding(null);
        else callback?.(null);
        return true;
      }) as typeof process.stdout.write);
      try {
        await runCompiledActionCliCommand({
          command: commandFor(path), argv: [...path, '--input-json', JSON.stringify(input)],
          deps: { ...deps, createExecutorFn: () => ({ resolveSessionTarget: vi.fn(), execute }) },
        });

        expect(Buffer.concat(chunks)).toEqual(bytes);
        expect(diagnostics.text()).toContain('ring_overflow');
        expect(diagnostics.text()).toContain('7');
        expect(process.exitCode ?? 0).toBe(0);
        expect(execute).toHaveBeenCalledWith(`projects.execution.output.${operation}`, input, expect.anything());
      } finally {
        stdout.mockRestore();
        diagnostics.restore();
        process.exitCode = undefined;
      }
    });

    it.each(['read', 'copy'] as const)('preserves canonical Project output frames, cursors and envelope for JSON %s', async (operation) => {
      const { output } = retainedOutput();
      const path = ['projects', 'execution', 'output', operation];
      const { deps } = harness();
      const result = operation === 'read' ? output : { kind: 'bytes' as const, output };
      const execute = vi.fn(async () => ({ ok: true as const, result }));
      const diagnostics = captureConsoleText();
      const stdout = captureConsoleJsonOutput();
      try {
        await runCompiledActionCliCommand({
          command: commandFor(path), argv: [...path, '--input-json', JSON.stringify(input), '--json'],
          deps: { ...deps, createExecutorFn: () => ({ resolveSessionTarget: vi.fn(), execute }) },
        });

        const { ok: _ok, ...readPayload } = output;
        expect(stdout.json()).toEqual({ v: 1, ok: true, kind: `projects_execution_output_${operation}`,
          data: operation === 'read' ? readPayload : result });
        expect(diagnostics.text()).toBe('');
        expect(execute).toHaveBeenCalledWith(`projects.execution.output.${operation}`, input, expect.anything());
      } finally {
        stdout.restore();
        diagnostics.restore();
        process.exitCode = undefined;
      }
    });
  });
});
