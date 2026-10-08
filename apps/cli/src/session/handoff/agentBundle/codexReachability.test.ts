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

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { importSessionHandoffAgentBundle } from './import';

describe('Codex session handoff production reachability', () => {
  let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

  beforeAll(async () => {
    runtimeFixture = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] },
    });
  });

  afterAll(async () => {
    await runtimeFixture?.dispose();
    runtimeFixture = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('imports through the generated SessionHostBridge execution surface', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-reachability-'));
    const relativePath = 'sessions/2026/07/23/rollout-thread-reachable.jsonl';
    const content = Buffer.from([
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'thread-reachable' },
      }),
      JSON.stringify({ event: 'reachable' }),
      '',
    ].join('\n'), 'utf8');
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
            contentBase64: content.toString('base64'),
          }],
        },
      })).resolves.toMatchObject({
        remoteSessionId: 'thread-reachable',
        directSource: {
          kind: 'codexHome',
          home: 'user',
          homePath: codexHome,
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread-reachable',
          },
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'thread-reachable',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
          environmentVariables: {
            CODEX_HOME: codexHome,
          },
        },
      });

      await expect(readFile(join(codexHome, relativePath)))
        .resolves.toEqual(content);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
