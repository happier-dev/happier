import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

const mockCodexLocalLauncher = vi.fn();
vi.mock('./codexLocalLauncher', () => ({
    codexLocalLauncher: mockCodexLocalLauncher,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        warn: vi.fn(),
        logFilePath: '/tmp/happier-cli-test.log',
    },
}));

describe('codex loop', () => {
  beforeEach(() => {
    mockCodexLocalLauncher.mockReset();
  });

  function createLoopContext() {
    const keepAlive = vi.fn();
    const client = {
      keepAlive,
      updateMetadata: vi.fn(),
    } as any;

    const messageQueue = new MessageQueue2<unknown>(() => 'mode');
    const modeChanges: Array<'local' | 'remote'> = [];
    const remoteLauncher = vi.fn(async () => 'exit' as 'exit' | 'switch');

    return { keepAlive, client, messageQueue, modeChanges, remoteLauncher };
  }

  it('updates Session.mode so keepAlive reports remote mode after local->remote switch', async () => {
    mockCodexLocalLauncher.mockResolvedValueOnce({ type: 'switch', resumeId: 'resume-1' });
    const { keepAlive, client, messageQueue, modeChanges, remoteLauncher } = createLoopContext();
    remoteLauncher.mockResolvedValueOnce('exit');

    const { loop } = await import('./loop');

    const onSessionReady = vi.fn();
    await loop({
      path: '/tmp',
      onModeChange: (mode: 'local' | 'remote') => modeChanges.push(mode),
      session: client,
      api: {},
      messageQueue,
      remoteLauncher,
      onSessionReady,
    } as any);

    expect(modeChanges).toEqual(['remote']);
    expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(onSessionReady).toHaveBeenCalledTimes(1);
  });

  it('returns local exit code without invoking remote launcher', async () => {
    mockCodexLocalLauncher.mockResolvedValueOnce({ type: 'exit', code: 42 });

    const { client, messageQueue, modeChanges, remoteLauncher } = createLoopContext();
    const { loop } = await import('./loop');

    const code = await loop({
      path: '/tmp',
      onModeChange: (mode: 'local' | 'remote') => modeChanges.push(mode),
      session: client,
      api: {},
      messageQueue,
      remoteLauncher,
    } as any);

    expect(code).toBe(42);
    expect(modeChanges).toEqual([]);
    expect(remoteLauncher).not.toHaveBeenCalled();
  });

  it('switches remote->local and continues until the next local exit', async () => {
    mockCodexLocalLauncher
      .mockResolvedValueOnce({ type: 'switch', resumeId: 'resume-1' })
      .mockResolvedValueOnce({ type: 'exit', code: 7 });
    const { keepAlive, client, messageQueue, modeChanges, remoteLauncher } = createLoopContext();
    remoteLauncher.mockResolvedValueOnce('switch');

    const { loop } = await import('./loop');

    const code = await loop({
      path: '/tmp',
      onModeChange: (mode: 'local' | 'remote') => modeChanges.push(mode),
      session: client,
      api: {},
      messageQueue,
      remoteLauncher,
    } as any);

    expect(code).toBe(7);
    expect(modeChanges).toEqual(['remote', 'local']);
    expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(keepAlive).toHaveBeenCalledWith(false, 'local');
    expect(mockCodexLocalLauncher).toHaveBeenCalledTimes(2);
    expect(remoteLauncher).toHaveBeenCalledTimes(1);
  });
});
