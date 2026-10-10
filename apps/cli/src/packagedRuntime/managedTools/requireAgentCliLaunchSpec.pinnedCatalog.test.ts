import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { requireAgentCliCommand } from './requireAgentCliCommand';
import { requireAgentCliLaunchSpec } from './requireAgentCliLaunchSpec';

function pinnedCatalog() {
  const agent = projectManifestAgentContribution({
    pluginId: 'acme.pinned-launch', provenance: 'external', source: { kind: 'path' },
    definition: PluginAgentContributionV2Schema.parse({
      id: 'agent', title: 'Pinned Agent', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      cli: {
        executable: { binaryName: 'pinned-agent', sourcePreference: 'system-first', knownUserBinDirSuffixes: null },
        install: { managed: null, manual: { kind: 'none' } },
        auth: { support: 'status_only', environmentVariables: ['PINNED_AGENT_KEY'], loginLaunches: [] },
      },
    }),
  });
  return { agent, catalogSnapshot: createResolvedContributionRegistry({ agents: [agent], activationTargets: [] }) };
}

describe('Agent CLI resolution from the admitted catalog', () => {
  beforeAll(async () => {
    // Publish an actual current registry without this retained external Agent.
    // No plugin is activated: unused plugin callbacks are outside this lookup contract.
    const currentRegistry = {
      contributes: createResolvedContributionRegistry({ agents: [], activationTargets: [] }),
      hookHandlersByHookId: new Map(), agentRuntimesByAgentId: new Map(), scmHostingProvidersById: new Map(),
      pluginDiagnosticsByPluginId: {}, activatedPluginIds: new Set<string>(),
      resolveCaptureSource: unexpectedCaptureSourceResolution,
      resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
      activateContributionsOnDemand: async () => [], resolvePromptAssetBlocks: async () => [],
      createAgentInvocationServices: async () => { throw new Error('No plugin invocation in this catalog fixture'); },
      retireConsumers: () => {}, dispose: async () => {},
    } satisfies ResolvedExecutablePluginRuntimeRegistry;
    await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry: currentRegistry, changedPluginIds: [], isDevelopmentCandidateCurrent: () => true,
      runningSessionDisposition: 'retainRunningSessions',
    });
  });
  afterAll(async () => { await pluginReloadController.shutdown(); });

  it('resolves a real external executable from the supplied catalog for both launch and command callers', () => {
    const home = createTempDirSync('happier-pinned-agent-cli-');
    try {
      const { agent, catalogSnapshot } = pinnedCatalog();
      const cli = writeExecutableShimSync({
        dir: home, fileName: process.platform === 'win32' ? 'pinned-agent.exe' : 'pinned-agent',
        contents: 'fixture native executable',
      });
      const options = { catalogSnapshot, processEnv: { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home } };
      expect(requireAgentCliLaunchSpec(agent.id, options)).toEqual({
        source: 'system', resolvedPath: cli, command: cli, args: [],
      });
      expect(requireAgentCliCommand(agent.id, options)).toBe(cli);
    } finally {
      removeTempDirSync(home);
    }
  });

  it('reports a missing executable using the same admitted catalog rather than the current global registry', () => {
    const home = createTempDirSync('happier-pinned-agent-missing-');
    try {
      const { agent, catalogSnapshot } = pinnedCatalog();
      const options = { catalogSnapshot, processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home } };
      expect(() => requireAgentCliLaunchSpec(agent.id, options)).toThrow(ReferenceError);
      expect(() => requireAgentCliCommand(agent.id, options)).toThrow(/not available from any configured source/);
      for (const requireCli of [requireAgentCliCommand, requireAgentCliLaunchSpec]) {
        let failure: unknown;
        try { requireCli(agent.id, options); } catch (error) { failure = error; }
        const issue = classifyPrimarySessionRuntimeIssue({
          cause: 'status_error',
          error: sanitizeNativeAgentSessionBoundaryError(failure, true),
          occurredAt: 1_000,
        });
        expect(issue).toMatchObject({ code: 'agent_cli_missing', source: 'dependency_failure' });
        expect(issue.sanitizedPreview).toMatch(/install.*CLI|CLI.*install/iu);
        expect(issue.sanitizedPreview).not.toContain(agent.id);
        expect(issue.sanitizedPreview).not.toContain(home);
      }

    } finally {
      removeTempDirSync(home);
    }
  });
});
