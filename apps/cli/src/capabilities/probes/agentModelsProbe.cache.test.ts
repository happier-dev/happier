import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    opencode: {
      getPreflightSessionControlsProbeAdapter: async () => ({
        failureCacheStrategy: 'cooldown',
        cliModelsCommandArgs: ['models'],
      }),
    },
  },
}));

vi.mock('@/packagedRuntime/managedTools/agentCliResolution', () => ({
  resolveAgentCliCommand: () => null,
  resolveAgentCliCommandForRuntime: () => null,
}));

vi.mock('@/packagedRuntime/managedTools/requireAgentCliLaunchSpec', () => ({
  resolveAgentCliLaunchSpec: () => ({
    source: 'system',
    resolvedPath: process.execPath,
    command: process.execPath,
    args: [
      '-e',
      [
        'const fs = require("node:fs");',
        'const path = process.env.HAPPIER_TEST_MODELS_PROBE_COUNTER;',
        'const current = path && fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : 0;',
        'if (path) fs.writeFileSync(path, String(current + 1));',
        'process.stdout.write("openai/gpt-4.1\\nopenai/gpt-4.1-mini\\n");',
      ].join(' '),
    ],
  }),
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (cache)', () => {
  it('caches dynamic CLI results and avoids re-running the CLI probe', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-agent-model-probe-cache-'));
    const counterPath = join(tempDir, 'counter.txt');
    const previousCounterPath = process.env.HAPPIER_TEST_MODELS_PROBE_COUNTER;

    try {
      process.env.HAPPIER_TEST_MODELS_PROBE_COUNTER = counterPath;

      resetAgentModelsProbeCacheForTests();

      const first = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: tempDir, timeoutMs: 2_000 });
      expect(first.source).toBe('dynamic');
      expect(first.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);

      const second = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: tempDir, timeoutMs: 2_000 });
      expect(second.source).toBe('dynamic');
      expect(second.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);
      await expect(readFile(counterPath, 'utf8')).resolves.toBe('1');
    } finally {
      if (typeof previousCounterPath === 'string') {
        process.env.HAPPIER_TEST_MODELS_PROBE_COUNTER = previousCounterPath;
      } else {
        delete process.env.HAPPIER_TEST_MODELS_PROBE_COUNTER;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
