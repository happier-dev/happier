import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type RelayCallbacks = {
  onData?: (data: string) => void;
  onExit?: (event: { exitCode?: number }) => void;
};

function createRelayScriptHarness(
  argv: string[] = ['--', 'fake-shell'],
  params?: Readonly<{
    modules?: (defaultModule: { spawn: ReturnType<typeof vi.fn> }, fakePty: {
      write: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
      onExit: ReturnType<typeof vi.fn>;
    }) => Record<string, unknown>;
  }>,
) {
  const scriptPath = resolve(__dirname, '../../../scripts/node_pty_relay.cjs');
  const source = readFileSync(scriptPath, 'utf8').replace(/^#!.*\n/, '');
  const callbacks: RelayCallbacks = {};
  const fakePty = {
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      callbacks.onData = listener;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((listener: (event: { exitCode?: number }) => void) => {
      callbacks.onExit = listener;
      return { dispose: vi.fn() };
    }),
  };
  const spawn = vi.fn(() => fakePty);
  const modules = params?.modules?.({ spawn }, fakePty) ?? { 'node-pty': { spawn } };
  const fakeStdin = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    destroy: vi.fn(),
  });
  const fakeProcess = Object.assign(new EventEmitter(), {
    argv: ['node', scriptPath, ...argv],
    env: { TERM: 'xterm-256color' },
    exit: vi.fn(),
    exitCode: undefined as number | undefined,
    cwd: vi.fn(() => '/tmp/workspace'),
    stdin: fakeStdin,
    stdout: {
      write: vi.fn(() => false),
    },
    stderr: {
      write: vi.fn(() => true),
    },
  });

  vm.runInNewContext(source, {
    Buffer,
    process: fakeProcess,
    require: (id: string) => {
      if (Object.prototype.hasOwnProperty.call(modules, id)) {
        const value = modules[id];
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error(`unexpected require: ${id}`);
    },
  });

  return { callbacks, fakeProcess, spawn };
}

describe('node_pty_relay.cjs', () => {
  it('does not force-exit before final PTY output can drain', () => {
    const { callbacks, fakeProcess } = createRelayScriptHarness();

    callbacks.onData?.('final output');
    callbacks.onExit?.({ exitCode: 0 });

    expect(fakeProcess.stdout.write).toHaveBeenCalledWith('final output');
    expect(fakeProcess.exitCode).toBe(0);
    expect(fakeProcess.exit).not.toHaveBeenCalled();
    expect(fakeProcess.stdin.pause).toHaveBeenCalled();
  });

  it('preserves string child args when requested by the relay protocol', () => {
    const { spawn } = createRelayScriptHarness(['--args-kind', 'string', '--', 'cmd.exe', '/c echo ok']);

    expect(spawn).toHaveBeenCalledWith(
      'cmd.exe',
      '/c echo ok',
      expect.objectContaining({ encoding: null, useConpty: true }),
    );
  });

  it('falls back to the packaged prebuilt PTY backend when node-pty cannot load', () => {
    const homebridgeSpawn = vi.fn();
    createRelayScriptHarness(['--', 'cmd.exe'], {
      modules: (_defaultModule, fakePty) => ({
        'node-pty': new Error('node-pty native binding unavailable'),
        '@homebridge/node-pty-prebuilt-multiarch': {
          spawn: homebridgeSpawn.mockReturnValue(fakePty),
        },
      }),
    });

    expect(homebridgeSpawn).toHaveBeenCalledWith(
      'cmd.exe',
      [],
      expect.objectContaining({ encoding: null, useConpty: true }),
    );
  });
});
