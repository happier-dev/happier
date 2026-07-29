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
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { resolveEngineRuntimeContribution } from './engineRegistry/contributions';

const AUGGIE_BACKEND_ID = 'auggie';
const AUGGIE_PLUGIN_ID = 'happier.agent.auggie';

function resolveGeneratedAuggieFixture() {
  const builtInContributions = resolveBuiltInContributions();
  const agentContribution = builtInContributions.agents.find((entry) => entry.id === AUGGIE_BACKEND_ID);
  const contributes = createResolvedContributionRegistry(builtInContributions);
  const backend = resolveEngineRuntimeContribution(contributes, AUGGIE_BACKEND_ID);
  const systemTools = builtInContributions.systemTools?.filter((entry) => entry.pluginId === AUGGIE_PLUGIN_ID) ?? [];
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === AUGGIE_PLUGIN_ID) ?? [];

  if (!agentContribution || !backend || systemTools.length !== 1 || activationTargets.length !== 1) {
    throw new Error('Expected generated Auggie Agent, runtime, system-tool, and activation target contributions');
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

describe('engineRegistry (auggie runtimeCore)', () => {
  it('resolves and opens the bundled Auggie native ACP runtime through production dispatch', async () => {
    await withTempDir('happier-auggie-native-consumer-', async (directory) => {
      const capturePath = join(directory, 'auggie-capture.json');
      const agentSource = `
          import { writeFileSync } from 'node:fs';

          const capturePath = ${JSON.stringify(capturePath)};
          const decoder = new TextDecoder();
          let buffer = '';
          let openedMcpServers = null;
          let selectedModel = null;
          const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
          const capture = () => writeFileSync(capturePath, JSON.stringify({
            args: process.argv.slice(2),
            environment: {
              auth: process.env.AUGMENT_SESSION_AUTH ?? null,
              keep: process.env.KEEP_ME ?? null,
              dropped: process.env.DROP_ME ?? null,
            },
            mcpServers: openedMcpServers,
            selectedModel,
          }));

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
                openedMcpServers = request.params.mcpServers;
                send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'provider-auggie-native-1' } });
              } else if (request.method === 'session/set_config_option') {
                if (request.params.configId === 'model') selectedModel = request.params.value;
                capture();
                send({ jsonrpc: '2.0', id: request.id, result: { configOptions: [] } });
              } else if (request.id !== undefined) {
                send({ jsonrpc: '2.0', id: request.id, result: {} });
              }
            }
          });
        `;
      const agentScriptPath = writeAcpTestAgentScript({
        dir: directory,
        fileName: 'auggie-agent.mjs',
        source: agentSource,
      });
      const systemToolExecutablePath = process.platform === 'win32'
        ? writeAcpTestAgentScript({
            dir: directory,
            fileName: 'auggie.cmd',
            source: `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`,
          })
        : writeAcpTestAgentScript({
            dir: directory,
            fileName: 'auggie',
            source: `#!${process.execPath}\n${agentSource}`,
          });
      chmodSync(systemToolExecutablePath, 0o755);

      const envScope = createEnvKeyScope(['DROP_ME']);
      envScope.patch({ DROP_ME: 'ambient-value-must-be-unset' });
      let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
      try {
        const fixture = resolveGeneratedAuggieFixture();
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes: fixture.contributes,
          happyHomeDir: join(directory, 'home'),
          pluginIds: [AUGGIE_PLUGIN_ID],
        });
        const systemToolDefinitions = runtimeRegistry.systemToolDefinitionsByPluginId?.get(AUGGIE_PLUGIN_ID);
        expect(systemToolDefinitions).toEqual([
          expect.objectContaining({
            id: 'auggie-cli',
            title: 'Auggie CLI',
            executableNames: ['auggie'],
          }),
        ]);
        if (!systemToolDefinitions) throw new Error('Expected activated Auggie system-tool definition');
        const runtimeRegistryWithProcessBoundary = Object.freeze({
          ...runtimeRegistry,
          systemToolDefinitionsByPluginId: new Map([
            ...(runtimeRegistry.systemToolDefinitionsByPluginId ?? new Map()),
            [AUGGIE_PLUGIN_ID, Object.freeze(systemToolDefinitions.map((definition) => Object.freeze({
              ...definition,
              executableNames: Object.freeze([systemToolExecutablePath]),
            })))],
          ]),
        });
        const resolution = await resolveBackendEngineAdapterResolution('auggie', {
          runtimeRegistry: runtimeRegistryWithProcessBoundary,
        });

        expect(resolution).toMatchObject({
          backendId: 'auggie',
          agentId: 'auggie',
          selectedSource: 'plugin',
          backend: {
            pluginId: 'happier.agent.auggie',
            daemonEntryPath: '@happier-dev/plugins-auggie',
          },
        });

        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
          credentials: createTestCredentials(),
          directory,
          backendTarget: { kind: 'backend', backendId: 'auggie' },
          environmentVariables: {
            AUGMENT_SESSION_AUTH: 'host-authorized-auth',
            KEEP_ME: 'host-authorized-value',
          },
          unsetEnvironmentVariables: ['DROP_ME'],
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 103,
          modelSelection: {
            v: 1,
            updatedAt: 102,
            ref: {
              agentTargetKey: 'backend:auggie',
              providerConnectionId: null,
              modelId: 'model-auggie-native',
            },
          },
          sessionConfigOptionOverrides: {
            v: 1,
            updatedAt: 104,
            overrides: {
              allowIndexing: { value: true, updatedAt: 104 },
            },
          },
        });

        expect(plan).toMatchObject({
          kind: 'hostSessionRuntimePlan',
          agentId: 'auggie',
          config: {
            backendDisplayName: 'Auggie CLI',
            providerName: 'Auggie CLI',
            agentMessageType: 'auggie',
          },
        });
        expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));

        const session = createMutableApiSessionClientFixture({
          overrides: {
            sessionId: 'host-auggie-native-1',
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
          machineId: 'machine-auggie-native',
          session,
          transcriptSession: session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {
            happier: { command: 'happier-mcp', args: ['serve'] },
          },
          permissionHandler: createProviderEnforcedPermissionHandler({
            session,
            logPrefix: '[Auggie native positive consumer]',
          }),
          getPermissionMode: () => 'default',
          setThinking: () => undefined,
          memoryRecallGuidanceEnabled: false,
        } satisfies HostSessionRuntimeFactoryParams;
        const created = await plan.config.createSessionRuntime!(runtimeParams);

        try {
          const capture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
            args: string[];
            environment: { auth: string | null; keep: string | null; dropped: string | null };
            mcpServers: unknown;
            selectedModel: string | null;
          };
          expect(capture.args).toEqual(expect.arrayContaining([
            '--acp',
            '--allow-indexing',
            '--permission',
            'save-file:allow',
            'launch-process:ask-user',
          ]));
          expect(capture.environment).toEqual({
            auth: 'host-authorized-auth',
            keep: 'host-authorized-value',
            dropped: null,
          });
          expect(capture.selectedModel).toBe('model-auggie-native');
          expect(capture.mcpServers).toEqual([
            { name: 'happier', command: 'happier-mcp', args: ['serve'], env: [] },
          ]);
        } finally {
          await created.operations.resetOrDisposeRuntime();
        }
      } finally {
        await runtimeRegistry?.dispose();
        envScope.restore();
      }
    });
  });
});
