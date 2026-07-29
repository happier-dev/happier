import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { importSessionHandoffAgentBundle } from './import';

describe('Codex session handoff production reachability', () => {
  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(),
        pluginIds: ['happier.agent.codex'],
      }),
    });
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
    runtimeRegistryLease = null;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('imports through the generated SessionHostBridge execution surface', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-reachability-'));
    const relativePath = 'sessions/2026/07/23/rollout-thread-reachable.jsonl';
    vi.stubEnv('CODEX_HOME', codexHome);

    try {
      await expect(importSessionHandoffAgentBundle({
        targetPath: '/repo',
        bundle: {
          agentId: 'codex',
          remoteSessionId: 'thread-reachable',
          affinity: {
            backendMode: 'appServer',
          },
          files: [{
            relativePath,
            contentBase64: Buffer.from('{"event":"reachable"}\n', 'utf8').toString('base64'),
          }],
        },
      })).resolves.toMatchObject({
        remoteSessionId: 'thread-reachable',
        directSource: {
          kind: 'codexHome',
          home: 'user',
          homePath: codexHome,
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'thread-reachable',
          codexBackendMode: 'appServer',
          environmentVariables: {
            CODEX_HOME: codexHome,
          },
        },
      });

      await expect(readFile(join(codexHome, relativePath), 'utf8'))
        .resolves.toBe('{"event":"reachable"}\n');
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
