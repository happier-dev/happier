import { describe, expect, it } from 'vitest';

describe('console capture helpers', () => {
  it('captures console.log output and mutes stdout writes until restored', async () => {
    const logger = await import('@/testkit/logger/captureOutput').catch(() => null);

    expect(logger).not.toBeNull();
    expect(logger?.captureConsoleLogAndMuteStdout).toBeTypeOf('function');

    const output = logger!.captureConsoleLogAndMuteStdout();
    try {
      console.log('hello', 'world');
      expect(output.logs).toEqual(['hello world']);
    } finally {
      output.restore();
    }
  });

  it('captures stdout and stderr writes until restored', async () => {
    const logger = await import('@/testkit/logger/captureOutput').catch(() => null);

    expect(logger).not.toBeNull();
    expect(logger?.captureStdout).toBeTypeOf('function');
    expect(logger?.captureStderr).toBeTypeOf('function');

    const stdout = logger!.captureStdout();
    const stderr = logger!.captureStderr();
    try {
      process.stdout.write('hello stdout');
      process.stderr.write('hello stderr');
      expect(stdout.text()).toBe('hello stdout');
      expect(stderr.text()).toBe('hello stderr');
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it('captures console.log JSON output and parses the combined payload', async () => {
    const logger = await import('@/testkit/logger/captureOutput').catch(() => null);

    expect(logger).not.toBeNull();
    expect(logger?.captureConsoleJsonOutput).toBeTypeOf('function');

    const output = logger!.captureConsoleJsonOutput<{ ok: boolean; kind: string }>();
    try {
      console.log('{"ok":true,');
      console.log('"kind":"session_list"}');

      expect(output.logs).toEqual(['{"ok":true,', '"kind":"session_list"}']);
      expect(output.json()).toEqual({ ok: true, kind: 'session_list' });
    } finally {
      output.restore();
    }
  });

  it('captures combined console.log, console.warn, and console.error output in order', async () => {
    const logger = await import('@/testkit/logger/captureOutput').catch(() => null);

    expect(logger).not.toBeNull();
    expect(logger?.captureConsoleText).toBeTypeOf('function');

    const output = logger!.captureConsoleText();
    try {
      console.log('hello', 'stdout');
      console.warn('hello', 'warn');
      console.error('hello', 'stderr');

      expect(output.lines).toEqual(['hello stdout', 'hello warn', 'hello stderr']);
      expect(output.text()).toBe('hello stdout\nhello warn\nhello stderr');
    } finally {
      output.restore();
    }
  });

  it('captures stdout JSON output and parses the combined payload', async () => {
    const logger = await import('@/testkit/logger/captureOutput').catch(() => null);

    expect(logger).not.toBeNull();
    expect(logger?.captureStdoutJsonOutput).toBeTypeOf('function');

    const output = logger!.captureStdoutJsonOutput<{ ok: boolean; mode: string }>();
    try {
      process.stdout.write('{"ok":true,');
      process.stdout.write('"mode":"daemon"}');

      expect(output.chunks).toEqual(['{"ok":true,', '"mode":"daemon"}']);
      expect(output.json()).toEqual({ ok: true, mode: 'daemon' });
    } finally {
      output.restore();
    }
  });
});
