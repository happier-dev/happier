import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { PtySpawnParams } from './provider';
import {
  buildNodePtyRelaySpawnCommand,
  createNodePtyRelayProvider,
} from './nodeRelay';

const relayWriteFramePrefix = '\u001eHAPPIER_PTY_WRITE ';

function expectedRelayWriteFrame(data: string): string {
  return `${relayWriteFramePrefix}${Buffer.from(data, 'utf8').toString('base64')}\n`;
}

function createFakeChildProcess(params?: Readonly<{ stdinClosed?: boolean }>) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processEmitter = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter & {
      destroyed?: boolean;
      writableEnded?: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  processEmitter.pid = 2468;
  processEmitter.stdin = Object.assign(new EventEmitter(), {
    destroyed: params?.stdinClosed,
    writableEnded: params?.stdinClosed,
    write: vi.fn(() => true),
    end: vi.fn(function end(this: EventEmitter & { writableEnded?: boolean }) {
      this.writableEnded = true;
      return this;
    }),
  });
  processEmitter.stdout = stdout;
  processEmitter.stderr = stderr;
  processEmitter.kill = vi.fn();
  return processEmitter;
}

const passthroughCommandInvocation = (input: Readonly<{ command: string; args: readonly string[] }>) => ({
  command: input.command,
  args: [...input.args],
});

describe('buildNodePtyRelaySpawnCommand', () => {
  it('builds a managed Node relay invocation that forwards the child command after --', () => {
    const invocation = buildNodePtyRelaySpawnCommand({
      nodeExecutable: 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      file: 'C:\\managed\\node.exe',
      args: ['C:\\happier\\scripts\\terminal_launch_spec_runner.cjs', 'C:\\tmp\\launch.json'],
    });

    expect(invocation).toEqual({
      command: 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      args: [
        'C:\\happier\\scripts\\node_pty_relay.cjs',
        '--args-kind',
        'array',
        '--',
        'C:\\managed\\node.exe',
        'C:\\happier\\scripts\\terminal_launch_spec_runner.cjs',
        'C:\\tmp\\launch.json',
      ],
    });
  });

  it('preserves string args as the relay child command-line kind', () => {
    const invocation = buildNodePtyRelaySpawnCommand({
      nodeExecutable: 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      file: 'cmd.exe',
      args: '/c echo ok',
    });

    expect(invocation).toEqual({
      command: 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      args: [
        'C:\\happier\\scripts\\node_pty_relay.cjs',
        '--args-kind',
        'string',
        '--',
        'cmd.exe',
        '/c echo ok',
      ],
    });
  });
});

describe('createNodePtyRelayProvider', () => {
  it('propagates requested PTY dimensions to the managed relay environment', () => {
    const fakeChild = createFakeChildProcess();
    const spawnProcess = vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams);
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess,
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    expect(provider).toBeTruthy();

    provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: ['C:\\happier\\scripts\\terminal_launch_spec_runner.cjs', 'C:\\tmp\\launch.json'],
      options: {
        cwd: 'C:\\workspace',
        env: { PATH: 'C:\\Windows\\System32', TERM: 'xterm-256color' },
        cols: 132,
        rows: 48,
      },
    } satisfies PtySpawnParams);

    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      [
        'C:\\happier\\scripts\\node_pty_relay.cjs',
        '--args-kind',
        'array',
        '--',
        'C:\\managed\\node.exe',
        'C:\\happier\\scripts\\terminal_launch_spec_runner.cjs',
        'C:\\tmp\\launch.json',
      ],
      {
        cwd: 'C:\\workspace',
        env: {
          PATH: 'C:\\Windows\\System32',
          TERM: 'xterm-256color',
          HAPPIER_NODE_PTY_RELAY_COLS: '132',
          HAPPIER_NODE_PTY_RELAY_ROWS: '48',
        },
        stdio: 'pipe',
        windowsHide: true,
      },
    );
  });

  it('inherits the provider environment when spawn env is omitted', () => {
    const fakeChild = createFakeChildProcess();
    const spawnProcess = vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams);
    const provider = createNodePtyRelayProvider({
      env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess,
      resolveCommandInvocation: passthroughCommandInvocation,
    });

    provider!.spawn({
      file: 'cmd.exe',
      args: [],
      options: { cwd: 'C:\\workspace', cols: 80, rows: 24 },
    } satisfies PtySpawnParams);

    expect(spawnProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: 'C:\\Windows\\System32',
          SystemRoot: 'C:\\Windows',
          HAPPIER_NODE_PTY_RELAY_COLS: '80',
          HAPPIER_NODE_PTY_RELAY_ROWS: '24',
        }),
      }),
    );
  });

  it('frames writes, exposes relay pid and byte output, and fails closed when input is unavailable', () => {
    const fakeChild = createFakeChildProcess();
    const spawnProcess = vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams);
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess,
      resolveCommandInvocation: passthroughCommandInvocation,
    });

    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: ['C:\\happier\\scripts\\terminal_launch_spec_runner.cjs', 'C:\\tmp\\launch.json'],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);
    const onBytes = vi.fn();
    pty.onDataBytes?.(onBytes);

    pty.write('prompt text');
    pty.write('\r');
    fakeChild.stdout.emit('data', Buffer.from([0x00, 0xff, 0x61]));

    expect(pty.pid).toBe(2468);
    expect(fakeChild.stdin.write).toHaveBeenNthCalledWith(1, expectedRelayWriteFrame('prompt text'));
    expect(fakeChild.stdin.write).toHaveBeenNthCalledWith(2, expectedRelayWriteFrame('\r'));
    expect(onBytes).toHaveBeenCalledWith(Buffer.from([0x00, 0xff, 0x61]));

    fakeChild.stdin.destroyed = true;
    expect(() => pty.write('after close')).toThrow('terminal_pty_input_closed');
  });

  it('reports relay child spawn errors as PTY exits', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);
    const onExit = vi.fn();
    pty.onExit(onExit);

    expect(() => fakeChild.emit('error', new Error('spawn ENOENT'))).not.toThrow();

    expect(onExit).toHaveBeenCalledWith({ exitCode: -1 });
  });

  it('marks relay input closed when stdin reports a stream error', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);

    expect(() => fakeChild.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() => pty.write('after input error')).toThrow('terminal_pty_input_closed');
  });

  it('closes relay stdin before falling back to killing the relay process', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);

    pty.kill();

    expect(fakeChild.stdin.end).toHaveBeenCalledOnce();
    expect(fakeChild.kill).not.toHaveBeenCalled();
    expect(() => pty.write('after kill requested')).toThrow('terminal_pty_input_closed');
  });

  it('escalates relay termination with SIGKILL when stdin EOF does not close the relay', () => {
    vi.useFakeTimers();
    try {
      const fakeChild = createFakeChildProcess();
      const provider = createNodePtyRelayProvider({
        platform: 'win32',
        resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
        relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
        spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
        resolveCommandInvocation: passthroughCommandInvocation,
      });
      const pty = provider!.spawn({
        file: 'C:\\managed\\node.exe',
        args: [],
        options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
      } satisfies PtySpawnParams);

      pty.kill();
      vi.advanceTimersByTime(2_000);

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays pre-listener stdout to the first onData listener (UX-8 early-stdout buffer)', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);

    // Banner/prompt bytes arrive BEFORE any onData listener is attached.
    fakeChild.stdout.emit('data', Buffer.from('early banner\n'));
    fakeChild.stderr.emit('data', Buffer.from('early warning\n'));

    const onData = vi.fn();
    pty.onData(onData);

    // The buffered early output is replayed to the first listener, in arrival order...
    expect(onData).toHaveBeenNthCalledWith(1, 'early banner\n');
    expect(onData).toHaveBeenNthCalledWith(2, 'early warning\n');

    // ...and live output continues to flow afterwards exactly once.
    fakeChild.stdout.emit('data', Buffer.from('live output'));
    expect(onData).toHaveBeenNthCalledWith(3, 'live output');
    expect(onData).toHaveBeenCalledTimes(3);
  });

  it('replays pre-listener output as raw bytes to the first onDataBytes listener (UX-8)', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);

    fakeChild.stdout.emit('data', Buffer.from([0x00, 0xff, 0x61]));

    const onBytes = vi.fn();
    pty.onDataBytes?.(onBytes);

    expect(onBytes).toHaveBeenNthCalledWith(1, Buffer.from([0x00, 0xff, 0x61]));
  });

  it('waits for relay stdio close before reporting process exit', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });
    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);
    const onData = vi.fn();
    const onExit = vi.fn();
    pty.onData(onData);
    pty.onExit(onExit);

    fakeChild.emit('exit', 0, null);
    expect(() => pty.write('after exit before close')).toThrow('terminal_pty_input_closed');
    fakeChild.stdout.emit('data', Buffer.from('tail output'));

    expect(onData).toHaveBeenCalledWith('tail output');
    expect(onExit).not.toHaveBeenCalled();

    fakeChild.emit('close', 0, null);

    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it('makes unsupported resize explicit', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createNodePtyRelayProvider({
      platform: 'win32',
      resolveNodeExecutable: () => 'C:\\Users\\test\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
      relayScriptPath: 'C:\\happier\\scripts\\node_pty_relay.cjs',
      spawnProcess: vi.fn(() => fakeChild as unknown as ChildProcessWithoutNullStreams),
      resolveCommandInvocation: passthroughCommandInvocation,
    });

    const pty = provider!.spawn({
      file: 'C:\\managed\\node.exe',
      args: [],
      options: { cwd: 'C:\\workspace', env: { PATH: 'C:\\Windows\\System32' } },
    } satisfies PtySpawnParams);

    expect(() => pty.resize(120, 40)).toThrow('terminal_resize_unavailable');
  });
});
