import { describe, expect, it } from 'vitest';

import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { getRelayAccessProvider, createBuiltinRelayAccessSelection as relaySelection } from '../relayAccess/index.js';
import { createExecutionRunnerFromKind } from './createExecutionRunnerFromKind.js';
import { createSystemTasksRunner } from './interactiveTaskKinds.js';
import { createRelayAccessDisableTaskKind } from './kinds/relayAccessKinds.js';
import type { RelayAccessConfig } from '../relayAccess/types.js';

import {
  createSystemTaskRegistry,
  executeSystemTask,
} from './index.js';

describe('executeSystemTask', () => {
  it.each(['generator', 'interactive'] as const)('preserves the native refusal code and retained configuration through a failed relay disable (%s)', async transport => {
    let persisted: RelayAccessConfig | null = relaySelection('tailscaleServe');
    const kind = createRelayAccessDisableTaskKind({ readConfig: async () => persisted,
      writeConfig: async ({ config }) => { persisted = config; }, getProvider: getRelayAccessProvider,
      createExecutionContext: () => ({ env: { HAPPIER_TAILSCALE_BIN: '/fixture/tailscale' }, upstreamUrl: null,
        runCommand: async request => ({ ...request, exitCode: 1, stdout: '',
          stderr: "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\n/private/alice token=secret-value" }) }),
    });
    const request = { taskId: 'refused-disable', kind: 'relay.access.disable.v1', params: { target: { kind: 'local' } } };
    const runner = createSystemTasksRunner({ kinds: { [request.kind]: kind } });
    if (transport === 'interactive') await runner.start(request);
    const result = transport === 'interactive' ? await runner.wait(request) : await executeSystemTask({ taskId: request.taskId,
      spec: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, kind: 'relay.access.disable.v1', params: { target: { kind: 'local' } } },
      registry: createSystemTaskRegistry([{ kind: 'relay.access.disable.v1', handler: createExecutionRunnerFromKind(kind) }]),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'tailscale_operator_authorization_refused', message: expect.stringContaining('sudo') } });
    expect(persisted).toEqual(relaySelection('tailscaleServe'));
    expect(JSON.stringify(result)).not.toContain('/private/alice');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('publishes callback progress while a handler is still awaiting work', async () => {
    const events: unknown[] = [];
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const run = executeSystemTask({
      spec: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, kind: 'system.acquisition.v1', params: {} },
      taskId: 'acquisition',
      registry: createSystemTaskRegistry([{
        kind: 'system.acquisition.v1',
        handler: async function* (_params, context) {
          if ('emit' in context && typeof context.emit === 'function') {
            context.emit({ type: 'progress', stepId: 'downloading', data: { receivedBytes: 12 } });
          }
          await pending;
          return { ready: true };
        },
      }]),
      emitEvent: (event) => events.push(event),
    });
    try {
      expect(events).toEqual([expect.objectContaining({ stepId: 'downloading', data: { receivedBytes: 12 } })]);
    } finally {
      finish?.();
      await run;
    }
  });

  it('rejects specs with the wrong protocol version', async () => {
    const events: unknown[] = [];

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 2,
        kind: 'system.noop.v1',
        params: {},
      },
      taskId: 'task-invalid-version',
      registry: createSystemTaskRegistry([]),
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([]);
    expect(result).toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-invalid-version',
      ok: false,
      error: {
        code: 'invalid_spec',
        message: expect.any(String),
      },
    });
  });

  it('rejects unknown task kinds with a stable error code', async () => {
    const result = await executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.missing.v1',
        params: {},
      },
      taskId: 'task-unknown-kind',
      registry: createSystemTaskRegistry([]),
      emitEvent() {},
    });

    expect(result).toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-unknown-kind',
      ok: false,
      error: {
        code: 'unknown_kind',
        message: expect.any(String),
      },
    });
  });

  it('rejects handlers that yield non-JSON-safe event payloads', async () => {
    const registry = createSystemTaskRegistry([
      {
        kind: 'system.invalid-event.v1',
        handler: async function* () {
          yield {
            type: 'progress',
            data: {
              invalid: () => 'nope',
            },
          };
          return null;
        },
      },
    ]);

    const result = await executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.invalid-event.v1',
        params: null,
      },
      taskId: 'task-invalid-event',
      registry,
      emitEvent() {},
    });

    expect(result).toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-invalid-event',
      ok: false,
      error: {
        code: 'invalid_event',
        message: expect.any(String),
      },
    });
  });

  it('redacts sensitive keys from emitted event data', async () => {
    const emitted: any[] = [];
    const registry = createSystemTaskRegistry([
      {
        kind: 'system.event-redaction.v1',
        handler: async function* () {
          yield {
            type: 'progress',
            data: {
              ok: true,
              token: 'secret-token',
              password: 'pw',
              nested: {
                safe: 'value',
                identityFile: '/Users/example/.ssh/id_ed25519',
              },
            },
          };
          return null;
        },
      },
    ]);

    const result = await executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.event-redaction.v1',
        params: null,
      },
      taskId: 'task-redaction',
      registry,
      emitEvent(event) {
        emitted.push(event);
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toEqual({
      ok: true,
      nested: {
        safe: 'value',
      },
    });
    expect(result.ok).toBe(true);
  });

  it('does not allow handlers to override task identity fields on emitted events', async () => {
    const emitted: any[] = [];
    const registry = createSystemTaskRegistry([
      {
        kind: 'system.override-attempt.v1',
        handler: async function* () {
          yield {
            taskId: 'evil-task-id',
            type: 'progress',
            message: 'attempt override',
          };
          return null;
        },
      },
    ]);

    const result = await executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.override-attempt.v1',
        params: null,
      },
      taskId: 'task-safe',
      registry,
      emitEvent(event) {
        emitted.push(event);
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(expect.objectContaining({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-safe',
      type: 'progress',
    }));
    expect(result).toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-safe',
      ok: true,
      data: null,
    });
  });

  it('rejects handlers that return non-JSON-safe result payloads', async () => {
    const registry = createSystemTaskRegistry([
      {
        kind: 'system.invalid-result.v1',
        handler: async function* () {
          return {
            invalid: () => 'nope',
          };
        },
      },
    ]);

    const result = await executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.invalid-result.v1',
        params: null,
      },
      taskId: 'task-invalid-result',
      registry,
      emitEvent() {},
    });

    expect(result).toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-invalid-result',
      ok: false,
      error: {
        code: 'invalid_result',
        message: expect.any(String),
      },
    });
  });

  it('returns a cancelled result when aborted during execution', async () => {
    const controller = new AbortController();
    const emittedEventTypes: string[] = [];
    const registry = createSystemTaskRegistry([
      {
        kind: 'system.long-running.v1',
        handler: async function* () {
          yield {
            type: 'progress',
            message: 'running',
          };
          return {
            unexpected: true,
          };
        },
      },
    ]);

    const result = await executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.long-running.v1',
        params: null,
      },
      taskId: 'task-cancelled',
      registry,
      signal: controller.signal,
      emitEvent(event) {
        emittedEventTypes.push(event.type);
        controller.abort();
      },
    });

    expect(emittedEventTypes).toEqual(['progress']);
    expect(result).toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-cancelled',
      ok: false,
      error: {
        code: 'cancelled',
        message: expect.any(String),
      },
    });
  });

  it('preserves a completed result when the handler rejects a late cancellation after its boundary', async () => {
    const controller = new AbortController();
    let releaseHandler!: () => void;
    const handlerMayFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const registry = createSystemTaskRegistry([
      {
        kind: 'system.commit-boundary.v1',
        handler: async function* () {
          yield {
            type: 'progress',
            message: 'committing',
          };
          await handlerMayFinish;
          return { committed: true };
        },
      },
    ]);

    const resultPromise = executeSystemTask({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.commit-boundary.v1',
        params: null,
      },
      taskId: 'task-committed',
      registry,
      signal: controller.signal,
      emitEvent() {
        queueMicrotask(() => {
          controller.abort();
          releaseHandler();
        });
      },
    });

    await expect(resultPromise).resolves.toEqual({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-committed',
      ok: true,
      data: { committed: true },
    });
  });
});
