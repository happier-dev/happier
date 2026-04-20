import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      kill: (signal?: NodeJS.Signals | number) => void;
    };
    child.stdout = stdout;
    child.kill = () => {};

    queueMicrotask(() => {
      stdout.write('openai/gpt-4.1\nopenai/gpt-4.1-mini\n');
      stdout.end();
      child.emit('close', 0);
    });

    return child as any;
  }),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {
    opencode: {
      getPreflightSessionControlsProbeAdapter: async () => ({
        failureCacheStrategy: 'cooldown',
        cliModelsCommandArgs: ['models'],
      }),
    },
  },
}));

vi.mock('@/runtime/managedTools/providerCliResolution', () => ({
  resolveProviderCliCommand: () => null,
  resolveProviderCliCommandForRuntime: () => null,
}));

describe('probeAgentModelsBestEffort (cache)', () => {
  it('caches dynamic CLI results and avoids re-running the CLI probe', async () => {
    try {
      const { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } = await import('./agentModelsProbe');
      resetAgentModelsProbeCacheForTests();
      spawnMock.mockClear();

      const first = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: '/tmp', timeoutMs: 2_000 });
      expect(first.source).toBe('dynamic');
      expect(first.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);

      const second = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: '/tmp', timeoutMs: 2_000 });
      expect(second.source).toBe('dynamic');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      spawnMock.mockReset();
    }
  }, 20_000);
});
