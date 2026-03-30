import { describe, expect, it } from 'vitest';

import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';

import {
  createSystemTaskRegistry,
  executeSystemTask,
} from './index.js';

describe('executeSystemTask', () => {
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
});
