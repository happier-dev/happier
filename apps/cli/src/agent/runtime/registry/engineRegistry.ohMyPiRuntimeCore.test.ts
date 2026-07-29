import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readFileEventually, writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Credentials } from '@/persistence';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { resolveEngineRuntimeContribution } from './engineRegistry/contributions';

const OH_MY_PI_AGENT_ID = 'ohMyPi';
const OH_MY_PI_PLUGIN_ID = 'happier.agent.ohmypi';

function resolveGeneratedOhMyPiFixture(systemToolExecutablePath: string) {
  const builtInContributions = resolveBuiltInContributions();
  const agentContribution = builtInContributions.agents.find(
    (entry) => entry.id === OH_MY_PI_AGENT_ID,
  );
  const contributes = createResolvedContributionRegistry({
    ...builtInContributions,
    activationTargets: builtInContributions.activationTargets?.map((target) => (
      target.pluginId === OH_MY_PI_PLUGIN_ID
        ? {
            ...target,
            manifest: {
              ...target.manifest,
              contributes: {
                ...target.manifest.contributes,
                systemTools: (target.manifest.contributes.systemTools ?? []).map((tool) => ({
                  ...tool,
                  executableNames: [systemToolExecutablePath],
                })),
              },
            },
          }
        : target
    )),
    systemTools: builtInContributions.systemTools?.map((tool) => (
      tool.pluginId === OH_MY_PI_PLUGIN_ID
        ? {
            ...tool,
            definition: {
              ...tool.definition,
              executableNames: [systemToolExecutablePath],
            },
          }
        : tool
    )),
  });
  const backend = resolveEngineRuntimeContribution(contributes, OH_MY_PI_AGENT_ID);
  const systemTools = builtInContributions.systemTools?.filter(
    (entry) => entry.pluginId === OH_MY_PI_PLUGIN_ID,
  ) ?? [];

  if (!agentContribution || !backend || systemTools.length !== 1) {
    throw new Error('Expected generated OhMyPi Agent, runtime, and system-tool contributions');
  }

  return Object.freeze({
    agentContribution,
    backend,
    contributes,
  });
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

describe('engineRegistry (OhMyPi runtimeCore)', () => {
  it('resolves and opens the bundled native ACP runtime through production dispatch', async () => {
    await withTempDir('happier-ohmypi-native-consumer-', async (directory) => {
      const capturePath = join(directory, 'ohmypi-capture.json');
      const agentSource = `
        import { writeFileSync } from 'node:fs';

        const capturePath = ${JSON.stringify(capturePath)};
        const decoder = new TextDecoder();
        let buffer = '';
        const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

        process.stdin.on('data', (chunk) => {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            if (request.method === 'initialize') {
              send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: [] } });
            } else if (request.method === 'session/new') {
              writeFileSync(capturePath, JSON.stringify({
                args: process.argv.slice(2),
                mcpServers: request.params.mcpServers,
              }));
              send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'provider-ohmypi-native-1' } });
            } else if (request.id !== undefined) {
              send({ jsonrpc: '2.0', id: request.id, result: {} });
            }
          }
        });
      `;
      const agentScriptPath = writeAcpTestAgentScript({
        dir: directory,
        fileName: 'ohmypi-agent.mjs',
        source: agentSource,
      });
      const systemToolExecutablePath = process.platform === 'win32'
        ? writeAcpTestAgentScript({
            dir: directory,
            fileName: 'omp.cmd',
            source: `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`,
          })
        : writeAcpTestAgentScript({
            dir: directory,
            fileName: 'omp',
            source: `#!${process.execPath}\n${agentSource}`,
          });
      chmodSync(systemToolExecutablePath, 0o755);

      let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
      try {
        const fixture = resolveGeneratedOhMyPiFixture(systemToolExecutablePath);
        expect(fixture.agentContribution).toMatchObject({
          id: 'ohMyPi',
          identity: {
            pluginId: OH_MY_PI_PLUGIN_ID,
            localId: 'ohmypi',
          },
        });
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes: fixture.contributes,
          happyHomeDir: join(directory, 'home'),
          pluginIds: [OH_MY_PI_PLUGIN_ID],
        });
        const systemToolDefinitions = runtimeRegistry.systemToolDefinitionsByPluginId?.get(
          OH_MY_PI_PLUGIN_ID,
        );
        expect(systemToolDefinitions).toEqual([
          expect.objectContaining({
            id: 'ohmypi-cli',
            title: 'Oh My Pi CLI',
            executableNames: [systemToolExecutablePath],
          }),
        ]);
        if (!systemToolDefinitions) {
          throw new Error('Expected activated OhMyPi system-tool definition');
        }
        const resolution = await resolveBackendEngineAdapterResolution(OH_MY_PI_AGENT_ID, {
          runtimeRegistry,
        });

        expect(resolution).toMatchObject({
          backendId: 'ohMyPi',
          agentId: 'ohMyPi',
          selectedSource: 'plugin',
          backend: {
            pluginId: OH_MY_PI_PLUGIN_ID,
            daemonEntryPath: '@happier-dev/plugins-ohmypi',
          },
        });
        expect(resolution?.diagnostics).toEqual([]);

        const missingNativeOwner = await resolveBackendEngineAdapterResolution(
          OH_MY_PI_AGENT_ID,
          {
            runtimeRegistry: Object.freeze({
              ...runtimeRegistry,
              agentRuntimesByAgentId: new Map(),
            }),
          },
        );
        expect(missingNativeOwner?.runtimeOwner).toMatchObject({
          selected: null,
          candidates: [],
        });
        await expect(
          missingNativeOwner!.engineAdapter.runtimeCore.createSessionRuntime({}),
        ).rejects.toThrow("Backend 'ohMyPi' is missing bound host runtimeCore");

        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
          credentials: createTestCredentials(),
          directory,
          backendTarget: { kind: 'backend', backendId: OH_MY_PI_AGENT_ID },
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 1,
        });
        expect(plan).toMatchObject({
          kind: 'hostSessionRuntimePlan',
          agentId: 'ohMyPi',
        });

        const session = createMutableApiSessionClientFixture({
          overrides: {
            sessionId: 'host-ohmypi-native-1',
            rpcHandlerManager: createRpcHandlerManager({
              scopePrefix: 'session',
              encryptionKey: new Uint8Array(32),
              encryptionVariant: 'legacy',
              encryptionMode: 'plain',
            }),
          },
        });
        const runtimeParams = {
          directory,
          metadata: createTestMetadata({ path: directory }),
          machineId: 'machine-ohmypi-native',
          session,
          transcriptSession: session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: createProviderEnforcedPermissionHandler({
            session,
            logPrefix: '[OhMyPi native positive consumer]',
          }),
          getPermissionMode: () => 'default',
          setThinking: () => undefined,
          memoryRecallGuidanceEnabled: false,
        } satisfies HostSessionRuntimeFactoryParams;
        const created = await plan.config.createSessionRuntime!(runtimeParams);

        try {
          const capture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
            args: string[];
            mcpServers: unknown;
          };
          expect(capture.args).toEqual(['--mode', 'acp']);
          expect(capture.mcpServers).toEqual([]);
        } finally {
          await created.operations.resetOrDisposeRuntime();
        }
      } finally {
        await runtimeRegistry?.dispose();
      }
    });
  });
});
