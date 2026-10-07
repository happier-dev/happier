import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  children: [] as EventEmitter[],
  killProcessTree: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn,
}));

vi.mock('@/agent/runtime/process/killProcessTree', () => ({
  killProcessTree: mocks.killProcessTree,
}));

import { runScmCommand } from './runtime';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from './checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from './checkpoints/refs';

type FakeChild = EventEmitter & Readonly<{
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Readonly<{
    writable: boolean;
    destroyed: boolean;
    once: () => void;
    write: () => void;
    end: () => void;
  }>;
  kill: () => boolean;
}>;

function createFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { writable: true, destroyed: false, once: () => undefined, write: () => undefined, end: () => undefined },
    kill: () => true,
  });
  return child;
}

describe('runScmCommand cancellation', () => {
  it('captures checkpoints when Git phases finish within the canonical command budget', async () => {
    // Git processes and clocks are system boundaries; checkpoint capture,
    // private-index setup and the SCM process-budget owner remain real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.spawn.mockReset();
    const treeOid = 'a'.repeat(40);
    const commitOid = 'b'.repeat(40);
    mocks.spawn.mockImplementation((_command: string, args: readonly string[]) => {
      const child = createFakeChild(41005);
      const delayed = setTimeout(() => {
        const output = args.includes('--show-toplevel') ? process.cwd()
          : args[0] === 'rev-parse' || args[0] === 'commit-tree' ? commitOid
          : args[0] === 'write-tree' ? treeOid : '';
        if (output) child.stdout.emit('data', Buffer.from(`${output}\n`));
        child.emit('close', 0);
      }, 11000);
      Object.assign(child, { kill: () => { clearTimeout(delayed); child.emit('close', 1); return true; } });
      return child;
    });
    try {
      const cwd = process.cwd();
      const refs = buildRepositoryCheckpointRefs({ scopeId: `budget:${cwd}`, messageId: 'message', turnId: 'turn' });
      if (!refs.messageStart || !refs.turnStart) throw new Error('Missing checkpoint refs');
      const checkpointRef = refs.messageStart;
      const operation = resolveGitCheckpointBackendContext({ cwd }).then(async (context) => ({
        context,
        capture: context ? await gitCheckpointAdapter.capture({ context, checkpointRef }) : null,
        alias: context ? await gitCheckpointAdapter.alias({ context, sourceRef: checkpointRef, targetRef: refs.turnStart! }) : null,
      }));
      await vi.runAllTimersAsync();
      expect(await operation).toMatchObject({ context: { detection: { rootPath: cwd } },
        capture: { success: true, checkpointRef, treeSha: treeOid, commitSha: commitOid },
        alias: { success: true, sourceRef: checkpointRef, targetRef: refs.turnStart, commitSha: commitOid } });
    } finally {
      vi.useRealTimers();
      mocks.spawn.mockReset();
    }
  });

  it('does not spawn when the operation was already aborted', async () => {
    mocks.spawn.mockReset();
    mocks.killProcessTree.mockReset();
    const controller = new AbortController();
    controller.abort();

    await expect(runScmCommand({
      bin: 'git',
      cwd: process.cwd(),
      args: ['log'],
      signal: controller.signal,
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      stderr: 'SCM command was aborted',
    }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
  });

  it('terminates every command sharing an AbortSignal through the process-tree owner', async () => {
    const children = [createFakeChild(41001), createFakeChild(41002)];
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() => {
      const child = children[mocks.spawn.mock.calls.length - 1];
      if (!child) throw new Error('Unexpected SCM spawn');
      return child;
    });
    mocks.killProcessTree.mockReset();
    mocks.killProcessTree.mockImplementation(async (child: FakeChild) => {
      queueMicrotask(() => child.emit('close', null));
    });
    const controller = new AbortController();

    const commands = [
      runScmCommand({ bin: 'git', cwd: process.cwd(), args: ['log'], signal: controller.signal }),
      runScmCommand({ bin: 'git', cwd: process.cwd(), args: ['log'], signal: controller.signal }),
    ];
    controller.abort();
    const results = await Promise.all(commands);

    expect(mocks.killProcessTree.mock.calls.map(([child]) => child)).toEqual(children);
    expect(results).toEqual([
      expect.objectContaining({ success: false }),
      expect.objectContaining({ success: false }),
    ]);
  });

  it('responds once to a complete acknowledgement split across stdout chunks', async () => {
    const child = createFakeChild(41003);
    mocks.spawn.mockReset();
    mocks.spawn.mockReturnValue(child);
    const write = vi.spyOn(child.stdin, 'write');
    const end = vi.spyOn(child.stdin, 'end');
    const respond = vi.fn(async () => 'commit\n');
    const command = runScmCommand({
      bin: 'git', cwd: process.cwd(), args: ['update-ref', '--stdin'], stdin: 'prepare\n',
      stdinInteraction: { readyLine: 'prepare: ok', respond },
    });
    expect(write.mock.calls).toEqual([['prepare\n']]);
    expect(end).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('not prepare: ok\nprepa'));
    child.stdout.emit('data', Buffer.from('re: ok'));
    expect(respond).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('\nprepare: ok\n'));
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(respond).toHaveBeenCalledOnce();
    expect(write.mock.calls).toEqual([['prepare\n'], ['commit\n']]);
    child.emit('close', 0);
    expect((await command).success).toBe(true);
  });

  it.each(['cancel', 'output_limit'] as const)('does not write a late response after %s and waits for owned process cleanup', async (reason) => {
    const child = createFakeChild(41004);
    mocks.spawn.mockReset();
    mocks.spawn.mockReturnValue(child);
    let settleCleanup!: () => void;
    mocks.killProcessTree.mockReset();
    mocks.killProcessTree.mockReturnValue(new Promise<void>((resolve) => { settleCleanup = resolve; }));
    let respond!: (value: string) => void;
    const response = new Promise<string>((resolve) => { respond = resolve; });
    const write = vi.spyOn(child.stdin, 'write');
    const controller = new AbortController();
    const command = runScmCommand({
      bin: 'git', cwd: process.cwd(), args: ['update-ref', '--stdin'], stdin: 'prepare\n',
      signal: controller.signal,
      ...(reason === 'output_limit' ? { maxOutputBytes: Buffer.byteLength('prepare: ok\n') } : {}),
      stdinInteraction: { readyLine: 'prepare: ok', respond: () => response },
    });
    child.stdout.emit('data', Buffer.from('prepare: ok\n'));
    await Promise.resolve();
    if (reason === 'cancel') controller.abort();
    else child.stdout.emit('data', Buffer.from('overflow\n'));
    // A command can have published successfully just before the cancellation was observed.
    child.emit('close', 0);
    let settled = false;
    void command.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    settleCleanup();
    expect(await command).toEqual(expect.objectContaining({ success: false, exitCode: -1, outputLimitExceeded: reason === 'output_limit' }));
    respond('commit\n');
    await response;
    await Promise.resolve();
    expect(write.mock.calls).toEqual([['prepare\n']]);
  });
});
