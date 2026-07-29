import { chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';

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

const PI_BACKEND_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (pi runtimeCore)', () => {
  it('opens and dispatches the bundled Pi native runtime through the production registry', async () => {
    await withTempDir('happier-pi-native-consumer-', async (directory) => {
      const capturePath = join(directory, 'pi-capture.json');
      const agentSource = `
        const { writeFileSync } = require('node:fs');

        const capturePath = ${JSON.stringify(capturePath)};
        const decoder = new TextDecoder();
        let buffer = '';
        const commands = [];
        const capture = () => writeFileSync(capturePath, JSON.stringify({
          args: process.argv.slice(2),
          commands,
        }));
        const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
        capture();

        process.stdin.on('data', (chunk) => {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            commands.push(request.type);
            capture();
            if (request.type === 'get_state') {
              send({
                type: 'response',
                id: request.id,
                command: request.type,
                success: true,
                data: { sessionId: 'provider-pi-native-1' },
              });
            } else if (request.type === 'prompt') {
              send({ type: 'response', id: request.id, command: request.type, success: true });
              send({ type: 'agent_start' });
              send({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'PI_NATIVE_OK' },
              });
              send({ type: 'agent_end', willRetry: false });
            } else {
              send({ type: 'response', id: request.id, command: request.type, success: true });
            }
          }
        });
      `;
      const agentScriptPath = writeAcpTestAgentScript({
        dir: directory,
        fileName: 'pi-agent.cjs',
        source: agentSource,
      });
      const systemToolExecutablePath = process.platform === 'win32'
        ? writeAcpTestAgentScript({
            dir: directory,
            fileName: 'pi.cmd',
            source: `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`,
          })
        : writeAcpTestAgentScript({
            dir: directory,
            fileName: 'pi',
            // Match the real Pi launcher. The production system-tool owner must
            // pair JavaScript-backed executables with the managed JS runtime;
            // the plugin invocation itself intentionally receives no ambient PATH.
            source: `#!/usr/bin/env node\n${agentSource}`,
          });
      chmodSync(systemToolExecutablePath, 0o755);

      const builtInContributions = resolveBuiltInContributions();
      const envScope = createEnvKeyScope(['PATH']);
      envScope.patch({ PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` });
      let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
      try {
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes: createResolvedContributionRegistry(builtInContributions),
          happyHomeDir: join(directory, 'home'),
          pluginIds: [PI_PLUGIN_ID],
        });
        const systemToolDefinitions = runtimeRegistry.systemToolDefinitionsByPluginId?.get(PI_PLUGIN_ID);
        expect(systemToolDefinitions).toEqual([
          expect.objectContaining({ id: 'pi-cli', executableNames: ['pi'] }),
        ]);
        if (!systemToolDefinitions) throw new Error('Expected activated Pi system-tool definition');
        const runtimeRegistryWithProcessBoundary = Object.freeze({
          ...runtimeRegistry,
          systemToolDefinitionsByPluginId: new Map([
            ...(runtimeRegistry.systemToolDefinitionsByPluginId ?? new Map()),
            [PI_PLUGIN_ID, Object.freeze(systemToolDefinitions.map((definition) => Object.freeze({
              ...definition,
              executableNames: Object.freeze([systemToolExecutablePath]),
            })))],
          ]),
        });
        const resolution = await resolveBackendEngineAdapterResolution(PI_BACKEND_ID, {
          runtimeRegistry: runtimeRegistryWithProcessBoundary,
        });
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
          credentials: createTestCredentials(),
          directory,
          backendTarget: { kind: 'backend', backendId: PI_BACKEND_ID },
          permissionMode: 'safe-yolo',
          isolation: { env: { HAPPIER_PI_THINKING_LEVEL: 'high' } },
        });
        const session = createMutableApiSessionClientFixture({
          overrides: {
            sessionId: 'host-pi-native-1',
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
          machineId: 'machine-pi-native',
          session,
          transcriptSession: session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: createProviderEnforcedPermissionHandler({
            session,
            logPrefix: '[Pi native positive consumer]',
          }),
          getPermissionMode: () => 'default',
          setThinking: () => undefined,
          memoryRecallGuidanceEnabled: false,
        } satisfies HostSessionRuntimeFactoryParams;
        const created = await plan.config.createSessionRuntime!(runtimeParams);
        const nativeControls = created.nativeRuntime as typeof created.nativeRuntime & Readonly<{
          checkUsageLimitRecoveryNow(request: Readonly<{
            sessionId: string;
            resumePromptMode?: 'standard' | 'off' | 'custom';
          }>): Promise<unknown>;
        }>;
        const runtimeEvents: unknown[] = [];
        const unsubscribe = created.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

        try {
          await expect(readFileEventually(capturePath, { timeoutMs: 5_000 })).resolves.toContain('"commands":[]');
          await expect(nativeControls.checkUsageLimitRecoveryNow({
            sessionId: 'untrusted-session-id',
            resumePromptMode: 'custom',
          })).resolves.toEqual({
            status: 'waiting',
            retryAfterMs: 600_000,
          });
          await expect(created.operations.sendTurnPrompt('hello', {
            localId: 'pi-input-1',
            userMessageSeq: 1,
          })).resolves.toBeUndefined();
          await expect(created.operations.waitForTurnCompletion({ timeoutMs: 5_000 })).resolves.toBeUndefined();
          const capture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
            args: string[];
            commands: string[];
          };
          expect(capture.args).toEqual(expect.arrayContaining(['--mode', 'rpc']));
          expect(capture.commands).toEqual(['get_state', 'prompt']);
          expect(runtimeEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
              kind: 'message-delta',
              delta: expect.objectContaining({ text: 'PI_NATIVE_OK' }),
            }),
            expect.objectContaining({ kind: 'turn-complete' }),
          ]));
        } finally {
          unsubscribe();
          await created.operations.resetOrDisposeRuntime();
        }
      } finally {
        await runtimeRegistry?.dispose();
        envScope.restore();
      }
    });
  });
});
