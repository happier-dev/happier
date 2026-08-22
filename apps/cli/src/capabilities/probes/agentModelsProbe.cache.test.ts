import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const { createConfiguredAcpProbeBackendMock, cliProbeState } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
  cliProbeState: {
    counterPath: '',
    requireSanitizedEnvironment: false,
  },
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
  resolveAgentCliLaunchSpec: () => {
    const expectedEnvironment = {
      PATH: '/required/cold-probe/path',
      HAPPIER_OPENCODE_PATH: '/required/cold-probe/opencode',
      HAPPIER_JS_RUNTIME_PATH: '/required/cold-probe/node',
    };
    return {
      source: 'system',
      resolvedPath: process.execPath,
      command: process.execPath,
      args: [
        '-e',
        [
          'const fs = require("node:fs");',
          `const counterPath = ${JSON.stringify(cliProbeState.counterPath)};`,
          `const requireSanitizedEnvironment = ${JSON.stringify(cliProbeState.requireSanitizedEnvironment)};`,
          `const expectedEnvironment = ${JSON.stringify(expectedEnvironment)};`,
          'const hasExpectedEnvironment = Object.entries(expectedEnvironment).every(([key, value]) => process.env[key] === value);',
          'const hasNoAmbientCredentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN", "HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH"].every((key) => process.env[key] === undefined);',
          'if (requireSanitizedEnvironment && (!hasExpectedEnvironment || !hasNoAmbientCredentials)) process.exit(41);',
          'const current = counterPath && fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;',
          'if (counterPath) fs.writeFileSync(counterPath, String(current + 1));',
          'process.stdout.write("openai/gpt-4.1\\nopenai/gpt-4.1-mini\\n");',
        ].join(' '),
      ],
    };
  },
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (cache)', () => {
  it('caches dynamic CLI results and avoids re-running the CLI probe', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-agent-model-probe-cache-'));
    const counterPath = join(tempDir, 'counter.txt');

    try {
      cliProbeState.counterPath = counterPath;

      resetAgentModelsProbeCacheForTests();

      const first = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: tempDir, timeoutMs: 2_000 });
      expect(first.source).toBe('dynamic');
      expect(first.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);

      const second = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: tempDir, timeoutMs: 2_000 });
      expect(second.source).toBe('dynamic');
      expect(second.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);
      await expect(readFile(counterPath, 'utf8')).resolves.toBe('1');
    } finally {
      cliProbeState.counterPath = '';
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('passes only approved runtime values to direct CLI probes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-agent-model-probe-cold-environment-'));

    try {
      cliProbeState.requireSanitizedEnvironment = true;
      resetAgentModelsProbeCacheForTests();

      const result = await probeAgentModelsBestEffort({
        agentId: 'opencode',
        cwd: tempDir,
        timeoutMs: 2_000,
        env: {
          PATH: '/required/cold-probe/path',
          HAPPIER_OPENCODE_PATH: '/required/cold-probe/opencode',
          HAPPIER_JS_RUNTIME_PATH: '/required/cold-probe/node',
          OPENAI_API_KEY: 'ambient-openai-api-key',
          ANTHROPIC_API_KEY: 'ambient-anthropic-api-key',
          CODEX_API_KEY: 'ambient-codex-api-key',
          OPENAI_ACCESS_TOKEN: 'ambient-openai-access-token',
          HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH: '/private/cliproxy-capability.json',
        },
      });

      expect(result).toMatchObject({
        agentId: 'opencode',
        source: 'dynamic',
      });
      expect(result.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);
    } finally {
      cliProbeState.requireSanitizedEnvironment = false;
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
