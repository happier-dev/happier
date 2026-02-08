import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

type ChildProcessLike = {
  pid?: number;
  killed?: boolean;
  kill: (signal: NodeJS.Signals) => void;
};

type ProcessLike = {
  platform: NodeJS.Platform;
  on: (event: NodeJS.Signals, handler: () => void) => void;
};

type ClaudeVersionUtilsModule = {
  attachChildSignalForwarding: (child: ChildProcessLike, proc?: ProcessLike) => void;
};

const require = createRequire(import.meta.url);
const claudeVersionUtils = require('../../../scripts/claude_version_utils.cjs') as ClaudeVersionUtilsModule;
const { attachChildSignalForwarding } = claudeVersionUtils;

describe('claude_version_utils attachChildSignalForwarding', () => {
  it('forwards SIGTERM and SIGINT to child', () => {
    const handlers = new Map<NodeJS.Signals, (() => void)[]>();
    const proc: ProcessLike = {
      platform: 'darwin',
      on: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    };

    const child: ChildProcessLike = {
      pid: 123,
      killed: false,
      kill: vi.fn(),
    };

    attachChildSignalForwarding(child, proc);

    for (const handler of handlers.get('SIGTERM') ?? []) handler();
    for (const handler of handlers.get('SIGINT') ?? []) handler();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('does not register SIGHUP on Windows', () => {
    const handlers = new Map<NodeJS.Signals, (() => void)[]>();
    const proc: ProcessLike = {
      platform: 'win32',
      on: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    };

    const child: ChildProcessLike = { pid: 123, killed: false, kill: vi.fn() };
    attachChildSignalForwarding(child, proc);

    expect(handlers.has('SIGHUP')).toBe(false);
  });
});
