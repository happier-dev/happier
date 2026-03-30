import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./createConfiguredAcpProbeBackend', () => ({
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
}));

describe('probeAgentModelsBestEffort (cache)', () => {
  it('caches dynamic CLI results and avoids re-running the CLI probe', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-cli-model-probe-cache');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    await writeExecutableScript(
      opencodePath,
      process.platform === 'win32'
        ? `@echo off\r\nif not "%HAPPIER_TEST_PROBE_COUNT_FILE%"=="" echo|set /p=1>> "%HAPPIER_TEST_PROBE_COUNT_FILE%"\r\nif "%1"=="models" (\r\necho openai/gpt-4.1\r\necho openai/gpt-4.1-mini\r\nexit /b 0\r\n)\r\nexit /b 1\r\n`
        : `#!/bin/sh\nif [ -n \"$HAPPIER_TEST_PROBE_COUNT_FILE\" ]; then printf 1 >> \"$HAPPIER_TEST_PROBE_COUNT_FILE\"; fi\nif [ \"$1\" = \"models\" ]; then\n  printf '%s\\n' 'openai/gpt-4.1' 'openai/gpt-4.1-mini'\n  exit 0\nfi\nexit 1\n`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_PROBE_COUNT_FILE;
    const prevOverride = process.env.HAPPIER_OPENCODE_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_PROBE_COUNT_FILE = countFile;
    process.env.HAPPIER_OPENCODE_PATH = opencodePath;
    try {
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const first = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: fixture.dir, timeoutMs: 2_000 });
      expect(first.source).toBe('dynamic');

      const second = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: fixture.dir, timeoutMs: 2_000 });
      expect(second.source).toBe('dynamic');

      const count = (await readFile(countFile, 'utf8')).trim();
      expect(count.length).toBe(1);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') {
        process.env.HAPPIER_TEST_PROBE_COUNT_FILE = prevCountFile;
      } else {
        delete process.env.HAPPIER_TEST_PROBE_COUNT_FILE;
      }
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_OPENCODE_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_OPENCODE_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);
});
