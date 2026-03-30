import {
  SystemTaskEventSchema,
  SystemTaskResultSchema,
  type SystemTaskResult,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { runHsetupCli } from '../bin/hsetup.js';
import { runSystemTaskRunCommand } from './runCommand.js';

function createBufferWriter() {
  let text = '';
  return {
    writer: {
      write(chunk: string | Uint8Array) {
        text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    },
    read() {
      return text;
    },
  };
}

function parseJsonLines(text: string): unknown[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readResult(lines: unknown[]): SystemTaskResult {
  expect(lines.length).toBeGreaterThan(0);
  const parsed = SystemTaskResultSchema.safeParse(lines.at(-1));
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : (null as never);
}

describe('runSystemTaskRunCommand', () => {
  it('rejects specs with the wrong protocol version using a stable invalid_spec error', async () => {
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();

    const exitCode = await runSystemTaskRunCommand({
      argv: [
        'system-tasks',
        'run',
        '--spec-json',
        JSON.stringify({
          protocolVersion: 2,
          kind: 'system.noop.v1',
          params: {},
        }),
      ],
      stdinText: '',
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    const lines = parseJsonLines(stdout.read());
    const result = readResult(lines);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_spec');
    }
  });

  it('rejects unknown task kinds with a stable unknown_kind error', async () => {
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();

    const exitCode = await runSystemTaskRunCommand({
      argv: [
        'system-tasks',
        'run',
        '--spec-json',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'system.missing.v1',
          params: {},
        }),
      ],
      stdinText: '',
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    const result = readResult(parseJsonLines(stdout.read()));

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_kind');
    }
  });

  it('emits only schema-valid json lines for a ping task with nested params', async () => {
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();

    const exitCode = await runSystemTaskRunCommand({
      argv: [
        'system-tasks',
        'run',
        '--spec-json',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'system.ping.v1',
          params: {
            nested: {
              enabled: true,
            },
            items: [1, 'two', false],
          },
        }),
      ],
      stdinText: '',
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    const lines = parseJsonLines(stdout.read());
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines.slice(0, -1)) {
      expect(SystemTaskEventSchema.safeParse(line).success).toBe(true);
    }
    const result = readResult(lines);

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        acknowledged: true,
        kind: 'system.ping.v1',
        paramDigest: expect.any(String),
      });
    }
  });

  it('emits a cancelled final result when the hsetup process receives SIGTERM', async () => {
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();
    const signalListeners = new Map<NodeJS.Signals, () => void>();
    let signalSent = false;

		    const exitCode = await runHsetupCli(
	      [
	        'system-tasks',
	        'run',
        '--spec-json',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'system.noop.v1',
          params: {
            delayMs: 5_000,
          },
        }),
	      ],
	      {
	        stdin: {
	          async readAll() {
	            return '';
	          },
	          async readLine() {
	            return null;
	          },
	        },
	        stdout: {
	          write(chunk: string) {
	            stdout.writer.write(chunk);
            if (!signalSent) {
              signalSent = true;
              signalListeners.get('SIGTERM')?.();
            }
          },
        },
        stderr: {
          write(chunk: string) {
            stderr.writer.write(chunk);
          },
        },
        processObject: {
          once(eventName, listener) {
            signalListeners.set(eventName, listener);
          },
          off(eventName, listener) {
            if (signalListeners.get(eventName) === listener) {
              signalListeners.delete(eventName);
            }
          },
        },
      },
    );

    const lines = parseJsonLines(stdout.read());
    const result = readResult(lines);

    expect(exitCode).toBe(143);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cancelled');
    }
    expect(stderr.read()).toBe('');
  });
});
