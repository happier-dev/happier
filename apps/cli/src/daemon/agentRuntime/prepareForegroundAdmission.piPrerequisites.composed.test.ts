import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';
import { activate as activatePiPlugin } from '@happier-dev/plugins-pi';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveForegroundFinalPluginPrerequisites } from './prepareForegroundAdmission';

const fsBoundary = vi.hoisted(() => ({
  settingsByPath: new Map<string, string>(),
  existingPaths: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => (
      fsBoundary.existingPaths.has(String(path)) || actual.existsSync(path)
    ),
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1],
    ) => {
      const configured = fsBoundary.settingsByPath.get(String(path));
      if (configured !== undefined) return configured;
      return actual.readFileSync(path, options);
    },
  };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalProgramFiles = process.env.ProgramFiles;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

function createHookRegistration(): ResolvedActivatedHookRegistration {
  return {
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: 'happier.agent.pi',
    manifestPath: '/plugins/pi/plugin.json',
    daemonEntryPath: '/plugins/pi/daemon.mjs',
    sourceSpec: {
      kind: 'bundled',
      locator: '@happier-dev/plugins-pi',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
      filters: { agentId: 'pi' },
    },
  };
}

function createPiHookRuntimeRegistry(): ResolvedExecutablePluginRuntimeRegistry {
  const registration = createHookRegistration();
  let prerequisiteHandler: HookHandler | null = null;
  activatePiPlugin({
    agents: {
      register() {},
      registerExternalSessions() {},
      registerExternalSessionObservation() {},
    },
    hooks: {
      register(localId: string, handler: HookHandler) {
        if (localId === 'resolve-prerequisites') prerequisiteHandler = handler;
      },
    },
  } as unknown as PluginApi);
  if (!prerequisiteHandler) {
    throw new Error('Pi activation did not register its prerequisite hook');
  }
  return {
    contributes: {
      agentDefinitionsById: new Map([['pi', {
        id: 'pi',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: 'happier.agent.pi',
        definition: { id: 'pi' },
      }]]),
      activationTargets: Object.freeze([]),
      managedDependencies: Object.freeze([]),
    },
    hookHandlersByHookId: new Map([[
      'agent.resolvePrerequisites',
      [{
        pluginId: 'happier.agent.pi',
        localId: 'resolve-prerequisites',
        hookId: 'agent.resolvePrerequisites',
        priority: 0,
        registrationIndex: 0,
        manifestPath: registration.manifestPath,
        daemonEntryPath: registration.daemonEntryPath,
        registration,
        handler: prerequisiteHandler,
      }],
    ]]),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  process.env.ProgramFiles = 'C:\\Program Files';
  process.env.PI_CODING_AGENT_DIR = 'C:\\global-agent';
  fsBoundary.settingsByPath.clear();
  fsBoundary.existingPaths.clear();
  fsBoundary.settingsByPath.set(
    'C:\\global-agent\\settings.json',
    JSON.stringify({}),
  );
  fsBoundary.settingsByPath.set(
    'C:\\materialized-agent\\settings.json',
    JSON.stringify({ shellPath: 'D:\\missing\\bash.exe' }),
  );
  fsBoundary.existingPaths.add('C:\\Program Files\\Git\\bin\\bash.exe');
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
  else process.env.ProgramFiles = originalProgramFiles;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
});

describe('foreground Pi plugin prerequisite composition', () => {
  it('uses the final materialized Pi settings directory through the real hook registry and fails closed', async () => {
    const pluginRuntimeRegistry = createPiHookRuntimeRegistry();
    const common = {
      happyHomeDir: '/tmp/happier-foreground-pi',
      pluginRuntimeRegistry,
      resolvedAgentId: 'pi',
      directory: 'C:\\workspace',
      backendTarget: {
        kind: 'backend' as const,
        backendId: 'pi',
        sourceKind: 'built_in' as const,
      },
    };

    await expect(resolveForegroundFinalPluginPrerequisites({
      ...common,
      environment: {},
    })).resolves.toMatchObject({ ok: true });

    await expect(resolveForegroundFinalPluginPrerequisites({
      ...common,
      environment: {
        PI_CODING_AGENT_DIR: 'C:\\materialized-agent',
      },
    })).resolves.toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining('D:\\missing\\bash.exe'),
    });
  });
});
