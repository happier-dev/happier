import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { isExecutionRunHostRuntime } from '../bridges/executionRun/executionRunHostRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const QWEN_BACKEND_ID = 'qwen';
const QWEN_PLUGIN_ID = 'happier.agent.qwen';

function createQwenOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.agents.find((entry) => entry.id === QWEN_BACKEND_ID);
  const backend = builtInContributions.agentRuntimes.find((entry) => entry.id === QWEN_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === QWEN_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Qwen provider, backend, and activation target contributions');
  }

  return {
    agents: Object.freeze([provider]),
    agentRuntimes: Object.freeze([backend]),
    actions: Object.freeze([]),
    resources: Object.freeze([]),
    uiDescriptors: Object.freeze([]),
    notifications: Object.freeze([]),
    notificationChannels: Object.freeze([]),
    events: Object.freeze([]),
    executionRunProfiles: Object.freeze([]),
    managedDependencies: Object.freeze([]),
    requestInterceptors: Object.freeze([]),
    scmHostingProviders: Object.freeze([]),
    scmBackends: Object.freeze([]),
    connectedAccountDescriptors: Object.freeze([]),
    activationTargets: Object.freeze(activationTargets),
    hookRegistrations: Object.freeze([]),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: Object.freeze(provider.catalogEntry ? { [provider.catalogEntry.id]: provider.catalogEntry } : {}),
    agentDefinitionsById: new Map([[provider.id, provider]]),
    agentRuntimeDefinitionsById: new Map([[backend.id, backend]]),
    pluginDiagnosticsByPluginId: Object.freeze({}),
  };
}

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (qwen runtimeCore)', () => {
  it('resolves the bundled Qwen ACP plugin runtimeCore through production dispatch', async () => {
    const qwenShimDir = await mkdtemp(join(os.tmpdir(), 'happier-qwen-runtime-core-'));
    const qwenShimPath = join(qwenShimDir, 'qwen');
    const previousQwenPath = process.env.HAPPIER_QWEN_PATH;
    const contributes = createQwenOnlyContributionRegistry();

    try {
      await writeFile(qwenShimPath, '#!/bin/sh\nexit 0\n');
      await chmod(qwenShimPath, 0o755);
      process.env.HAPPIER_QWEN_PATH = qwenShimPath;

      const resolution = await resolveBackendEngineAdapterResolution('qwen', {
        contributes,
      });

      expect(resolution).toMatchObject({
        backendId: 'qwen',
        agentId: 'qwen',
        selectedSource: 'plugin',
        backend: {
          pluginId: 'happier.agent.qwen',
          daemonEntryPath: '@happier-dev/plugins-qwen',
        },
      });

      const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
        credentials: createTestCredentials(),
        directory: '/tmp/qwen',
        permissionMode: 'safe-yolo',
      });

      expect(plan).toMatchObject({
        kind: 'hostSessionRuntimePlan',
        agentId: 'qwen',
        config: {
          backendDisplayName: 'Qwen Code',
          providerName: 'Qwen Code',
          agentMessageType: 'qwen',
        },
      });
      expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));

      const executionRunRuntime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
        backendId: QWEN_BACKEND_ID,
        cwd: '/tmp/qwen',
        permissionMode: 'read_only',
        accountSettings: null,
      });

      expect(isExecutionRunHostRuntime(executionRunRuntime)).toBe(true);
      await expect(executionRunRuntime.readResumeSupport()).resolves.toBe(true);
    } finally {
      if (previousQwenPath === undefined) {
        delete process.env.HAPPIER_QWEN_PATH;
      } else {
        process.env.HAPPIER_QWEN_PATH = previousQwenPath;
      }
      await rm(qwenShimDir, { recursive: true, force: true });
    }
  });
});
