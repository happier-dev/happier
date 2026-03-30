import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type SafeParseSchema = {
  safeParse: (input: unknown) => { success: true; data: unknown } | { success: false };
};

function readSchema(name: string): SafeParseSchema {
  const candidate = (protocol as Record<string, unknown>)[name];
  expect(candidate).toBeDefined();
  expect(typeof candidate).toBe('object');
  expect(typeof (candidate as { safeParse?: unknown }).safeParse).toBe('function');
  return candidate as SafeParseSchema;
}

describe('systemTasks protocol exports', () => {
  it('exports the protocol version and schemas', () => {
    expect((protocol as Record<string, unknown>).SYSTEM_TASK_PROTOCOL_VERSION).toBe(1);
    readSchema('SystemTaskSpecSchema');
    readSchema('SystemTaskEventSchema');
    readSchema('SystemTaskResultSchema');
  });
});

describe('SystemTaskSpecSchema', () => {
  it('accepts a wire-level spec with nested JSON params', () => {
    const parsed = readSchema('SystemTaskSpecSchema').safeParse({
      protocolVersion: 1,
      kind: 'setup.thisComputer.v1',
      params: {
        dryRun: true,
        retries: 2,
        steps: ['install', 'pair'],
        metadata: {
          relayUrl: 'https://api.happier.dev',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a spec with the wrong protocol version', () => {
    const parsed = readSchema('SystemTaskSpecSchema').safeParse({
      protocolVersion: 2,
      kind: 'setup.thisComputer.v1',
      params: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-JSON params', () => {
    const parsed = readSchema('SystemTaskSpecSchema').safeParse({
      protocolVersion: 1,
      kind: 'setup.thisComputer.v1',
      params: {
        startedAt: new Date('2026-03-29T00:00:00.000Z'),
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects cyclic params instead of recursing indefinitely', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const parsed = readSchema('SystemTaskSpecSchema').safeParse({
      protocolVersion: 1,
      kind: 'setup.thisComputer.v1',
      params: cyclic,
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts shared object references (JSON-safe even if identity is not preserved)', () => {
    const shared = { value: 1 };

    const parsed = readSchema('SystemTaskSpecSchema').safeParse({
      protocolVersion: 1,
      kind: 'setup.thisComputer.v1',
      params: {
        a: shared,
        b: shared,
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe('SystemTaskEventSchema', () => {
  it('accepts a valid event with optional fields', () => {
    const parsed = readSchema('SystemTaskEventSchema').safeParse({
      protocolVersion: 1,
      taskId: 'task_123',
      tsMs: 1234,
      type: 'progress',
      stepId: 'install.runtime',
      message: 'installing runtime',
      data: {
        percent: 50,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects non-JSON event data', () => {
    const parsed = readSchema('SystemTaskEventSchema').safeParse({
      protocolVersion: 1,
      taskId: 'task_123',
      tsMs: 1234,
      type: 'progress',
      data: {
        callback: () => 'nope',
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('SystemTaskResultSchema', () => {
  it('accepts a successful result payload', () => {
    const parsed = readSchema('SystemTaskResultSchema').safeParse({
      protocolVersion: 1,
      taskId: 'task_123',
      ok: true,
      data: {
        daemonReady: true,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a failed result payload with a stable error shape', () => {
    const parsed = readSchema('SystemTaskResultSchema').safeParse({
      protocolVersion: 1,
      taskId: 'task_123',
      ok: false,
      error: {
        code: 'service_not_running',
        message: 'background service is not running',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a failed result without an error payload', () => {
    const parsed = readSchema('SystemTaskResultSchema').safeParse({
      protocolVersion: 1,
      taskId: 'task_123',
      ok: false,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-JSON success data', () => {
    const parsed = readSchema('SystemTaskResultSchema').safeParse({
      protocolVersion: 1,
      taskId: 'task_123',
      ok: true,
      data: Number.NaN,
    });

    expect(parsed.success).toBe(false);
  });
});
