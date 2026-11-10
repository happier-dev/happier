import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { withRealForegroundAdmissionFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';

import axios from 'axios';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';

import { readJsonEventually, writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAnthropicForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { bindNativeAgentLaunchPreparationFixture, createNativeAgentLaunchPreparationFixture } from './engineRegistry/nativeAgentSession.testkit';

describe('OpenCode ACP catalog-to-native conversation', () => {
  afterAll(() => pluginReloadController.shutdown());
  it('requires a model for the selected account, then prepares, replies, and resumes the native conversation', async () => {
    await withTempDir('happier-opencode-acp-journey-', async directory => {
      const capturePath = join(directory, 'native-capture.json');
      const conversationPath = join(directory, 'native-conversation.json');
      // Replace only the vendor process. The admitted plugin, ACP decoder,
      // launch preparation, host input admission and transcript adapters stay real.
      const source = `
        const { existsSync, readFileSync, writeFileSync } = require('node:fs');
        if (process.argv.includes('--version')) { process.stdout.write('1.0.0'); process.exit(0); }
        if (process.argv[2] === 'auth' && process.argv[3] === 'list') {
          const selected = process.env.ANTHROPIC_API_KEY === 'synthetic-selected-anthropic-key'
            || (process.env.OPENCODE_AUTH_CONTENT || '').includes('synthetic-selected-anthropic-key');
          process.stdout.write(selected ? '1 environment variable\\n' : '0 credentials\\n');
          process.exit(0);
        }
        const capturePath = ${JSON.stringify(capturePath)};
        const conversationPath = ${JSON.stringify(conversationPath)};
        const providerSessionId = 'opencode-acp-native-1';
        const observed = { argv: process.argv.slice(2), projectEnvironmentActive: process.env.NATIVE === 'active', selectedAccountMaterialized: (process.env.OPENCODE_AUTH_CONTENT || '').includes('synthetic-selected-anthropic-key'), methods: [], loadedSessionIds: [] };
        const models = { currentModelId: 'anthropic/claude-opus-5', availableModels: [{ modelId: 'anthropic/claude-opus-5', name: 'Selected account model' }] };
        const persist = () => writeFileSync(capturePath, JSON.stringify(observed));
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
        let conversation = [];
        let resumed = false;
        let buffer = '';
        persist();
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            if (!request.method) continue;
            observed.methods.push(request.method);
            persist();
            if (request.method === 'initialize') {
              ok(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
            } else if (request.method === 'session/new') {
              conversation = [];
              ok(request.id, { sessionId: providerSessionId, models,
                modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } });
            } else if (request.method === 'session/load') {
              if (request.params.sessionId !== providerSessionId || !existsSync(conversationPath)) {
                send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Native conversation missing' } });
                continue;
              }
              resumed = true;
              conversation = JSON.parse(readFileSync(conversationPath, 'utf8'));
              observed.loadedSessionIds.push(request.params.sessionId);
              persist();
              ok(request.id, { models });
            } else if (request.method === 'session/prompt') {
              conversation.push(request.params.prompt.filter(block => block.type === 'text').map(block => block.text).join(''));
              writeFileSync(conversationPath, JSON.stringify(conversation));
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
                  text: (resumed ? 'ACP_NATIVE_RESUMED:' : 'ACP_NATIVE_FIRST:') + conversation.join('|') } } } });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (request.id !== undefined) {
              ok(request.id, {});
            }
          }
        });
      `;
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'opencode-native.cjs', source });
      const executable = writeAcpTestAgentScript({
        dir: directory, fileName: process.platform === 'win32' ? 'opencode.cmd' : 'opencode.cjs',
        source: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!${process.execPath}\n${source}`,
      });
      chmodSync(executable, 0o755);
      const envScope = createEnvKeyScope(['PATH', resolveAgentCliOverrideEnvKey('opencode')]);
      envScope.patch({ PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` });
      let account: Awaited<ReturnType<typeof createAnthropicForegroundConnectedAccountFixture>> | undefined;
      try {
        account = await createAnthropicForegroundConnectedAccountFixture({
          pluginId: 'happier.agent.opencode', localId: 'opencode', purpose: 'anthropic-api-key',
        });
        const builtIns = resolveBuiltInContributions();
        await withRealForegroundAdmissionFixture({ createRuntime: ({ home, controller }) => createAdmittedPluginRuntimeFixture({
          happyHomeDir: home, controller,
          runtimeOptions: {
            ...account.runtimeOptions,
            pluginIds: ['happier.agent.opencode', account.service.pluginId],
            contributes: createResolvedContributionRegistry({ ...builtIns,
              systemTools: builtIns.systemTools?.map(tool => tool.pluginId === 'happier.agent.opencode'
                ? { ...tool, definition: { ...tool.definition, executableNames: [executable] } } : tool),
            }),
          },
        }) }, async foreground => {
          const accountGet = vi.mocked(axios.get).getMockImplementation();
          if (!accountGet) throw new Error('Selected Account HTTP boundary unavailable');
          const nativeLaunch = await createNativeAgentLaunchPreparationFixture();
          const launchDirectory = nativeLaunch.directory;
          vi.mocked(axios.get).mockImplementation((url, config) => {
            const path = new URL(String(url)).pathname;
            return path.startsWith('/v4/connect/') || path.startsWith('/v2/connect/') || path === '/v1/account/encryption'
              ? accountGet(url, config) : nativeLaunch.homeGet(url, config);
          });
          envScope.patch({ [resolveAgentCliOverrideEnvKey('opencode')]: executable });
          const dependencies = await account!.dependenciesFor(foreground.runtime.registry, launchDirectory);
          const prepareAndClaim = async (attemptId: string, selection?: NonNullable<Parameters<typeof foreground.prepare>[0]>['selection'], vendorResumeId?: string) => {
            const admission = await foreground.prepare({ attemptId, sessionId: 'host-opencode-acp-journey', directory: launchDirectory,
              agentId: 'opencode', backendTarget: { kind: 'backend', backendId: 'opencode' },
              connectedServices: account!.connectedServices, selection, ...(vendorResumeId ? { vendorResumeId } : {}),
            }, dependencies);
            if (!admission.ok) throw new Error(`OpenCode foreground admission refused: ${admission.error.code}: ${JSON.stringify(admission.error)}`);
            const claimed = await admission.prepared.claim({ canonicalSessionId: 'host-opencode-acp-journey', httpPort: 40123, foregroundSatisfiedProfileSecretRequirementNames: [] });
            if (!claimed.ok) throw new Error(`OpenCode foreground claim refused: ${claimed.error.code}`);
            return { prepared: admission.prepared, claimed };
          };
          const resolution = await resolveBackendEngineAdapterResolution('opencode', {
            runtimeRegistry: bindNativeAgentLaunchPreparationFixture(foreground.runtime.registry, nativeLaunch),
          });
          expect(resolution).toMatchObject({ agentId: 'opencode', selectedSource: 'plugin', agent: { pluginId: 'happier.agent.opencode' } });
          if (!resolution) throw new Error('OpenCode catalog resolution failed');
          const session = createMutableApiSessionClientFixture({ overrides: {
            sessionId: 'host-opencode-acp-journey',
            rpcHandlerManager: createRpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain' }),
          } });
          const params = {
            directory: launchDirectory, metadata: createTestMetadata({ path: launchDirectory }), machineId: 'machine-opencode-acp-journey',
            agentTargetKey: 'agent:happier.agent.opencode/opencode', session, transcriptSession: session,
            currentSessionPresentation: createCurrentSessionPresentationHost({ session, signal: new AbortController().signal }).bindCurrentSession,
            messageBuffer: new MessageBuffer(), mcpServers: {},
            permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[OpenCode ACP journey]' }),
            getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false, runnerProcessIdentity: null,
            startupModelSelection: null,
            runWithTerminalModelSelection: async effect => ({ status: 'completed', value: await effect(null,
              async localEffect => ({ status: 'completed', value: await localEffect() })) }),
          } satisfies HostSessionRuntimeFactoryParams;
          try {
            let launch = await prepareAndClaim('opencode-model-required');
            const unselectedEnvironment = { ...launch.claimed.environment, HAPPIER_OPENCODE_BACKEND_MODE: 'acp' };
            const unselectedPlan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({
              credentials: account!.credentials, directory: launchDirectory, backendTarget: { kind: 'backend', backendId: 'opencode' },
              permissionMode: 'default', environmentVariables: unselectedEnvironment,
              resolveLateEnvironment: async () => ({ environmentVariables: unselectedEnvironment, unsetEnvironmentVariables: [],
                sensitiveEnvironmentVariableNames: [], sessionConnectedAccounts: launch.claimed.sessionConnectedAccounts }),
              sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { opencodeBackendMode: { value: 'acp', updatedAt: 1 } } },
            });
            await expect(unselectedPlan.config.createSessionRuntime!(params)).rejects.toMatchObject({
              code: 'agent_startup_model_reconciliation_failed',
              details: { failureCause: { failureReason: 'model_selection_required' } },
            });
            expect(existsSync(capturePath)).toBe(false);
            const modelSelection = { v: 1, updatedAt: 1,
              ref: { agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: null, modelId: 'anthropic/claude-opus-5' } } as const;
            for (const kind of ['create', 'resume'] as const) {
              await launch.prepared.cleanup();
              launch = await prepareAndClaim(`opencode-${kind}`, modelSelection, kind === 'resume' ? 'opencode-acp-native-1' : undefined);
              const environmentVariables = { ...launch.claimed.environment, HAPPIER_OPENCODE_BACKEND_MODE: 'acp' };
              const sessionConnectedAccounts = launch.claimed.sessionConnectedAccounts;
              const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({
                credentials: account!.credentials,
                directory: launchDirectory, backendTarget: { kind: 'backend', backendId: 'opencode' }, permissionMode: 'default',
                modelSelection,
                environmentVariables,
                resolveLateEnvironment: async () => ({ environmentVariables, unsetEnvironmentVariables: [],
                  sensitiveEnvironmentVariableNames: [], sessionConnectedAccounts }),
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { opencodeBackendMode: { value: 'acp', updatedAt: 1 } } },
                ...(kind === 'resume' ? { resume: 'opencode-acp-native-1' } : {}),
              });
              const runtime = await plan.config.createSessionRuntime!(params);
              const events: unknown[] = [];
              const unsubscribe = runtime.operations.subscribeRuntimeEvents(event => events.push(event));
              try {
                const native = runtime.nativeRuntime as typeof runtime.nativeRuntime & { models?: AgentSessionModelsSource };
                await expect.poll(() => native.models?.read().currentModelId).toBe('anthropic/claude-opus-5');
                const initialCapture = await readJsonEventually<{ selectedAccountMaterialized: boolean; projectEnvironmentActive: boolean; methods: string[] }>(capturePath, { timeoutMs: 5_000 });
                expect(initialCapture.selectedAccountMaterialized).toBe(true);
                expect(initialCapture.projectEnvironmentActive).toBe(true);
                expect(initialCapture.methods).not.toContain('session/prompt');
                await runtime.operations.sendTurnPrompt(kind === 'create' ? 'hello' : 'follow up', {
                  localId: `opencode-${kind}`, userMessageSeq: kind === 'create' ? 1 : 2,
                });
                await runtime.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
                expect(events).toEqual(expect.arrayContaining([
                  expect.objectContaining({ kind: 'message-delta', text: kind === 'create' ? 'ACP_NATIVE_FIRST:hello' : 'ACP_NATIVE_RESUMED:hello|follow up' }),
                  expect.objectContaining({ kind: 'turn-complete' }),
                ]));
                const capture = await readJsonEventually<{ argv: string[]; selectedAccountMaterialized: boolean; projectEnvironmentActive: boolean; methods: string[]; loadedSessionIds: string[] }>(capturePath, { timeoutMs: 5_000 });
                expect(capture.selectedAccountMaterialized).toBe(true);
                expect(capture.projectEnvironmentActive).toBe(true);
                expect(capture.argv).toContain('acp');
                expect(capture.methods).toContain('session/prompt');
                expect(capture.loadedSessionIds).toEqual(kind === 'resume' ? ['opencode-acp-native-1'] : []);
                if (kind === 'resume') expect(capture.methods).not.toContain('session/new');
              } finally {
                unsubscribe();
                await runtime.operations.resetOrDisposeRuntime();
              }
            }
          } finally {
            await session.close();
          }
        });
      } catch (error) {
        let nativeCapture = 'native process did not publish a capture';
        try { nativeCapture = readFileSync(capturePath, 'utf8'); } catch {}
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${nativeCapture}`, { cause: error });
      } finally {
        await account?.cleanup();
        envScope.restore();
      }
    });
  }, 60_000);
});
