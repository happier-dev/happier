import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { accountSettingsParse } from '@happier-dev/protocol';
import { withRealForegroundAdmissionFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';

import axios from 'axios';
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';

import { readFileEventually, writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAnthropicForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { currentSessionHolderScope, readSessionAgentTreeRoots } from '@/subprocess/supervision/sessionHolder';
import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../../../../packages/plugins/pi/src/agent/sessionFileStoreDescriptor';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { bindNativeAgentLaunchPreparationFixture, createNativeAgentJourneyTranscriptFixture, createNativeAgentLaunchPreparationFixture } from './engineRegistry/nativeAgentSession.testkit';

const PI_BACKEND_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

describe('engineRegistry (pi runtimeCore)', () => {
  afterAll(() => pluginReloadController.shutdown());
  it('prepares the catalog-selected Pi launch, changes model, stops, and resumes the native boundary fixture', async () => {
    await withTempDir('happier-pi-native-consumer-', async (directory) => {
      const capturePath = join(directory, 'pi-capture.json');
      const conversationPath = join(directory, 'pi-conversation.json');
      // OS-boundary fixture recorded from Pi 1.5.0, QA A's own Muse source,
      // r1112u. Provenance and the anonymization are retained with the frames.
      const recorded = JSON.parse(readFileSync(new URL(
        '../../../../../../packages/plugins/pi/src/agent/transcripts/__fixtures__/pi-rpc-own-muse-1.5.0.json', import.meta.url,
      ), 'utf8')) as { toolCall: Record<string, unknown>; toolResult: Record<string, unknown>; settled: Record<string, unknown> };
      const recordedTool = { call: recorded.toolCall, result: recorded.toolResult };
      const agentSource = (launchDirectory: string) => `
        const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        if (process.argv.includes('--version')) { process.stdout.write('1.5.0'); process.exit(0); }

        const capturePath = ${JSON.stringify(capturePath)};
        const conversationPath = ${JSON.stringify(conversationPath)};
        const resumed = process.argv.includes('--session');
        if (resumed && process.argv[process.argv.indexOf('--session') + 1] !== 'provider-pi-native-1') process.exit(81);
        if (resumed && !existsSync(conversationPath)) process.exit(82);
        const retained = resumed ? JSON.parse(readFileSync(conversationPath, 'utf8')) : { prompts: [], tool: null };
        const conversation = retained.prompts;
        const recordedTool = ${JSON.stringify(recordedTool)};
        let model = { provider: 'anthropic', id: 'native-default' };
        const decoder = new TextDecoder();
        let buffer = '';
        const commands = [];
        const requests = [];
        const capture = () => writeFileSync(capturePath, JSON.stringify({
          args: process.argv.slice(2),
          pid: process.pid,
          selectedAccountMaterialized: process.env.ANTHROPIC_API_KEY === 'synthetic-selected-anthropic-key',
          commands,
          requests,
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
            requests.push(request);
            capture();
            if (request.type === 'set_model' && request.modelId === 'reject-initial-model') {
              send({
                type: 'response',
                id: request.id,
                command: request.type,
                success: false,
                error: 'model unavailable',
              });
            } else if (request.type === 'get_state') {
              send({
                type: 'response',
                id: request.id,
                command: request.type,
                success: true,
                data: { sessionId: 'provider-pi-native-1', model },
              });
            } else if (request.type === 'prompt') {
              if (request.message === 'wait for stop') {
                send({ type: 'response', id: request.id, command: request.type, success: true });
                send({ type: 'agent_start' });
                continue;
              }
              conversation.push(request.message);
              if (!resumed) retained.tool = recordedTool;
              const root = join(process.env.PI_CODING_AGENT_DIR, 'sessions', ${JSON.stringify(PI_SESSION_FILE_STORE_DESCRIPTOR_V1.encodeCwdSubdir(launchDirectory))});
              mkdirSync(root, { recursive: true });
              writeFileSync(join(root, '2026-11-10T00-00-00_provider-pi-native-1.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'provider-pi-native-1', timestamp: '2026-11-10T00:00:00.000Z', cwd: process.cwd() }) + '\\n');
              writeFileSync(conversationPath, JSON.stringify(retained));
              send({ type: 'response', id: request.id, command: request.type, success: true });
              send({ type: 'agent_start' });
              if (!resumed) {
                send(recordedTool.call);
                send(recordedTool.result);
              }
              send({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: resumed ? 'PI_NATIVE_RESUMED:' + conversation.join('|') + ':' + retained.tool.result.result.content[0].text : 'PI_NATIVE_OK' },
              });
              // Pi 1.5.0 emits agent_end without willRetry, then agent_settled.
              // The captured messages are omitted because this boundary tests
              // streamed tool projection rather than full vendor history import.
              send({ type: 'agent_end', messages: [] });
              send(${JSON.stringify(recorded.settled)});
            } else if (request.type === 'abort') {
              send({ type: 'response', id: request.id, command: request.type, success: true });
              send({ type: 'agent_end', willRetry: false });
            } else {
              if (request.type === 'set_model') model = { provider: request.provider, id: request.modelId };
              send({ type: 'response', id: request.id, command: request.type, success: true });
            }
          }
        });
      `;
      const agentScriptPath = writeAcpTestAgentScript({
        dir: directory,
        fileName: 'pi-agent.cjs',
        source: agentSource(directory),
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
            source: `#!/usr/bin/env node\n${agentSource(directory)}`,
          });
      chmodSync(systemToolExecutablePath, 0o755);

      const builtInContributions = resolveBuiltInContributions();
      const envScope = createEnvKeyScope(['PATH', 'PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', resolveAgentCliOverrideEnvKey(PI_BACKEND_ID)]);
      const nativeHome = join(directory, 'native-home');
      mkdirSync(nativeHome, { recursive: true });
      envScope.patch({ PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`, PI_CODING_AGENT_DIR: nativeHome,
        ANTHROPIC_API_KEY: undefined });
      try {
        const account = await createAnthropicForegroundConnectedAccountFixture({
          pluginId: PI_PLUGIN_ID, localId: PI_BACKEND_ID, purpose: 'anthropic-api-key',
        });
        onTestFinished(() => account.cleanup());
        await withRealForegroundAdmissionFixture({ createRuntime: ({ home, controller }) => createAdmittedPluginRuntimeFixture({
          happyHomeDir: home, controller,
          runtimeOptions: {
            ...account.runtimeOptions,
            contributes: createResolvedContributionRegistry({ ...builtInContributions,
              systemTools: builtInContributions.systemTools?.map(tool => tool.pluginId === PI_PLUGIN_ID
                ? { ...tool, definition: { ...tool.definition, executableNames: [systemToolExecutablePath] } } : tool),
            }),
            pluginIds: [PI_PLUGIN_ID, account.service.pluginId],
          },
        }) }, async foreground => {
          envScope.patch({ [resolveAgentCliOverrideEnvKey(PI_BACKEND_ID)]: systemToolExecutablePath });
          const rawSettings = { connectedServicesProviderStateSharingSettingsV1: {
            v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' },
            byAgentId: { pi: { stateMode: 'shared' } },
            acknowledgedRisksByAgentId: { pi: { sharedStatePrivacy: true } },
          } };
          setActiveAccountSettingsSnapshot({ source: 'cache', settings: accountSettingsParse(rawSettings), rawSettings,
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
          const accountGet = vi.mocked(axios.get).getMockImplementation();
          if (!accountGet) throw new Error('Selected Account HTTP boundary unavailable');
          const nativeLaunch = await createNativeAgentLaunchPreparationFixture();
          const launchDirectory = nativeLaunch.directory;
          // The vendor fixture persists under the actual associated workspace,
          // using the same public file-store descriptor as resume discovery.
          writeFileSync(agentScriptPath, agentSource(launchDirectory));
          if (process.platform !== 'win32') writeFileSync(systemToolExecutablePath, `#!/usr/bin/env node\n${agentSource(launchDirectory)}`);
          // The Project fixture owns Home reads; Connected Account transport keeps
          // its separately captured boundary implementation.
          vi.mocked(axios.get).mockImplementation((url, config) => {
            const path = new URL(String(url)).pathname;
            return path.startsWith('/v4/connect/') || path.startsWith('/v2/connect/') || path === '/v1/account/encryption'
              ? accountGet(url, config) : nativeLaunch.homeGet(url, config);
          });
          const transcript = await createNativeAgentJourneyTranscriptFixture('pi');
          onTestFinished(() => transcript.close());
          const runtimeRegistry = bindNativeAgentLaunchPreparationFixture(foreground.runtime.registry, nativeLaunch);
          const dependencies = await account.dependenciesFor(runtimeRegistry, launchDirectory);
          const prepareAndClaim = async (attemptId: string, selection?: NonNullable<Parameters<typeof foreground.prepare>[0]>['selection'], vendorResumeId?: string) => {
            const admission = await foreground.prepare({ attemptId, sessionId: transcript.sessionId, directory: launchDirectory,
              agentId: PI_BACKEND_ID, backendTarget: { kind: 'backend', backendId: PI_BACKEND_ID },
              connectedServices: account.connectedServices, selection, ...(vendorResumeId ? { vendorResumeId } : {}),
            }, dependencies);
            if (!admission.ok) throw new Error(`Pi foreground admission refused: ${admission.error.code}: ${JSON.stringify(admission.error)}`);
            const claimed = await admission.prepared.claim({ canonicalSessionId: transcript.sessionId, httpPort: 40123, foregroundSatisfiedProfileSecretRequirementNames: [] });
            if (!claimed.ok) throw new Error(`Pi foreground claim refused: ${claimed.error.code}`);
            expect(claimed.environment.PI_CODING_AGENT_DIR).toBeTruthy();
            return { prepared: admission.prepared, claimed };
          };
          const resolution = await resolveBackendEngineAdapterResolution(PI_BACKEND_ID, {
            runtimeRegistry,
          });
          expect(resolution?.agent.id).toBe(PI_BACKEND_ID);
          const modelSelection = {
            v: 1, updatedAt: 42,
            ref: { agentTargetKey: 'agent:happier.agent.pi/pi', providerConnectionId: null, modelId: 'anthropic/claude-opus-5' },
          } as const;
          let launch = await prepareAndClaim('pi-create', modelSelection);
          const launchAuthentication = () => ({
            environmentVariables: launch.claimed.environment,
            resolveLateEnvironment: async () => ({ environmentVariables: launch.claimed.environment, unsetEnvironmentVariables: [],
              sensitiveEnvironmentVariableNames: [], sessionConnectedAccounts: launch.claimed.sessionConnectedAccounts }),
          });
          const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
            credentials: account.credentials,
            directory: launchDirectory,
            backendTarget: { kind: 'backend', backendId: PI_BACKEND_ID },
            permissionMode: 'safe-yolo',
            ...launchAuthentication(), modelSelection,
            isolation: { env: { HAPPIER_PI_THINKING_LEVEL: 'high' } },
          });
          const session = transcript.client;
          const runtimeParams = {
            directory: launchDirectory,
            metadata: createTestMetadata({ path: launchDirectory }),
            machineId: 'machine-pi-native',
            agentTargetKey: 'agent:happier.agent.pi/pi',
            session,
            transcriptSession: session,
            currentSessionPresentation: createCurrentSessionPresentationHost({ session, signal: new AbortController().signal }).bindCurrentSession,
            messageBuffer: new MessageBuffer(),
            mcpServers: {},
            permissionHandler: createProviderEnforcedPermissionHandler({
              session,
              logPrefix: '[Pi native positive consumer]',
            }),
            getPermissionMode: () => 'default',
            memoryRecallGuidanceEnabled: false,
            runnerProcessIdentity: null,
            startupModelSelection: null,
            runWithTerminalModelSelection: async (effect) => ({
              status: 'completed',
              value: await effect(null, async (localEffect) => ({
                status: 'completed',
                value: await localEffect(),
              })),
            }),
          } satisfies HostSessionRuntimeFactoryParams;
          const created = await plan.config.createSessionRuntime!(runtimeParams);
          const runtimeEvents: unknown[] = [];
          const unsubscribe = created.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
          const stopTranscript = transcript.observe(created.operations);

          try {
            const initialCapture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
              pid: number;
              commands: string[];
              selectedAccountMaterialized: boolean;
              requests: Array<Readonly<Record<string, unknown>>>;
            };
            expect(initialCapture.commands).not.toContain('prompt');
            // Pi roots this Session's Agent tree, so the Session MCP endpoint admits its Happier
            // tools bridge by kernel peer proof (S2-MCP-AUTH-01: refused as not_authenticated).
            expect(readSessionAgentTreeRoots(currentSessionHolderScope()).agentPids).toContain(initialCapture.pid);
            expect(initialCapture.selectedAccountMaterialized).toBe(true);
            expect(initialCapture.requests.filter(request => request.type === 'set_model')).toEqual([
              expect.objectContaining({ type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5' }),
            ]);
            expect(created.nativeRuntime).not.toHaveProperty('checkUsageLimitRecoveryNow');
            await expect(created.operations.sendTurnPrompt('hello', {
              localId: 'pi-input-1',
              userMessageSeq: 1,
            })).resolves.toBeUndefined();
            await expect(created.operations.waitForTurnCompletion({ timeoutMs: 5_000 })).resolves.toBeUndefined();
            const capture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
              args: string[];
              commands: string[];
              requests: Array<Readonly<Record<string, unknown>>>;
            };
            expect(capture.args).toEqual(expect.arrayContaining(['--mode', 'rpc']));
            expect(capture.commands.filter(command => command === 'set_model' || command === 'prompt')).toEqual(['set_model', 'prompt']);
            expect(capture.requests.find(request => request.type === 'set_model')).toEqual(expect.objectContaining({
              type: 'set_model',
              provider: 'anthropic',
              modelId: 'claude-opus-5',
            }));
            expect(runtimeEvents).toEqual(expect.arrayContaining([
              expect.objectContaining({
                kind: 'message-delta',
                text: 'PI_NATIVE_OK',
              }),
              expect.objectContaining({ kind: 'turn-complete' }),
              expect.objectContaining({ kind: 'tool-call', toolCallId: 'pi-recorded-bash' }),
              expect.objectContaining({ kind: 'tool-result', toolCallId: 'pi-recorded-bash' }),
            ]));
            // This is the simulated vendor file, not host-loop transcript persistence.
            expect(JSON.parse(readFileSync(conversationPath, 'utf8'))).toEqual({ prompts: ['hello'], tool: recordedTool });
            await transcript.drain();
            expect(await transcript.readTranscript()).toEqual(expect.arrayContaining([
              expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({ content: expect.objectContaining({
                data: expect.objectContaining({ type: 'tool-call', callId: 'pi-recorded-bash' }),
              }) }) } }),
              expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({ content: expect.objectContaining({
                data: expect.objectContaining({ type: 'tool-result', callId: 'pi-recorded-bash' }),
              }) }) } }),
            ]));
            await expect(created.operations.updateSessionRuntimeConfig({ modelId: 'anthropic/claude-sonnet-5' }))
              .resolves.toMatchObject({ status: 'applied' });
            const native = created.nativeRuntime as typeof created.nativeRuntime & { models?: AgentSessionModelsSource };
            await expect.poll(() => native.models?.read().currentModelId).toBe('anthropic/claude-sonnet-5');
            await created.operations.sendTurnPrompt('wait for stop', { localId: 'pi-stop-input', userMessageSeq: 2 });
            await created.operations.cancelTurn();
            await created.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
            expect(runtimeEvents).toEqual(expect.arrayContaining([
              expect.objectContaining({ kind: 'turn-cancelled', cause: 'user' }),
            ]));
            const stopped = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
              commands: string[]; requests: Array<Readonly<Record<string, unknown>>>;
            };
            expect(stopped.commands).toContain('abort');
            expect(stopped.requests.filter(request => request.type === 'set_model')).toEqual([
              expect.objectContaining({ provider: 'anthropic', modelId: 'claude-opus-5' }),
              expect.objectContaining({ provider: 'anthropic', modelId: 'claude-sonnet-5' }),
            ]);
            // A model/settings transition replaces the native runtime inside
            // the existing plan rather than composing a new cold-resume plan.
            await created.operations.resetOrDisposeRuntime('mode_change', {
              kind: 'resume', providerSessionId: 'provider-pi-native-1', importHistory: false,
            });
            await created.operations.sendTurnPrompt('wait for stop', { localId: 'pi-reopened-stop-input', userMessageSeq: 3 });
            await created.operations.cancelTurn();
            await created.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
            const reopened = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
              pid: number; args: string[]; commands: string[];
            };
            expect(reopened.pid).not.toBe(initialCapture.pid);
            expect(reopened.args).toEqual(expect.arrayContaining(['--session', 'provider-pi-native-1']));
            expect(reopened.commands).toEqual(expect.arrayContaining(['prompt', 'abort']));
          } finally {
            unsubscribe();
            stopTranscript();
            await created.operations.resetOrDisposeRuntime();
          }

          await launch.prepared.cleanup();
          // Native discovery must retain the first Session in the cold shared
          // home after the materialized launch retires, independently of the
          // fixture's separate conversation response file.
          const retainedNativeSession = join(nativeHome, 'sessions',
            PI_SESSION_FILE_STORE_DESCRIPTOR_V1.encodeCwdSubdir(launchDirectory),
            '2026-11-10T00-00-00_provider-pi-native-1.jsonl');
          expect(JSON.parse((await readFileEventually(retainedNativeSession, { timeoutMs: 5_000 })).trim()))
            .toMatchObject({ type: 'session', id: 'provider-pi-native-1', cwd: launchDirectory });
          const retainedSelection = { ...modelSelection,
            ref: { ...modelSelection.ref, modelId: 'anthropic/claude-sonnet-5' } };
          launch = await prepareAndClaim('pi-resume', retainedSelection, 'provider-pi-native-1');
          const resumedPlan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
            credentials: account.credentials,
            directory: launchDirectory,
            backendTarget: { kind: 'backend', backendId: PI_BACKEND_ID },
            resume: 'provider-pi-native-1',
            permissionMode: 'safe-yolo',
            ...launchAuthentication(), modelSelection: retainedSelection,
          });
          const resumed = await resumedPlan.config.createSessionRuntime!(runtimeParams);
          const resumedEvents: unknown[] = [];
          const unsubscribeResumed = resumed.operations.subscribeRuntimeEvents(event => resumedEvents.push(event));
          try {
            await resumed.operations.sendTurnPrompt('follow up', { localId: 'pi-input-2', userMessageSeq: 2 });
            await resumed.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
            const resumedCapture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as {
              args: string[];
              selectedAccountMaterialized: boolean;
              requests: Array<Readonly<Record<string, unknown>>>;
            };
            expect(resumedCapture.args).toEqual(expect.arrayContaining(['--session', 'provider-pi-native-1']));
            expect(resumedCapture.selectedAccountMaterialized).toBe(true);
            expect(resumedCapture.requests.filter(request => request.type === 'set_model')).toEqual([
              expect.objectContaining({ provider: 'anthropic', modelId: 'claude-sonnet-5' }),
            ]);
            expect(resumedEvents).toEqual(expect.arrayContaining([
              expect.objectContaining({ kind: 'message-delta', text: 'PI_NATIVE_RESUMED:hello|follow up:RECORDED_PI_TEXT' }),
              expect.objectContaining({ kind: 'turn-complete' }),
            ]));
          } finally {
            unsubscribeResumed();
            await resumed.operations.resetOrDisposeRuntime();
          }

          await launch.prepared.cleanup();
          launch = await prepareAndClaim('pi-default');
          const defaultPlan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
            credentials: account.credentials, directory: launchDirectory,
            backendTarget: { kind: 'backend', backendId: PI_BACKEND_ID }, permissionMode: 'safe-yolo',
            ...launchAuthentication(),
          });
          const nativeDefault = await defaultPlan.config.createSessionRuntime!(runtimeParams);
          try {
            const native = nativeDefault.nativeRuntime as typeof nativeDefault.nativeRuntime & { models?: AgentSessionModelsSource };
            await expect.poll(() => native.models?.read().currentModelId).toBe('anthropic/native-default');
            const capture = JSON.parse(await readFileEventually(capturePath, { timeoutMs: 5_000 })) as { commands: string[] };
            expect(capture.commands).not.toContain('set_model');
            expect(capture.commands).not.toContain('prompt');
          } finally {
            await nativeDefault.operations.resetOrDisposeRuntime();
          }

          const rejectedPlan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
            credentials: account.credentials,
            directory: launchDirectory,
            backendTarget: { kind: 'backend', backendId: PI_BACKEND_ID },
            permissionMode: 'safe-yolo',
            ...launchAuthentication(),
            modelSelection: {
              v: 1,
              updatedAt: 43,
              ref: {
                agentTargetKey: 'agent:happier.agent.pi/pi',
                providerConnectionId: null,
                modelId: 'anthropic/reject-initial-model',
              },
            },
          });
          const rejectedSession = createMutableApiSessionClientFixture({
            overrides: {
              sessionId: 'host-pi-native-rejected',
              rpcHandlerManager: createRpcHandlerManager({
                scopePrefix: 'session',
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
                encryptionMode: 'plain',
              }),
            },
          });
          onTestFinished(() => rejectedSession.close());
          await expect(rejectedPlan.config.createSessionRuntime!({
            ...runtimeParams,
            session: rejectedSession,
            transcriptSession: rejectedSession,
            currentSessionPresentation: createCurrentSessionPresentationHost({ session: rejectedSession, signal: new AbortController().signal }).bindCurrentSession,
            permissionHandler: createProviderEnforcedPermissionHandler({
              session: rejectedSession,
              logPrefix: '[Pi native rejected initial model]',
            }),
          })).rejects.toMatchObject({
            code: 'agent_startup_failed',
            details: { failureCause: { phase: 'client_start', providerErrorCode: 'pi_configuration_failed',
              providerErrorMessage: expect.stringContaining('model unavailable') } },
          });
          const rejectedCapture = JSON.parse(
            await readFileEventually(capturePath, { timeoutMs: 5_000 }),
          ) as { commands: string[] };
          expect(rejectedCapture.commands.filter(command => command === 'set_model' || command === 'prompt')).toEqual(['set_model']);
        });
      } finally {
        envScope.restore();
      }
    });
  }, 60_000);
});
