import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';
import type { Credentials } from '@/persistence';

const { claudeProbeModelsRawMock, createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  claudeProbeModelsRawMock: vi.fn(async () => [{ id: 'claude-account-model', name: 'Claude Account Model' }]),
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./createConfiguredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {
    opencode: {
      resolveModelsProbeVariant: ({ connectedServices }: { connectedServices?: { bindingsByServiceId?: Record<string, { selection?: string; groupId?: string; profileId?: string }> } | null }) => {
        const binding = connectedServices?.bindingsByServiceId?.['openai-codex'];
        if (binding?.selection === 'group') return `test:group:${binding.groupId ?? ''}`;
        if (binding?.selection === 'profile') return `test:profile:${binding.profileId ?? ''}`;
        return 'test:native';
      },
      getPreflightSessionControlsProbeAdapter: async () => ({
        failureCacheStrategy: 'cooldown',
        cliModelsCommandArgs: ['models'],
        probeModelsRaw: async (params: { connectedServices?: { bindingsByServiceId?: Record<string, { selection?: string; groupId?: string; profileId?: string }> } | null }) => {
          const binding = params.connectedServices?.bindingsByServiceId?.['openai-codex'];
          if (binding?.selection === 'group') return [{ id: 'group-model', name: 'Group Model' }];
          if (binding?.selection === 'profile') return [{ id: 'profile-model', name: 'Profile Model' }];
          return null;
        },
      }),
    },
    claude: {
      getPreflightSessionControlsProbeAdapter: async () => ({
        modelProbeCachePolicy: 'provider-owned',
        failureCacheStrategy: 'cooldown',
        probeModelsRaw: claudeProbeModelsRawMock,
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

  it('partitions cached probe results by connected-services identity', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-cli-model-probe-cs-cache');
    try {
      const { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } = await import('./agentModelsProbe');
      resetAgentModelsProbeCacheForTests();

      const groupConnectedServices = {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'leeroy',
          },
        },
      } as const;
      const profileConnectedServices = {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'leeroy',
          },
        },
      } as const;

      const group = await probeAgentModelsBestEffort({
        agentId: 'opencode',
        cwd: fixture.dir,
        timeoutMs: 2_000,
        connectedServices: groupConnectedServices,
      });
      const profile = await probeAgentModelsBestEffort({
        agentId: 'opencode',
        cwd: fixture.dir,
        timeoutMs: 2_000,
        connectedServices: profileConnectedServices,
      });

      expect(group.availableModels.map((model) => model.id)).toEqual(['default', 'group-model']);
      expect(profile.availableModels.map((model) => model.id)).toEqual(['default', 'profile-model']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves provider-owned results transient and forwards auth context without generic caching', async () => {
    vi.resetModules();
    claudeProbeModelsRawMock.mockClear();

    const fixture = await createProbeTempDir('happier-cli-model-probe-provider-cache');
    try {
      const { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } = await import('./agentModelsProbe');
      resetAgentModelsProbeCacheForTests();

      const credentials: Credentials = {
        token: 'account-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      };
      const accountSettings = { connectedServicesSettingsV1: { version: 1 } };
      const connectedServices = {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'connected-profile',
          },
        },
      } as const;
      const params = {
        agentId: 'claude' as const,
        cwd: fixture.dir,
        timeoutMs: 2_000,
        profileId: 'session-profile',
        credentials,
        accountSettings,
        connectedServices,
      };

      const [first, concurrent] = await Promise.all([
        probeAgentModelsBestEffort(params),
        probeAgentModelsBestEffort(params),
      ]);
      const later = await probeAgentModelsBestEffort(params);

      expect(first).toMatchObject({ source: 'dynamic', cacheable: false });
      expect(concurrent).toEqual(first);
      expect(later).toMatchObject({ source: 'dynamic', cacheable: false });
      expect(claudeProbeModelsRawMock).toHaveBeenCalledTimes(3);
      expect(claudeProbeModelsRawMock).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'session-profile',
        credentials,
        accountSettings,
        connectedServices,
      }));
    } finally {
      await fixture.cleanup();
    }
  });
});
