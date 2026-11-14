import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { WebSocketServer } from 'ws';

import type {
  AgentAcpModel,
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeOptions,
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunConversationEventV1,
  AgentSessionOpenRequest,
  AgentSessionRuntimeEvent,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { createOhMyPiAgentRuntime } from '../../../../../../../packages/plugins/ohmypi/src/agent/runtime/engine';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createGeminiAgentRuntime } from '../../../../../../../packages/plugins/gemini/src/agent/runtime/factory';
import { createCustomAcpAgentRuntime } from '../../../../../../../packages/plugins/custom-acp/src/agent/runtime/factory';
import { createKiloAgentRuntime } from '../../../../../../../packages/plugins/kilo/src/agent/runtime/factory';
import { FX_SESSION_UPDATES } from '../../../../../../../packages/plugins/fx/src/agent/acp/sessionUpdates';
import { PLUGIN_MANIFEST as GEMINI_PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/gemini/src/manifest';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from '../../../../../../../packages/plugins/gemini/src/agent/connectedServices/runtimeAuthAdapter';
import { handleGrokPromptComplete, GROK_PROMPT_COMPLETE_METHOD } from '../../../../../../../packages/plugins/grok/src/agent/acp/completion';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { buildGrokAcpRuntimeDefinition } from '../../../../../../../packages/plugins/grok/src/agent/acp/definition';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { applyAcpBackendUpsertV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import {
  AgentRuntimeJsonValueV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionProviderCheckpointMaxJsonBytesV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
} from '@happier-dev/protocol/runtime';
import type {
  HostSessionApprovalRequest as PluginSessionApprovalRequest,
  HostSessionApprovalResult as PluginSessionApprovalResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

import { TestInteractions } from '@/agent/acp/testkit/interactionsFixture';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createFxConfigOptionsFixture } from '@/agent/acp/testkit/fxConfigOptionsFixture';
import { createAcpExecutionRunRuntimeContextFixture, createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAcpRequestFailureLogRecord } from '@/agent/acp/withRetry';
import { requestAcpHistoryExtension } from '@/agent/acp/history/acpHistoryExtensionMethods';
import { createAcpToolIdentity } from '@/agent/acp/toolCalls';
import { SHARED_RAW_ACP_TOOL_TRANSITIONS } from '@/agent/acp/toolCalls/testing/rawTransitionFixture';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createAgentSessionTurnInvariant } from '@/agent/runtime/session/turn/agentSessionTurnInvariant';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime/agentSessionLimitsV1';
import { createRuntimeFailureTranscriptProjector } from '@/agent/runtime/session/transcripts/runtimeFailureTranscript';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { TranscriptRawAgentContentV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { withTempDir } from '@/testkit/fs/tempDir';
import { waitForCondition } from '@/testkit/async/waitFor';
import { withCursorEmptyResponseFailure } from '../../../../../../../packages/plugins/cursor/src/agent/runtime/emptyResponse';
import { buildAcpModelSuffixOptionControls } from '../definition/modelSuffixOption';
import { buildAntigravityAcpRuntimeOptions } from '../../../../../../../packages/plugins/antigravity/src/agent/runtime/factory';
import { configuredAcpRuntimeConfiguration } from '@/agent/acp/runtime/definition/configured';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import { createHostDeclarativeAcpAgentRuntimeFactory } from '@/plugins/runtime/runner/createHostDeclarativeAcpAgentRuntimeFactory';
import { PLUGIN_MANIFEST as ANTIGRAVITY_PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/antigravity/src/manifest';
import { QWEN_ACP_RUNTIME_DEFINITION } from '../../../../../../../packages/plugins/qwen/src/agent/acp/definition';

import {
  createPublicAcpExecutionRun,
  createPublicAcpExecutionRunConversation,
  createPublicAcpSession,
  createPublicAcpSessionFromAwaitableAdapter,
  type PublicAcpComposerDependencies,
} from './createPublicAcpSession';

const OPAQUE_HISTORY_FORK_PROVIDER_SESSION_ID = '  provider\nses/AB+cd==  ';

type ApprovalRequester = (
  request: PluginSessionApprovalRequest,
  options?: { signal?: AbortSignal },
) => Promise<PluginSessionApprovalResult>;

function createApprovalRequestMock() {
  let nextRequestId = 1;
  return vi.fn<ApprovalRequester>(async request => {
    const choice = request.nativeChoices?.choices.find(candidate => candidate.decision === 'approved');
    return {
      requestId: `test-approval-${nextRequestId++}`,
      kind: 'approval',
      status: 'approved',
      ...(choice && request.nativeChoices ? { nativeChoice: {
        requirementId: request.nativeChoices.requirementId, choiceId: choice.id,
      } } : {}),
    };
  });
}

function writePublicComposerAgent(dir: string): string {
  return writeAcpTestAgentScript({
    dir,
    fileName: 'public-composer-agent.mjs',
    source: `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const decoder = new TextDecoder();
      let buffer = '';
      const scenario = process.env.PUBLIC_ACP_SCENARIO || 'completed';
      const capturedStandardToolUpdates = ${JSON.stringify(SHARED_RAW_ACP_TOOL_TRANSITIONS.filter(fixture => fixture.expected.toolName === 'write_file').flatMap(fixture => fixture.updates))};
      if (process.env.PUBLIC_ACP_ENV_CAPTURE) {
        writeFileSync(process.env.PUBLIC_ACP_ENV_CAPTURE, JSON.stringify({
          baseUrl: process.env.AGY_ACP_CCPA_BASE_URL ?? null,
          project: process.env.agy_acp_ccpa_project ?? null,
          toolValue: process.env.PUBLIC_ACP_USER_TOOL_VALUE ?? null,
        }));
      }
      if (scenario === 'launch-argv') {
        writeFileSync(process.env.PUBLIC_ACP_MEDIA_PATH, JSON.stringify(process.argv.slice(2)));
      }
      if (scenario.startsWith('gemini-overlay')) {
        const cliHome = process.env.GEMINI_CLI_HOME;
        const settingsPath = cliHome && join(cliHome, '.gemini', 'settings.json');
        writeFileSync(process.env.GEMINI_CAPTURE, JSON.stringify({
          home: process.env.HOME ?? null,
          cliHome: cliHome ?? null,
          xdgHome: process.env.XDG_CONFIG_HOME ?? null,
          settings: settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
          authExists: Boolean(cliHome && existsSync(join(cliHome, '.gemini', 'oauth_creds.json'))),
          dropped: process.env.DROP_ME ?? null,
          vertex: process.env.GOOGLE_GENAI_USE_VERTEXAI ?? null,
        }));
      }
      if (scenario.startsWith('native-mcp-overlay')) {
        const configRoot = process.env.XDG_CONFIG_HOME;
        const configPath = configRoot && join(configRoot, 'fixture-agent', 'mcp_config.json');
        writeFileSync(process.env.NATIVE_MCP_CAPTURE, JSON.stringify({
          configRoot: configRoot ?? null,
          config: configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null,
          linkedSetting: configRoot && existsSync(join(configRoot, 'fixture-agent', 'settings.json'))
            ? readFileSync(join(configRoot, 'fixture-agent', 'settings.json'), 'utf8')
            : null,
          dropped: process.env.DROP_ME ?? null,
        }));
      }
      let extensionPrompt = null;
      let extensionSession = null;
      let permissionPrompt = null;
      let permissionSession = null;
      let modeClearRejected = false;
      let delayedPrompt = null;
      let cancelledPrompt = null;
      let successorPrompt = null;
      let cancelSuccessorPromptCount = 0;
      let openedMcpServers = null;
      let selectedModel = null;
      let selectedMode = null;
      let authenticated = false;
      let initializeMetadata = null;
      let newSessionMetadata = null;
      let selectedModelRequest = null;
      let initialModelSelected = false;
      let historyPromptCount = 0;
      let retainedPromptCount = 0;
      let retainedPreviousInput = null;
      let recoveryPromptCount = 0;
      let permissionAfterSteerPromptCount = 0;
      let grokInterjectPromptCount = 0;
      let historyForkedOnThisConnection = false;
      let historyLoadedOnThisConnection = false;
      const lifecycleMethods = [];
      const selectedOptions = {};
      // FX 0.0.14 session/new capture, 2026-10-27; E-fx-live-probe.md §3.
      let configCatalog = ${JSON.stringify(createFxConfigOptionsFixture())};
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      // This scripted ACP producer supports these concrete modes for the raw-policy scenario.
      // Advertisement and setter admission share the producer's catalog.
      const inputPolicyModes = ['bypass', 'plan', 'ask'];
      const modeState = () => ({ currentModeId: 'default', availableModes: [
        { id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto edit' }, { id: 'yolo', name: 'YOLO' },
      ] });
      const ok = (id, result) => {
        // A successful config setter returns the complete current catalog.
        // An empty catalog would withdraw reviewDepth before the next update.
        if (scenario === 'configuration-update' && result.configOptions) {
          result.configOptions = [
            { id: 'model', name: 'Model', type: 'select', currentValue: selectedModel,
              options: [{ value: 'model-initial', name: 'Initial' }, { value: 'model-next', name: 'Next' }] },
            { id: 'reviewDepth', name: 'Review depth', type: 'select', currentValue: selectedOptions.reviewDepth ?? 'brief',
              options: [{ value: 'brief', name: 'Brief' }, { value: 'thorough', name: 'Thorough' }] },
          ];
        }
        if (result.sessionId && scenario === 'config-catalog') {
          result.configOptions = configCatalog;
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: result.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          } });
        }
        if (result.sessionId && scenario === 'configuration-update-input-policy') {
          result.modes = { currentModeId: inputPolicyModes[0],
            availableModes: inputPolicyModes.map(id => ({ id, name: id })) };
        }
        if (result.sessionId && scenario.startsWith('configuration-update-candidates-')) {
          const ids = scenario.endsWith('legacy') ? ['legacy', 'ask']
            : scenario.endsWith('both') ? ['legacy', 'ask', 'preferred', 'unrestricted']
              : scenario.endsWith('unmatched') ? ['unrestricted']
                : ['preferred', 'ask', 'unrestricted'];
          result.modes = { currentModeId: ids[0], availableModes: ids.map(id => ({ id, name: id })) };
        }
        if (scenario === 'mode-publication') {
          if (result.protocolVersion) result.agentCapabilities = { loadSession: true };
          if (result.sessionId) result.modes = modeState();
        }
        if (result.sessionId && scenario.startsWith('model-observation-')) {
          if (scenario === 'model-observation-empty') result.models = { currentModelId: 'current', availableModels: [] };
          if (scenario === 'model-observation-config') result.configOptions = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'current', options: [] }];
          if (scenario === 'model-observation-current') result.models = { currentModelId: 'current', availableModels: [{ modelId: 'current', name: 'Current' }, { modelId: 'next', name: 'Next' }] };
        }
        send({ jsonrpc: '2.0', id, result });
      };
      const update = (sessionId, text) => send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      });
      const updateRaw = (sessionId, update) => send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update },
      });
      const userUpdate = (sessionId, text, meta) => send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text },
            ...(meta === undefined ? {} : { _meta: meta }),
          },
        },
      });
      process.stdin.on('data', (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (scenario === 'sidechain-permission') {
            if (request.method === undefined && request.id === 'replay-permission-1') {
              writeFileSync(join(process.env.REPLAY_PERMISSION_EVIDENCE, 'permission-reply.json'), JSON.stringify(request.result));
              continue;
            }
            if (request.params?.sessionId === 'provider-child' && (request.method === 'session/cancel' || request.method === 'session/close')) {
              writeFileSync(join(process.env.REPLAY_PERMISSION_EVIDENCE, request.method === 'session/cancel' ? 'child-cancel.json' : 'child-close.json'), JSON.stringify(request.params));
            }
          }
          if (request.method === undefined && request.id === 'extension-1' && extensionPrompt !== null) {
            if (scenario !== 'extension-completion-delayed-stream') {
              update(extensionSession, JSON.stringify(request.result));
            }
            if (
              scenario === 'extension-completion'
              || scenario === 'extension-completion-delayed-stream'
            ) {
              const promptRequestId = extensionPrompt;
              setTimeout(() => ok(promptRequestId, { stopReason: 'end_turn' }), 100);
            } else if (
              scenario !== 'extension-completion-stranded'
              && scenario !== 'cancel-successor'
            ) {
              ok(extensionPrompt, { stopReason: 'end_turn' });
            }
            extensionPrompt = null;
          } else if (
            request.method === undefined
            && request.id === 'extension-2'
            && successorPrompt !== null
          ) {
            const promptRequestId = successorPrompt;
            successorPrompt = null;
            setTimeout(() => ok(promptRequestId, { stopReason: 'end_turn' }), 100);
          } else if (request.method === undefined && request.id === 'permission-1' && permissionPrompt !== null) {
            update(permissionSession, JSON.stringify(request.result));
            ok(permissionPrompt, { stopReason: 'end_turn' });
            permissionPrompt = null;
          } else if (request.method === 'initialize') {
            if (scenario === 'gemini-overlay-fail' || scenario === 'native-mcp-overlay-fail') {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture initialization rejected' } });
              continue;
            }
            lifecycleMethods.push('initialize');
            initializeMetadata = request.params.clientCapabilities?._meta ?? null;
            ok(request.id, {
              protocolVersion: 1,
              agentCapabilities: scenario.startsWith('declared-steer')
                ? { _meta: { acme: { steering: scenario !== 'declared-steer-unavailable' } } }
                : scenario === 'media' || scenario === 'structured-steer'
                ? { promptCapabilities: { image: true } }
                : scenario === 'capabilities'
                  ? {
                      loadSession: true,
                      sessionCapabilities: { list: {}, fork: {}, close: {}, delete: {} },
                    }
                  : scenario === 'session-open-capabilities'
                    ? {
                        loadSession: true,
                        sessionCapabilities: { fork: {} },
                      }
                    : scenario.startsWith('history-fork')
                      || scenario.startsWith('agy-api-key-')
                      || scenario === 'resume-replay'
                      || scenario.startsWith('configuration-update')
                      || scenario.startsWith('sidechain-')
                      || scenario.startsWith('resume-extension-notification')
                      ? scenario === 'sidechain-permission'
                        ? { loadSession: true, sessionCapabilities: { close: {} } }
                        : { loadSession: true }
                      : {},
              _meta: scenario === 'auth-dynamic'
                ? { defaultAuthMethodId: 'cursor_login', providerOnly: 'bounded' }
                : scenario === 'auth-dynamic-large'
                  ? { payload: 'x'.repeat(17_000) }
                  : undefined,
              authMethods: scenario.startsWith('agy-select-') || scenario.startsWith('agy-api-key-')
                ? [{ id: 'oauth-personal', name: 'Google OAuth' }, { id: 'gemini-api-key', name: 'Gemini key' }]
                : scenario.startsWith('agy-quota-') || scenario.startsWith('agy-auth-')
                ? [{ id: 'oauth-personal', name: 'Google OAuth' }]
                : scenario === 'grok-interject'
                ? [{ id: 'cached_token', name: 'Grok cached token' }]
                : scenario === 'auth-missing'
                  ? [{ id: 'different_login', name: 'Different login' }]
                : scenario === 'auth' || scenario === 'auth-missing' || scenario === 'auth-dynamic' || scenario === 'auth-dynamic-large'
                  ? [{ id: 'cursor_login', name: 'Cursor login' }]
                  : [],
            });
          } else if (request.method === 'authenticate') {
            lifecycleMethods.push('authenticate');
            authenticated = (scenario.startsWith('agy-select-') && scenario !== 'agy-select-missing'
              && request.params.methodId === (scenario === 'agy-select-key' ? 'gemini-api-key' : 'oauth-personal'))
              || request.params.methodId === 'cursor_login'
              || (scenario === 'grok-interject' && request.params.methodId === 'cached_token')
              || ((scenario.startsWith('agy-quota-') || scenario.startsWith('agy-auth-')) && request.params.methodId === 'oauth-personal')
              || (scenario.startsWith('agy-api-key-') && request.params.methodId === 'gemini-api-key');
            if (scenario === 'auth-dynamic') {
              initializeMetadata = {
                client: initializeMetadata,
                authenticate: request.params._meta ?? null,
              };
            }
            ok(request.id, {});
          } else if (request.method === 'session/new') {
            if (scenario === 'codex-skill-acp') {
              writeFileSync(process.env.PUBLIC_ACP_MEDIA_PATH, JSON.stringify({
                argv: process.argv.slice(2), env: { HOME: process.env.HOME }, acpSessionNew: request.params,
              }));
            }
            if (scenario.startsWith('agy-auth-')) {
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: scenario === 'agy-auth-wrong-code' ? -32603 : -32000,
                message: 'token=provider-secret-value',
                data: { reason: scenario === 'agy-auth-required' ? null : 'onboarding_failed',
                  token: 'provider-secret-value', nested: { authorization: 'Bearer nested-secret-value' } },
              } });
              continue;
            }

            lifecycleMethods.push('session/new');
            newSessionMetadata = request.params._meta ?? null;
            if ((scenario === 'auth' || scenario === 'grok-interject' || scenario.startsWith('agy-quota-') || scenario.startsWith('agy-select-') || scenario.startsWith('agy-api-key-')) && !authenticated) {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'auth required' } });
              continue;
            }
            openedMcpServers = request.params.mcpServers;
            if (scenario === 'fx-session-updates') {
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-created',
                update: { sessionUpdate: 'session_info_update', _meta: { fx: { modelResponseRecovery: {
                  state: 'active', attempt: 99, cause: 'rate_limit',
                } } } } } });
            }
            ok(request.id, scenario === 'provider-models' || scenario === 'provider-models-context'
              ? {
                  sessionId: 'provider-created',
                  models: {
                    currentModelId: 'provider-current',
                    availableModels: [
                      {
                        modelId: 'provider-current',
                        name: 'Provider current',
                        ...(scenario === 'provider-models-context'
                          ? { contextWindowTokens: 200000 }
                          : {}),
                        _meta: {
                          supportsReasoningEffort: true,
                          reasoningEffort: 'high',
                          reasoningEfforts: [
                            { value: 'low', label: 'Low Effort' },
                            { value: 'medium', label: 'Medium Effort' },
                            { value: 'high', label: 'High Effort' },
                          ],
                        },
                      },
                      { modelId: 'stale-host', name: 'Stale host' },
                    ],
                  },
                }
              : scenario === 'projected-config-models'
                ? {
                    sessionId: 'provider-created',
                    configOptions: [{
                      id: 'model',
                      name: 'Model',
                      type: 'select',
                      currentValue: 'model-a',
                      options: [
                        { value: 'model-a', name: 'Model A' },
                        { value: 'model-b', name: 'Model B' },
                      ],
                    }],
                  }
              : scenario === 'projected-config-model-options'
                ? {
                    sessionId: 'provider-created',
                    configOptions: [{
                      id: 'model',
                      name: 'Model',
                      type: 'select',
                      currentValue: 'gpt-high',
                      options: [
                        { value: 'gpt-low', name: 'GPT Low' },
                        { value: 'gpt-high', name: 'GPT High' },
                        { value: 'gpt-low-priority', name: 'GPT Low Fast' },
                        { value: 'gpt-high-priority', name: 'GPT High Fast' },
                      ],
                    }],
                  }
              : { sessionId: 'provider-created' });
          } else if (request.method === 'session/set_model') {
            selectedModelRequest = request.params;
            if (
              scenario.startsWith('history-fork')
              && !historyLoadedOnThisConnection
            ) {
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: -32000,
                message: 'history fork model applied before the forked session was loaded',
              } });
              continue;
            }
            if (scenario === 'history-fork-provider-models-initial') {
              if (request.params._meta?.reasoningEffort === undefined) {
                initialModelSelected = true;
              } else if (!initialModelSelected) {
                send({ jsonrpc: '2.0', id: request.id, error: {
                  code: -32000,
                  message: 'reasoning effort applied before initial model',
                } });
                continue;
              }
            }
            if (scenario === 'provider-models' && request.params._meta?.reasoningEffort === 'low') {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'effort rejected' } });
            } else if (
              scenario === 'provider-models'
              || scenario === 'history-fork-provider-models-initial'
            ) {
              ok(request.id, { _meta: { model: { Ok: request.params.modelId } } });
            } else {
              ok(request.id, {});
            }
          } else if (request.method === 'session/set_config_option') {
            if (scenario === 'config-catalog') {
              if (request.params.configId === 'provider' && request.params.value === 'gateway') {
                send({ jsonrpc: '2.0', id: request.id, error: { code: -32600,
                  message: 'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.' } });
                continue;
              }
              if (request.params.configId === 'provider' && request.params.value === 'codex') {
                configCatalog = ${JSON.stringify(createFxConfigOptionsFixture())};
              }
              configCatalog = configCatalog.map(option => ({ ...option,
                currentValue: option.id === request.params.configId ? request.params.value : option.currentValue,
                ...(option.id === 'effort' && request.params.configId === 'model'
                  ? { options: option.options.filter(choice => request.params.value !== 'gpt-6-luna' || choice.value !== 'ultra') } : {}),
              }));
              ok(request.id, { configOptions: configCatalog });
              continue;
            }
            selectedOptions[request.params.configId] = request.params.value;
            if (request.params.configId === 'model') selectedModel = request.params.value;
            ok(request.id, scenario === 'projected-config-models'
              ? {
                  configOptions: [{
                    id: 'model',
                    name: 'Model',
                    type: 'select',
                    currentValue: selectedModel,
                    options: [
                      { value: 'model-a', name: 'Model A' },
                      { value: 'model-b', name: 'Model B' },
                    ],
                  }],
                }
              : scenario === 'projected-config-model-options'
                ? {
                    configOptions: [{
                      id: 'model',
                      name: 'Model',
                      type: 'select',
                      currentValue: selectedModel,
                      options: [
                        { value: 'gpt-low', name: 'GPT Low' },
                        { value: 'gpt-high', name: 'GPT High' },
                        { value: 'gpt-low-priority', name: 'GPT Low Fast' },
                        { value: 'gpt-high-priority', name: 'GPT High Fast' },
                      ],
                    }],
                  }
              : { configOptions: [] });
          } else if (request.method === 'session/set_mode') {
            if (scenario === 'configuration-update-input-policy' && !inputPolicyModes.includes(request.params.modeId)) {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'mode not advertised' } });
              continue;
            }
            if (scenario === 'configuration-update-clear-retry' && request.params.modeId === 'ask' && !modeClearRejected) {
              modeClearRejected = true;
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'mode clear rejected once' } });
              continue;
            }
            if (scenario === 'configuration-update-concurrent' && request.params.modeId === 'slow-old') {
              setTimeout(() => {
                selectedMode = request.params.modeId;
                ok(request.id, {});
              }, 100);
            } else {
              selectedMode = request.params.modeId;
              ok(request.id, {});
            }
          } else if (request.method === 'session/load') {
            if (scenario.startsWith('history-fork') && (
              request.params.sessionId !== 'provider-history-forked'
              || !historyForkedOnThisConnection
            )) {
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: -32000,
                message: 'history fork was not created on this ACP connection',
              } });
              continue;
            }
            if (scenario.startsWith('history-fork')) {
              historyLoadedOnThisConnection = true;
              update(request.params.sessionId, 'history fork replay must stay provider-local');
            }
            if (scenario.startsWith('sidechain-') && scenario !== 'sidechain-empty') {
              update(request.params.sessionId, 'child replay output');
            }
            if (scenario === 'resume-replay') {
              userUpdate(request.params.sessionId, 'replayed user message');
              update(request.params.sessionId, 'replayed assistant message');
            }
            if (scenario.startsWith('resume-extension-notification')) {
              send({
                jsonrpc: '2.0',
                method: 'x.ai/session/update',
                params: {
                  sessionId: request.params.sessionId,
                  update: { sessionUpdate: 'goal_updated', goal_id: 'goal-1', objective: 'Ship' },
                },
              });
              send({
                jsonrpc: '2.0',
                method: 'x.ai/session/update',
                params: {
                  sessionId: 'foreign-session',
                  update: { sessionUpdate: 'goal_updated', goal_id: 'foreign-goal', objective: 'Ignore' },
                },
              });
              if (scenario === 'resume-extension-notification-failed') {
                send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'resume rejected' } });
                continue;
              }
              if (scenario === 'resume-extension-notification-delayed') {
                setTimeout(() => ok(request.id, {}), 100);
                continue;
              }
            }
            ok(request.id, scenario === 'mode-publication' ? { modes: modeState() } : {});
            if (scenario === 'sidechain-permission') {
              // Deliberately out of the pinned native replay contract. Wait for
              // the real persistence boundary so the backend has adopted the load.
              const probe = setInterval(() => {
                if (!existsSync(join(process.env.REPLAY_PERMISSION_EVIDENCE, 'import-admitted'))) return;
                clearInterval(probe);
                send({ jsonrpc: '2.0', id: 'replay-permission-1', method: 'session/request_permission', params: {
                  sessionId: request.params.sessionId,
                  toolCall: { toolCallId: 'replay-unexpected-tool', kind: 'execute', toolName: 'Bash', rawInput: { command: 'pwd' } },
                  options: [
                    { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                    { optionId: 'reject-once', kind: 'reject_once', name: 'Deny' },
                  ],
                } });
              }, 10);
            }
          } else if (request.method === 'session/fork') {
            ok(request.id, { sessionId: 'provider-forked' });
          } else if (request.method === 'session/list') {
            ok(request.id, {
              sessions: [{
                sessionId: ' provider\\nsession ',
                cwd: request.params.cwd,
                title: 'Provider session',
                updatedAt: '2026-09-13T08:30:00.000Z',
              }],
              nextCursor: request.params.cursor === ' page\\n1 ' ? ' page\\n2 ' : null,
            });
          } else if (request.method === 'session/close' || request.method === 'session/delete') {
            lifecycleMethods.push({ method: request.method, sessionId: request.params.sessionId });
            ok(request.id, {});
          } else if (
            request.method === 'x.ai/session/fork'
            && scenario === 'history-fork-legacy'
          ) {
            send({ jsonrpc: '2.0', id: request.id, error: {
              code: -32601,
              message: '"Method not found": x.ai/session/fork',
              data: { method: 'x.ai/session/fork' },
            } });
          } else if (
            request.method === 'x.ai/session/fork'
            || request.method === '_x.ai/session/fork'
          ) {
            const expected = scenario === 'history-fork-exact'
              ? {
                  sourceSessionId: 'provider-parent',
                  sourceCwd: '/source-workspace',
                  newCwd: request.params.newCwd,
                  targetPromptIndex: 42,
                }
              : {
                  sourceSessionId: 'provider-parent',
                  sourceCwd: '/source-workspace',
                  newCwd: request.params.newCwd,
                };
            if (JSON.stringify(request.params) !== JSON.stringify(expected)) {
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: -32602,
                message: 'invalid Grok fork params: ' + JSON.stringify(request.params),
              } });
              continue;
            }
            historyForkedOnThisConnection = true;
            ok(request.id, scenario === 'history-fork-provider-models-initial'
              ? {
                  newSessionId: 'provider-history-forked',
                  models: {
                    currentModelId: 'provider-current',
                    availableModels: [{
                      modelId: 'provider-current',
                      name: 'Provider current',
                      _meta: {
                        supportsReasoningEffort: true,
                        reasoningEffort: 'high',
                        reasoningEfforts: [
                          { value: 'low', label: 'Low Effort' },
                          { value: 'high', label: 'High Effort' },
                        ],
                      },
                    }],
                  },
                }
              : { newSessionId: 'provider-history-forked' });
          } else if (request.method === 'x.ai/rewind/execute') {
            const expected = {
              sessionId: 'provider-created',
              targetPromptIndex: 42,
              mode: 'conversation_only',
            };
            if (JSON.stringify(request.params) !== JSON.stringify(expected)) {
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: -32602,
                message: 'invalid Grok rewind params: ' + JSON.stringify(request.params),
              } });
              continue;
            }
            ok(request.id, { success: true });
          } else if (request.method === 'session/prompt') {
            const sessionId = request.params.sessionId;
            if (scenario === 'malformed-publication') {
              update(sessionId, 'accepted output');
              continue;
            }
            if (scenario === 'config-catalog') {
              const withdraw = request.params.prompt.some(block => block.type === 'text' && block.text === 'withdraw catalog');
              configCatalog = withdraw ? [] : configCatalog.map(option => option.id === 'fast' ? { ...option, currentValue: 'false' } : option);
              updateRaw(sessionId, { sessionUpdate: 'config_option_update', configOptions: configCatalog });
              updateRaw(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: withdraw ? [] : [{ name: 'review', description: 'Review changes' }] });
              ok(request.id, { stopReason: 'end_turn' });
              continue;
            }
            if (scenario === 'opencode-quota-error' || scenario === 'opencode-generation-error') {
              // OpenCode v1.19.0 acp/service.ts:839-892 and acp/error.ts:86-93:
              // completed generation failures become session/prompt internal errors, without output.
              // The generic failure message was captured on agent-qa-providers r1103f.
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: -32603,
                message: 'Internal error: ' + (scenario === 'opencode-quota-error'
                  ? 'Free usage limit reached' : 'Cannot connect to API: Unable to connect. Is the computer able to access the url?'),
                data: { service: 'session', errorName: 'APIError' },
              } });
            } else if (scenario.startsWith('provider-limit-request-')) {
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: -32603, message: 'Fixture provider rejection',
                data: { status: 429, token: 'private-provider-token',
                  ...(scenario.endsWith('retry') ? { retryAfterMs: 120000 } : { resetAt: 1900000000000 }),
                },
              } });
            } else if (scenario.startsWith('gemini-request-error-')) {
              // Gemini CLI v0.60.0 acpSession.ts:453-457 (also v0.8.2 zedIntegration.ts:300-305)
              // emits numeric ACP RequestError(429), not a provider-message quota parser.
              send({ jsonrpc: '2.0', id: request.id, error: {
                code: Number(scenario.slice('gemini-request-error-'.length)),
                message: 'Fixture provider rejection', data: { token: 'private-provider-token' },
              } });
              const countPath = process.env.PUBLIC_ACP_PROMPT_COUNT_PATH;
              if (countPath) writeFileSync(countPath, String((existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0) + 1));
            } else if (scenario.startsWith('sidechain-')) {
              updateRaw(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'child-launch', title: scenario.slice('sidechain-'.length), kind: 'other', status: 'in_progress', rawInput: { prompt: 'child work' } });
              updateRaw(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'child-launch', status: 'completed', rawOutput: { output: 'child fallback output', metadata: { sessionId: 'provider-child' } } });
              update(sessionId, 'parent output');
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario.startsWith('model-observation-')) {
              send({ jsonrpc: '2.0', method: 'session/update', params: {
                sessionId, update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'next', options: [] }] },
              } });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'request-transform') {
              const text = request.params.prompt?.find((block) => block?.type === 'text')?.text;
              update(sessionId, typeof text === 'string' ? text : 'missing transformed prompt');
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario.startsWith('agy-api-key-')) {
              // Observed ACP server output: provider refusal as assistant text plus end_turn.
              const failure = 'API key not valid. Please pass a valid API key.';
              userUpdate(sessionId, failure);
              if (scenario === 'agy-api-key-quoted') update(sessionId, 'The diagnostic says: ' + failure);
              else if (scenario === 'agy-api-key-code') update(sessionId, '\u0060\u0060\u0060' + failure + '\u0060\u0060\u0060');
              else if (scenario === 'agy-api-key-user-only') update(sessionId, 'Here is the requested example.');
              else if (scenario === 'agy-api-key-whole') update(sessionId, failure);
              else { update(sessionId, failure.slice(0, 17)); update(sessionId, failure.slice(17)); }
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario.startsWith('agy-quota-')) {
              const quota = 'Usage Limit Reached\\n\\nYou have reached your current quota for this period.';
              userUpdate(sessionId, quota);
              if (scenario === 'agy-quota-refused') {
                update(sessionId, 'I cannot help with that request.');
                ok(request.id, { stopReason: 'refusal' });
              } else if (scenario === 'agy-quota-quoted') {
                update(sessionId, 'The diagnostic says: ' + quota);
                ok(request.id, { stopReason: 'end_turn' });
              } else {
                update(sessionId, 'Earlier assistant output.');
                if (scenario === 'agy-quota-chunked') {
                  updateRaw(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'before-quota', title: 'Read file', kind: 'read', status: 'in_progress', rawInput: { path: 'README.md' } });
                  updateRaw(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'before-quota', status: 'completed', rawOutput: { text: 'contents' } });
                  update(sessionId, quota.slice(0, 15));
                  update(sessionId, quota.slice(15));
                } else update(sessionId, quota);
                ok(request.id, { stopReason: 'end_turn' });
              }
            } else if (scenario === 'retained-conversation') {
              retainedPromptCount += 1;
              update(sessionId, JSON.stringify({ turn: retainedPromptCount, previousInput: retainedPreviousInput,
                nativePolicy: process.env.KILO_PERMISSION ? JSON.parse(process.env.KILO_PERMISSION) : undefined }));
              retainedPreviousInput = request.params.prompt?.find(block => block?.type === 'text')?.text;
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'completed') {
              update(sessionId, 'hello from ACP');
              setTimeout(() => ok(request.id, { stopReason: 'end_turn' }), 100);
            } else if (scenario === 'history-prompts') {
              historyPromptCount += 1;
              userUpdate(
                sessionId,
                'history prompt ' + historyPromptCount,
                { promptIndex: historyPromptCount === 1 ? 7 : 42 },
              );
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'history-ambiguous') {
              userUpdate(sessionId, 'first coordinate', { promptIndex: 7 });
              userUpdate(sessionId, 'conflicting coordinate', { promptIndex: 42 });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'media' || scenario === 'media-override') {
              update(sessionId, JSON.stringify({
                prompt: request.params.prompt,
                promptId: request.params._meta?.promptId ?? null,
              }));
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'refused') {
              ok(request.id, { stopReason: 'refusal' });
            } else if (scenario === 'max_tokens' || scenario === 'max_turn_requests') {
              update(sessionId, 'incomplete ACP output');
              ok(request.id, { stopReason: scenario });
            } else if (scenario === 'unknown-stop-reason') {
              ok(request.id, { stopReason: 'future_stop', usage: {
                inputTokens: 17, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3,
              } });
            } else if (scenario === 'prompt-rejected-before-effect' || scenario === 'prompt-connection-rejected' || scenario === 'prompt-long-rejected') {
              send({
                jsonrpc: '2.0',
                id: request.id,
                error: scenario !== 'prompt-rejected-before-effect'
                  ? { code: -32603, message: scenario === 'prompt-long-rejected'
                      ? 'Cannot connect to API ' + 'x'.repeat(9_000)
                      : 'Cannot connect to API Authorization: Bearer private-api-token',
                      data: { service: 'session', errorName: 'APIError', secret: 'private-error-data' } }
                  : { code: -32602, message: 'prompt rejected before effect' },
              });
            } else if (scenario.startsWith('prompt-recovery-')) {
              recoveryPromptCount += 1;
              if (recoveryPromptCount === 1) {
                if (scenario === 'prompt-recovery-refused') {
                  ok(request.id, { stopReason: 'refusal' });
                } else {
                  if (scenario === 'prompt-recovery-after-output') update(sessionId, 'output before provider failure');
                  send({ jsonrpc: '2.0', id: request.id, error: {
                    code: scenario === 'prompt-recovery-before-effect' ? -32602 : -32603,
                    message: 'provider unavailable',
                  } });
                }
              } else {
                // ACP does not require a user-message echo. Stream the entire reply
                // before returning the successor prompt's request-scoped response.
                update(sessionId, 'recovered reply');
                ok(request.id, { stopReason: 'end_turn' });
              }
            } else if (scenario === 'prompt-rejected-after-update') {
              update(sessionId, 'provider output before rejected response');
              send({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: 'prompt response lost after output' },
              });
            } else if (scenario === 'prompt-effect-unobserved') {
              process.exit(17);
            } else if (scenario === 'exit' || scenario === 'exit-zero') {
              ok(request.id, {});
              setTimeout(() => process.exit(scenario === 'exit-zero' ? 0 : 17), 10);
            } else if (
              scenario === 'extension'
              || scenario === 'extension-completion'
              || scenario === 'extension-completion-stranded'
              || scenario === 'extension-completion-delayed-stream'
            ) {
              extensionPrompt = request.id;
              extensionSession = sessionId;
              const submitCompletion = () => send({
                jsonrpc: '2.0',
                id: 'extension-1',
                method: 'acme/echo',
                params: scenario === 'extension-completion'
                  || scenario === 'extension-completion-stranded'
                  || scenario === 'extension-completion-delayed-stream'
                  ? {
                      providerSessionId: sessionId,
                      promptId: request.params._meta?.promptId ?? null,
                  }
                  : { value: 'hello extension' },
              });
              if (scenario === 'extension-completion-delayed-stream') {
                updateRaw(sessionId, {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: 'checking' },
                });
                setTimeout(() => {
                  update(sessionId, 'assistant before prompt response');
                  updateRaw(sessionId, {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'pre-response-tool',
                    title: 'Read file',
                    kind: 'read',
                    status: 'in_progress',
                    rawInput: { path: '/workspace/README.md' },
                  });
                  updateRaw(sessionId, {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'pre-response-tool',
                    kind: 'read',
                    status: 'completed',
                    rawOutput: { text: 'contents' },
                  });
                  update(sessionId, 'assistant after tool');
                  submitCompletion();
                }, 60);
              } else {
                submitCompletion();
              }
            } else if (scenario === 'cancel-successor') {
              cancelSuccessorPromptCount += 1;
              update(sessionId, cancelSuccessorPromptCount === 1 ? 'first turn active' : 'successor active');
              if (cancelSuccessorPromptCount === 1) {
                cancelledPrompt = request.id;
                extensionPrompt = request.id;
                extensionSession = sessionId;
                send({
                  jsonrpc: '2.0',
                  id: 'extension-1',
                  method: 'acme/echo',
                  params: {
                    providerSessionId: sessionId,
                    promptId: request.params._meta?.promptId ?? null,
                  },
                });
              } else {
                successorPrompt = request.id;
                if (cancelledPrompt !== null) {
                  ok(cancelledPrompt, { stopReason: 'end_turn' });
                  cancelledPrompt = null;
                  send({
                    jsonrpc: '2.0',
                    id: 'extension-2',
                    method: 'acme/old_response_released',
                    params: {},
                  });
                }
              }
            } else if (scenario.startsWith('declared-steer')) {
              if (!request.params._meta?.acme?.steer) {
                if (delayedPrompt !== null) {
                  update(sessionId, 'missing steer opt-in');
                  ok(request.id, { stopReason: 'end_turn' });
                  continue;
                }
                delayedPrompt = request.id;
                update(sessionId, 'primary active');
                continue;
              }
              if (scenario !== 'declared-steer-dropped') {
                updateRaw(sessionId, {
                  sessionUpdate: 'user_message_chunk', messageId: 'steer-echo',
                  content: { type: 'text', text: request.params.prompt[0].text },
                  _meta: { acme: { steering: { requestId: request.id } } },
                });
                update(sessionId, 'steered');
              }
              ok(delayedPrompt, { stopReason: 'end_turn' });
              delayedPrompt = null;
              ok(request.id, { stopReason: 'end_turn', _meta: { acme: {
                steering: scenario === 'declared-steer-dropped' ? 'dropped' : 'absorbed',
              } } });
            } else if (scenario === 'permission-after-steer') {
              permissionAfterSteerPromptCount += 1;
              if (permissionAfterSteerPromptCount === 1) {
                // Keep the first turn active; the steer will issue the request.
                continue;
              }
              permissionPrompt = request.id;
              permissionSession = sessionId;
              send({
                jsonrpc: '2.0',
                id: 'permission-1',
                method: 'session/request_permission',
                params: {
                  sessionId,
                  toolCall: {
                    toolCallId: 'tool-call-after-steer',
                    kind: 'execute',
                    toolName: 'Bash',
                    rawInput: { command: 'pwd' },
                  },
                  options: [
                    { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                    { optionId: 'allow-session', kind: 'allow_always', name: 'Allow for session' },
                    { optionId: 'reject-once', kind: 'reject_once', name: 'Deny' },
                  ],
                },
              });
            } else if (scenario === 'structured-steer') {
              permissionAfterSteerPromptCount += 1;
              if (permissionAfterSteerPromptCount === 1) {
                continue;
              }
              update(sessionId, JSON.stringify(request.params.prompt));
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'runtime-observations') {
              updateRaw(sessionId, {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'reasoning trace' },
              });
              updateRaw(sessionId, {
                sessionUpdate: 'usage_update',
                used: 21,
                size: 200000,
              });
              update(sessionId, 'final answer');
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'grok-interject') {
              grokInterjectPromptCount += 1;
              if (grokInterjectPromptCount === 1) {
                delayedPrompt = request.id;
                update(sessionId, 'primary active');
                continue;
              }
              update(sessionId, 'wrong concurrent session prompt');
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'permission') {
              permissionPrompt = request.id;
              permissionSession = sessionId;
              send({
                jsonrpc: '2.0',
                id: 'permission-1',
                method: 'session/request_permission',
                params: {
                  sessionId,
                  toolCall: {
                    toolCallId: 'tool-call-1',
                    kind: 'execute',
                    toolName: 'Bash',
                    rawInput: { command: 'pwd' },
                  },
                  options: [
                    { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                    { optionId: 'allow-session', kind: 'allow_always', name: 'Allow for session' },
                    { optionId: 'reject-once', kind: 'reject_once', name: 'Deny' },
                  ],
                },
              });
            } else if (scenario === 'cancel-before-ack') {
              delayedPrompt = request.id;
            } else if (scenario === 'vb4') {
              update(sessionId, JSON.stringify({
                auth: process.env.AUGMENT_SESSION_AUTH || null,
                keep: process.env.KEEP_ME || null,
                dropped: process.env.DROP_ME || null,
                mcpServers: openedMcpServers,
                selectedModel,
              }));
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'index-workspace-1',
                    title: 'Unknown tool',
                    kind: 'other',
                    rawInput: { locations: ['/workspace'] },
                  },
                },
              });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'mode-publication') {
              updateRaw(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' });
              update(sessionId, JSON.stringify({ selectedMode }));
              ok(request.id, { stopReason: 'end_turn' });
            } else if (
              scenario.startsWith('configuration-update')
              || scenario === 'projected-config-models'
            ) {
              update(sessionId, JSON.stringify({ selectedMode, selectedModel, selectedOptions }));
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'auth' || scenario === 'auth-dynamic') {
              update(sessionId, JSON.stringify({ lifecycleMethods, initializeMetadata, newSessionMetadata }));
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'captured-standard-tool-name') {
              for (const raw of capturedStandardToolUpdates) updateRaw(sessionId, raw);
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'plugin-session-updates' || scenario === 'fx-session-updates') {
              // Generic plugin codec contract; native vectors and provenance
              // belong to the plugin's own source tests.
              for (const recovery of [
                { state: 'active', kind: 'retry', attempt: 2, delaySeconds: 3, cause: 'rate_limit' },
                { state: 'paused', kind: 'terminal_provider_error', requiredAction: 'retry' },
                { state: 'recovered', kind: 'retry' },
                { state: 'failed', kind: 'terminal_provider_error' },
                null,
              ]) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
                update: { sessionUpdate: 'session_info_update', _meta: scenario === 'fx-session-updates'
                  ? { fx: { modelResponseRecovery: recovery } } : { example: { recovery } } } } });
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
                update: { sessionUpdate: 'tool_call', toolCallId: 'opaque-call',
                  title: 'search', kind: 'other', status: 'pending', rawInput: {} } } });
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
                update: { sessionUpdate: 'tool_call_update', toolCallId: 'opaque-call', status: 'completed', rawOutput: 'found' } } });
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
                update: { sessionUpdate: 'tool_call_update', toolCallId: 'opaque-call', name: 'lookup',
                  _meta: { example: { toolCall: { internal: false, mcp: { server: 'docs', tool: 'lookup' } } } } } } });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'tool-hooks') {
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'cursor-tool-1',
                    title: 'Unknown tool',
                    kind: 'other',
                    status: 'in_progress',
                    content: [{ type: 'diff', path: '/workspace/file.ts', oldText: 'dirty-old', newText: 'dirty-new' }],
                  },
                },
              });
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'cursor-tool-1',
                    kind: 'other',
                    status: 'completed',
                    content: [{ type: 'diff', path: '/workspace/file.ts', oldText: 'dirty-old', newText: 'dirty-new' }],
                  },
                },
              });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'generated-media' || scenario === 'generated-media-stale') {
              const terminalUpdate = {
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'generated-image-1',
                    kind: 'image',
                    status: 'completed',
                    rawOutput: {
                      type: 'ImageGen',
                      path: process.env.PUBLIC_ACP_MEDIA_PATH,
                      filename: 'generated.png',
                      session_folder: 'generated',
                    },
                  },
                },
              };
              if (scenario === 'generated-media-stale') {
                update(sessionId, 'generation started');
                setTimeout(() => {
                  send(terminalUpdate);
                  ok(request.id, { stopReason: 'end_turn' });
                }, 100);
              } else {
                send(terminalUpdate);
                send(terminalUpdate);
                ok(request.id, { stopReason: 'end_turn' });
              }
            } else if (scenario.startsWith('history-fork')) {
              if (
                !historyLoadedOnThisConnection
                || sessionId !== 'provider-history-forked'
              ) {
                send({
                  jsonrpc: '2.0',
                  id: request.id,
                  error: {
                    code: -32000,
                    message: 'history fork successor prompt reached an unloaded provider session',
                  },
                });
                continue;
              }
              update(sessionId, 'history fork successor complete');
              ok(request.id, { stopReason: 'end_turn' });
            } else {
              ok(request.id, {});
            }
          } else if (request.method === 'acme/malformed_publication') {
            ok(request.id, {});
            updateRaw(request.params.sessionId, {
              sessionUpdate: 'tool_call',
              toolCallId: 'x'.repeat(${AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.providerIdMaxCodeUnits + 1}),
              title: 'Read', kind: 'read', status: 'in_progress', rawInput: { path: 'file.ts' },
            });
          } else if (request.method === 'acme/probe_permission') {
            permissionPrompt = request.id;
            permissionSession = request.params.sessionId;
            send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
              sessionId: permissionSession,
              toolCall: { toolCallId: 'ongoing-turn-tool', kind: 'execute', toolName: 'Bash', rawInput: { command: 'pwd' } },
              options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
            } });
          } else if (request.method === 'x.ai/interject') {
            if (request.params.content) update(request.params.sessionId, JSON.stringify(request.params.content));
            update(
              request.params.sessionId,
              'interjected=' + request.params.text + ';id=' + request.params.interjectionId,
            );
            ok(request.id, { status: 'queued' });
            if (delayedPrompt !== null) {
              ok(delayedPrompt, { stopReason: 'end_turn' });
              delayedPrompt = null;
            }
          } else if (request.method === 'session/cancel') {
            if (delayedPrompt !== null) {
              ok(delayedPrompt, { stopReason: 'cancelled' });
              delayedPrompt = null;
            }
            if (request.id !== undefined) ok(request.id, {});
          } else if (request.id !== undefined) {
            ok(request.id, {});
          }
        }
      });
    `,
  });
}

function createFixture(
  dir: string,
  scenario: string,
): Readonly<{
  dependencies: PublicAcpComposerDependencies;
  options: Readonly<{
    transport: Extract<AgentAcpRuntimeOptions['transport'], { kind: 'stdio' }>;
  }>;
  resolve: ReturnType<typeof vi.fn>;
  requestInteraction: ReturnType<typeof createApprovalRequestMock>;
  registerMediaSourceRoot: ReturnType<typeof vi.fn>;
  publishGeneratedMedia: ReturnType<typeof vi.fn>;
  disposeMediaSourceRoot: ReturnType<typeof vi.fn>;
  setCurrent(value: boolean): void;
  readModes(): ReturnType<ReturnType<typeof createNativeAgentSessionPublications>['modesSource']['read']>;
  readModels(): ReturnType<Parameters<PublicAcpComposerDependencies['models']['bind']>[0]['read']>;
  readModelPublications(): ReadonlyArray<
    ReturnType<Parameters<PublicAcpComposerDependencies['models']['bind']>[0]['read']>
  >;
}> {
  const scriptPath = writePublicComposerAgent(dir);
  const mediaPath = path.join(dir, 'generated', 'generated.png');
  const resolve = vi.fn(async () => ({
    toolId: 'fixture-acp',
    launch: {
      kind: 'binary',
      executablePath: process.execPath,
      args: [scriptPath],
      env: {
        PUBLIC_ACP_SCENARIO: scenario,
        PUBLIC_ACP_MEDIA_PATH: mediaPath,
      },
    },
  }));
  const requestInteraction = createApprovalRequestMock();
  let current = true;
  const signal = new AbortController().signal;
  const publications = createNativeAgentSessionPublications({
    agentId: 'acme-agent', session: null, signal, isCurrent: () => current, supportsInFlightSteer: false,
  });
  const publishGeneratedMedia = vi.fn(async () => ({ status: 'published' as const }));
  const disposeMediaSourceRoot = vi.fn();
  const registerMediaSourceRoot = vi.fn(async () => Object.freeze({
    publishGenerated: publishGeneratedMedia,
    dispose: disposeMediaSourceRoot,
  }));
  let publishedModels: ReturnType<Parameters<PublicAcpComposerDependencies['models']['bind']>[0]['read']> = {
    models: null,
  };
  const modelPublications: Array<typeof publishedModels> = [];
  return {
    resolve,
    requestInteraction,
    registerMediaSourceRoot,
    publishGeneratedMedia,
    disposeMediaSourceRoot,
    setCurrent: (value) => { current = value; },
    readModes: () => publications.modesSource.read(),
    readModels: () => publishedModels,
    readModelPublications: () => modelPublications,
    dependencies: {
      pluginId: 'acme.plugin',
      agentId: 'acme-agent',
      signal,
      isCurrent: () => current,
      modes: publications.services.modes,
      systemTools: { resolve },
      interactions: new TestInteractions((request, options) => {
        if (request.kind !== 'approval') throw new Error(`Unexpected ${request.kind} interaction`);
        return requestInteraction(request, options);
      }),
      media: Object.freeze({ registerSourceRoot: registerMediaSourceRoot }),
      models: Object.freeze({
        bind(source) {
          const apply = (snapshot: typeof publishedModels) => {
            publishedModels = snapshot;
            modelPublications.push(snapshot);
          };
          apply(source.read());
          const subscription = source.subscribe(apply);
          return Object.freeze({ dispose: () => subscription.dispose() });
        },
      }),
    },
    options: {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'fixture-acp' },
        timeouts: { initializeMs: 2_000, idleMs: 20 },
      },
    },
  };
}

async function collectUntil(
  events: AgentSessionRuntimeEvent[],
  kind: AgentSessionRuntimeEvent['kind'],
): Promise<void> {
  await waitForCondition(
    () => events.some((event) => event.kind === kind),
    { timeoutMs: 5_000, intervalMs: 10, label: `public ACP event ${kind}` },
  );
}

function createHistoryDefinition(): AgentAcpRuntimeDefinition {
  const readPromptIndex = (value: unknown): number | null => (
    Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
  );
  const readCheckpoint = (value: unknown): number | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const checkpoint = value as Readonly<Record<string, unknown>>;
    return checkpoint.kind === 'grok_prompt_index'
      ? readPromptIndex(checkpoint.promptIndex)
      : null;
  };
  return {
    mcp: { policy: 'drop' },
    history: {
      projectUserMessageProviderCheckpoint(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
        const meta = (input as Readonly<Record<string, unknown>>)._meta;
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
        const promptIndex = readPromptIndex((meta as Readonly<Record<string, unknown>>).promptIndex);
        return promptIndex === null
          ? null
          : { kind: 'grok_prompt_index', promptIndex };
      },
      fork: {
        methods: ['x.ai/session/fork', '_x.ai/session/fork'],
        buildParams({
          sourceProviderSessionId,
          sourceCwd,
          newCwd,
          providerCheckpoint,
        }) {
          const promptIndex = providerCheckpoint === undefined
            ? null
            : readCheckpoint(providerCheckpoint);
          if (providerCheckpoint !== undefined && promptIndex === null) {
            throw new Error('exact history fork requires a provider checkpoint');
          }
          return {
            sourceSessionId: sourceProviderSessionId,
            sourceCwd,
            newCwd,
            ...(promptIndex === null ? {} : { targetPromptIndex: promptIndex }),
          };
        },
        readProviderSessionId(response) {
          if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
          const value = (response as Readonly<Record<string, unknown>>).newSessionId;
          return typeof value === 'string' ? value : null;
        },
      },
      createConversationRollback(session) {
        return {
          async rollback(request, options) {
            const target = request.affectedTurns.find((turn) => turn.turnId === request.target.turnId);
            const promptIndex = readCheckpoint(target?.providerCheckpoint);
            if (promptIndex === null || session.getProviderSessionId() !== request.providerSessionId) {
              return {
                status: 'rejected',
                retryable: false,
                diagnostic: { code: 'history_checkpoint_unavailable', severity: 'error' },
              };
            }
            await session.requestExtension(['x.ai/rewind/execute'], {
              sessionId: request.providerSessionId,
              targetPromptIndex: promptIndex,
              mode: 'conversation_only',
            }, { signal: options?.signal });
            return { status: 'applied' };
          },
          async reconcile() {
            return {
              status: 'outcomeUnknown',
              diagnostic: { code: 'history_reconciliation_unavailable', severity: 'error' },
            };
          },
        };
      },
    },
  };
}

describe('createPublicAcpSession', () => {
  it.skipIf(process.platform !== 'linux').each(['create', 'resume', 'executionRun'] as const)(
    'refuses a host-private Oh My Pi provider extension through the real %s ACP launch', async kind => {
      await withTempDir('omp-member-provider-', async dir => {
        const fixture = createFixture(dir, 'default');
        const resolved = await fixture.resolve();
        fixture.resolve.mockResolvedValue({ ...resolved, toolId: 'ohmypi-cli' });
        const mcp = await prepareSessionMcpLocalTransport({ agentUid: process.getuid!(), runtimeRoot: dir });
        const controller = new AbortController();
        const exec = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
          resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => dir,
          requesterIdentity: { kind: 'isolated', separationRequired: false, requester: {
            serverId: 'home', accountId: 'owner', machineId: 'team-machine', installationId: 'installation' } },
          agentIsolation: { read: () => ({ enabled: true,
            status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [dir],
            localTransport: { agentUid: 2402, agentGid: 2402 },
            launch: { managedHappierBinaryPath: '/nonexistent/happier', runtimeHome: path.join(dir, 'native-runtime'),
              selectedEnvironmentKeys: [], selectedMaterials: [], sessionMcpContext: mcp.localContext } }) },
        });
        const dependencies = { ...fixture.dependencies, exec };
        const connectedAccounts = { getBinding: async () => null, materialize: async () => { throw new Error('No selected account'); },
          watch: (_purpose: unknown, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
            queueMicrotask(() => listener({ kind: 'resync', authorityChanged: false })); return { dispose() {} };
          } };
        // Connected Account observation and the executable resolver are system boundaries.
        // The actual OMP factory, ACP composer and native finalizer remain real.
        const context = { signal: controller.signal, services: { connectedAccounts }, protocols: { acp: {
          open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => createPublicAcpSession(request, options, dependencies),
          openExecutionRunV1: (request: AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) => createPublicAcpExecutionRun(request, options, dependencies),
        } } } as unknown as AgentSessionRuntimeContext & AgentExecutionRunRuntimeContextV1;
        const runtime = await createOhMyPiAgentRuntime({ plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
          agent: { id: 'ohmypi' }, signal: controller.signal });
        const providerBinding = { connectionId: 'gateway', upstream: { protocol: 'openai-responses',
          normalizedUrl: 'http://127.0.0.1:7777/v1', credential: 'apiKey' as const },
          model: { id: 'selected-model', name: 'Selected' }, materialization: { v: 1 as const, kind: 'configFile' as const,
            rootPath: dir, relativePaths: ['provider.mjs'] } };
        await writeFile(path.join(dir, 'provider.mjs'), 'export default function() {}', { mode: 0o600 });
        try {
          if (!runtime.sessions) throw new Error('ACP runtime has no Session surface');
          const opening = kind === 'executionRun'
            ? runtime.sessions.executionRunContextV1!.open({ kind: 'create', runId: 'member-run', cwd: dir,
              profile: { pluginId: 'happier.agent.ohmypi', localId: 'default' }, input: { text: 'Run once' }, providerBinding }, context)
            : runtime.sessions.open({ ...(kind === 'resume' ? { kind: 'resume', providerSessionId: 'native' } as const : { kind: 'create' } as const),
              sessionId: 'member-session', cwd: dir, providerBinding }, context);
          await expect(opening).rejects.toMatchObject({ code: 'agent_launch_required_file_unavailable' });
        } finally { controller.abort(); await mcp.retire(); }
      });
    });

  it('preserves the captured standard tool name across sparse updates in public events', async () => {
    await withTempDir('happier-public-acp-standard-tool-', async dir => {
      const fixture = createFixture(dir, 'captured-standard-tool-name');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'standard-tool', cwd: dir },
        fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['input'], input: { text: 'probe' }, delivery: { kind: 'newTurn', turnId: 'turn' } });
        await collectUntil(events, 'turn-complete');
        expect(events.filter(event => event.kind === 'tool-call').at(-1)).toMatchObject({
          toolName: 'write_file', input: { path: 'probe-ok.txt', content: 'ok', _acp: { name: 'write_file' } },
        });
        expect(events.filter(event => event.kind === 'tool-result')).toMatchObject([{ toolCallId: '<T1>' }]);
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });
  it('projects plugin ACP update diagnostics and MCP identity without changing turn lifecycle', async () => {
    await withTempDir('happier-public-acp-plugin-updates-', async dir => {
      const fixture = createFixture(dir, 'plugin-session-updates');
      const diagnostics: unknown[] = [];
      const definition = {
        mcp: { policy: 'drop' as const },
        sessionUpdates: {
          project(update: JsonValue) {
            if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
            const input = update as Readonly<Record<string, JsonValue>>;
            const meta = input._meta;
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
            const native = (meta as Readonly<Record<string, JsonValue>>).example;
            if (!native || typeof native !== 'object' || Array.isArray(native)) return null;
            const extension = native as Readonly<Record<string, JsonValue>>;
            if (input.sessionUpdate === 'session_info_update') {
              return { diagnostic: { code: 'provider_recovery', severity: 'info' as const,
                message: 'Provider recovery', details: extension.recovery ?? null } };
            }
            return { toolMetadata: { internal: false, mcp: { server: 'docs', tool: 'lookup' } } };
          },
        },
      };
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'plugin-updates', cwd: dir },
        { ...fixture.options, definition }, { ...fixture.dependencies,
          transcripts: { async publishSessionEvent(event: unknown) { diagnostics.push(event); return { status: 'custodied' as const }; } } });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['plugin-input'], input: { text: 'probe' }, delivery: { kind: 'newTurn', turnId: 'plugin-turn' } });
        await collectUntil(events, 'turn-complete');
        await session.drainPendingPublications();
        expect(diagnostics).toHaveLength(5);
        expect(diagnostics[0]).toMatchObject({ type: 'message', diagnostic: { details: { state: 'active', attempt: 2, delaySeconds: 3 } } });
        expect(events.filter(event => event.kind === 'tool-call').at(-1)).toMatchObject({ toolName: 'mcp__docs__lookup', input: { _acp: { mcp: { server: 'docs', tool: 'lookup' }, internal: false } } });
        const results = events.filter(event => event.kind === 'tool-result');
        expect(results).toHaveLength(2);
        expect(new Set(results.map(event => event.toolCallId)).size).toBe(1);
        expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(1);
        expect(events.filter(event => event.kind === 'turn-failed')).toEqual([]);
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });
  it('projects FX native recovery through the real ACP transport after turn admission', async () => {
    await withTempDir('happier-public-acp-fx-retry-', async dir => {
      const fixture = createFixture(dir, 'fx-session-updates');
      const diagnostics: unknown[] = [];
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'fx-retry', cwd: dir },
        { ...fixture.options, definition: { mcp: { policy: 'drop' }, sessionUpdates: FX_SESSION_UPDATES } },
        { ...fixture.dependencies, transcripts: { async publishSessionEvent(event: unknown) {
          diagnostics.push(event); return { status: 'custodied' as const };
        } } });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(AgentSessionRuntimeEventSchema.parse(event)); });
      try {
        await session.drainPendingPublications();
        expect(diagnostics).toContainEqual(expect.objectContaining({
          diagnostic: expect.objectContaining({ details: expect.objectContaining({ attempt: 99 }) }),
        }));
        expect(events.filter(event => event.kind === 'turn-progress')).toEqual([]);
        await session.send({ inputIds: ['fx-input'], input: { text: 'probe' },
          delivery: { kind: 'newTurn', turnId: 'fx-turn' } });
        await collectUntil(events, 'turn-complete');
        expect(events.filter(event => event.kind === 'turn-progress')
          .map(event => ({ turnId: event.turnId, retry: event.retry ?? null }))).toEqual([
          { turnId: 'fx-turn', retry: { attempt: 2, reason: 'rate_limited' } },
          { turnId: 'fx-turn', retry: null },
          { turnId: 'fx-turn', retry: null },
        ]);
        expect(events.findIndex(event => event.kind === 'turn-start'))
          .toBeLessThan(events.findIndex(event => event.kind === 'turn-progress'));
        expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(1);
        expect(events.filter(event => event.kind === 'turn-failed' || event.kind === 'turn-cancelled')).toEqual([]);
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it('rejects a valid unsupported MCP policy update without treating the SDK carrier as malformed', async () => {
    await withTempDir('happier-public-acp-mcp-update-', async dir => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'mcp-update', cwd: dir },
        fixture.options, fixture.dependencies);
      try {
        if (!session.updateConfiguration) throw new Error('Expected the ACP configuration update boundary');
        await expect(session.updateConfiguration({
          mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
          mcpToolPolicy: { docs: { unlisted: 'ask', tools: { read_page: 'off' } } },
        })).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'acp_mcp_tool_policy_update_unsupported' } });
        await expect(session.updateConfiguration({
          mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
          providerBinding: { connectionId: 'fixture-provider', model: { id: 'fixture-model', name: 'Fixture model' },
            upstream: { protocol: 'openai_chat_completions', normalizedUrl: 'https://example.test/v1', credential: 'none' },
            materialization: { v: 1, kind: 'spawnEnv' } },
        })).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'acp_provider_binding_update_unsupported' } });
      } finally { await session.dispose(); }
    });
  });

  it.each(['agy-auth-setup', 'agy-auth-required', 'agy-auth-wrong-code'])('retains the declared authentication setup category through the real composer (%s)', async scenario => {
    await withTempDir('public-acp-auth-diagnostic-', async dir => {
      const fixture = createFixture(dir, scenario);
      const { definition } = buildAntigravityAcpRuntimeOptions({});
      const failure = await createPublicAcpSession({ kind: 'create', sessionId: 'auth-diagnostic', cwd: dir },
        { ...fixture.options, definition }, { ...fixture.dependencies, agentId: 'antigravity' })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const record = createAcpRequestFailureLogRecord({ operation: 'NewSession', error: failure });
      expect(record).toEqual({ operation: 'NewSession', failureKind: 'provider_rejection',
        requestErrorMessage: expect.any(String),
        requestErrorCode: scenario === 'agy-auth-wrong-code' ? -32603 : -32000,
        ...(scenario === 'agy-auth-setup' ? { authenticationSetupFailure: true } : {}),
      });
      expect((failure as Error & { data?: unknown }).data).toEqual({});
      const safeOutput = JSON.stringify({ record, message: (failure as Error).message, data: (failure as Error & { data?: unknown }).data });
      expect(safeOutput).not.toContain('onboarding_failed');
      expect(safeOutput).not.toContain('provider-secret-value');
      expect(safeOutput).not.toContain('nested-secret-value');
    });
  });

  it.each(['whole', 'create', 'resume', 'execution', 'quoted', 'code', 'user-only'] as const)(
    'classifies Antigravity invalid-key native output without completing a failed turn (%s)', async kind => {
      await withTempDir('happier-antigravity-invalid-key-', async dir => {
        const fixture = createFixture(dir, `agy-api-key-${kind}`);
        const { definition } = buildAntigravityAcpRuntimeOptions({ GEMINI_API_KEY: 'fixture-invalid-key' });
        const options = { ...fixture.options, definition };
        const failureCause = { phase: 'turn', failureReason: 'authentication_required',
          providerErrorMessage: 'API key not valid. Please pass a valid API key.' };
        if (kind === 'execution') {
          const run = await createPublicAcpExecutionRun({ kind: 'create', runId: 'invalid-key-run', cwd: dir,
            profile: { pluginId: 'happier.agent.antigravity', localId: 'antigravity' },
            localInputId: 'invalid-key-input', input: { text: 'hello' },
          }, options, fixture.dependencies);
          const events: AgentExecutionRunEvent[] = [];
          const subscription = run.watch(event => events.push(event));
          try {
            await expect.poll(() => events.some(event => event.kind === 'run-failed' || event.kind === 'run-complete')).toBe(true);
            expect(events).toContainEqual(expect.objectContaining({ kind: 'run-failed', diagnostic: expect.objectContaining({
              code: 'acp_turn_failed', details: expect.objectContaining({ failureCause }),
            }) }));
            expect(events.some(event => event.kind === 'run-complete')).toBe(false);
          } finally { subscription.dispose(); await run.dispose(); }
          return;
        }
        const session = await createPublicAcpSession(kind === 'resume'
          ? { kind: 'resume', sessionId: 'invalid-key-session', providerSessionId: 'native-session', cwd: dir }
          : { kind: 'create', sessionId: 'invalid-key-session', cwd: dir }, options, fixture.dependencies);
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = session.watch(event => events.push(event));
        try {
          await session.send({ inputIds: ['invalid-key-input'], input: { text: 'hello' }, delivery: { kind: 'newTurn', turnId: 'invalid-key-turn' } });
          await expect.poll(() => events.some(event => event.kind === 'turn-failed' || event.kind === 'turn-complete')).toBe(true);
          const failure = events.find(event => event.kind === 'turn-failed');
          if (kind === 'quoted' || kind === 'code' || kind === 'user-only') {
            expect(failure).toBeUndefined();
            expect(events.some(event => event.kind === 'turn-complete')).toBe(true);
          } else {
            expect(failure).toMatchObject({ diagnostic: { code: 'acp_turn_failed', details: { failureCause } } });
            expect(events.some(event => event.kind === 'turn-complete')).toBe(false);
            expect(events.filter(event => event.kind === 'message-delta' && event.channel === 'assistant')
              .map(event => event.kind === 'message-delta' ? event.text : '').join('')).toBe(failureCause.providerErrorMessage);
            if (failure?.kind !== 'turn-failed') throw new Error('Missing native failure');
            expect(classifyPrimarySessionRuntimeIssue({ provider: 'antigravity', cause: 'session_error', error: failure.diagnostic }))
              .toMatchObject({ status: 'failed', failureCause });
          }
        } finally { subscription.dispose(); await session.dispose(); }
      });
    },
  );

  it.each(['agy-quota-chunked', 'agy-quota-prior-text', 'agy-quota-quoted', 'agy-quota-refused'])('classifies declared provider quota diagnostics through actual ACP delivery (%s)', async scenario => {
    await withTempDir('happier-public-quota-diagnostic-', async dir => {
      const fixture = createFixture(dir, scenario);
      const diagnostic = 'Usage Limit Reached\n\nYou have reached your current quota for this period.';
      const serviceId = 'happier.agent.antigravity/antigravity-account';
      const { definition } = buildAntigravityAcpRuntimeOptions({});
      if (!definition?.usageLimitDiagnostic) throw new Error('Expected the provider quota diagnostic declaration');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'selected-quota', cwd: dir,
        launchEnvironment: { unset: [], values: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'group', serviceId,
          groupId: 'selected-pool', activeProfileId: 'selected-profile', fallbackProfileId: 'fallback', generation: 4,
          credentialRevision: 'csr_abcdefghijklmnopqrstuv', policy: null }]) } },
      }, { ...fixture.options, definition }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['quota-input'], input: { text: 'continue' }, delivery: { kind: 'newTurn', turnId: 'quota-turn' } });
        await waitForCondition(() => events.some(event => event.kind === 'turn-failed' || event.kind === 'turn-complete'),
          { timeoutMs: 5000, intervalMs: 10, label: 'quota terminal outcome' });
        const failure = events.find(event => event.kind === 'turn-failed');
        if (scenario === 'agy-quota-quoted') expect(failure).toBeUndefined();
        else if (scenario === 'agy-quota-refused') expect(failure).toMatchObject({ diagnostic: { code: 'acp_turn_refused' } });
        else {
          expect(failure?.kind === 'turn-failed' ? failure.diagnostic.code : null,
            failure?.kind === 'turn-failed' ? failure.diagnostic.message : undefined).toBe('provider_usage_limit');
          expect(failure).toMatchObject({ diagnostic: { code: 'provider_usage_limit', details: { runtimeAuthClassification: {
            kind: 'usage_limit', serviceId, profileId: 'selected-profile', groupId: 'selected-pool', groupGeneration: 4,
            expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv', source: 'stable_provider_message',
          } } } });
          expect(events.map(event => event.kind)).not.toContain('turn-complete');
          const assistantText = events.filter(event => event.kind === 'message-delta' && event.channel === 'assistant')
            .map(event => event.kind === 'message-delta' ? event.text : '').join('');
          expect(assistantText).toContain(diagnostic);
          expect(assistantText).toContain('Earlier assistant output.');
        }
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it.each(['completed', 'prompt-effect-unobserved', 'max_tokens', 'max_turn_requests'] as const)('projects witnessed ACP consumption through an Execution Run without creating a Session identity (%s)', async scenario => {
    await withTempDir('happier-public-acp-execution-run-', async (dir) => {
      const fixture = createFixture(dir, scenario);
      const run = await createPublicAcpExecutionRun({
        kind: 'create',
        runId: 'execution-run-1',
        cwd: dir,
        profile: { pluginId: 'acme.plugin', localId: 'acme-agent' },
        localInputId: 'execution-input-1',
        input: { text: 'hello' },
      }, fixture.options, fixture.dependencies);
      const events: AgentExecutionRunEvent[] = [];
      const subscription = run.watch((event) => { events.push(event); });
      try {
        await vi.waitFor(() => {
          expect(
            events.some((event) => event.kind === (scenario === 'completed' ? 'run-complete' : 'run-failed')),
            JSON.stringify(events),
          ).toBe(true);
        });
        expect(events.map((event) => event.kind)).toContain('checkpoint');
        if (scenario === 'completed') {
          expect(events).toContainEqual(expect.objectContaining({ kind: 'output-delta', text: 'hello from ACP' }));
          expect(events.some(event => event.kind === 'run-failed')).toBe(false);
          await expect(run.send({ text: 'A finite Run cannot accept another turn' })).resolves.toMatchObject({ status: 'unavailable' });
        } else if (scenario === 'prompt-effect-unobserved') {
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'run-failed', diagnostic: expect.objectContaining({ code: 'acp_input_custody_unknown' }),
          }));
        } else {
          expect(events).toContainEqual(expect.objectContaining({ kind: 'output-delta', text: 'incomplete ACP output' }));
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'run-failed', diagnostic: expect.objectContaining({
              code: 'acp_turn_failed', details: expect.objectContaining({ stopReason: scenario }),
            }),
          }));
          expect(events.some(event => event.kind === 'run-complete')).toBe(false);
        }
        expect(events.every((event) => event.runId === 'execution-run-1')).toBe(true);
        expect(events.every((event) => !('sessionId' in event))).toBe(true);
      } finally {
        subscription.dispose();
        await run.dispose();
      }
    });
  });

  it.each(['configured', 'codex', 'declarative', 'kilo'] as const)('keeps a %s detached ACP conversation usable across completed turns', async (agent) => {
    await withTempDir('happier-public-acp-retained-run-', async (dir) => {
      const fixture = createFixture(dir, 'retained-conversation');
      const agentId = agent === 'configured' ? 'custom-acp' : agent === 'declarative' ? 'acme-agent' : agent;
      const pluginId = agent === 'declarative' ? 'acme.plugin' : `happier.agent.${agentId}`;
      const runtime = agent === 'configured' ? createCustomAcpAgentRuntime()
        : agent === 'codex' ? await createCodexAgentRuntime({} as Parameters<typeof createCodexAgentRuntime>[0])
        : agent === 'kilo' ? await createKiloAgentRuntime({} as Parameters<typeof createKiloAgentRuntime>[0])
        : await createHostDeclarativeAcpAgentRuntimeFactory({ ...fixture.options, definition: { mcp: { policy: 'pass_through' } } },
          { executionRunContextV1: true })({} as Parameters<typeof createCodexAgentRuntime>[0]);
      const factory = runtime.sessions!.executionRunContextV1!;
      const runFixture = createAcpExecutionRunRuntimeContextFixture({
        pluginId, agentId, executionRunId: 'retained-acp',
        directory: dir, signal: fixture.dependencies.signal,
        protocols: { acp: {
          open: async () => { throw new Error('Detached Run cannot open a Happier Session'); },
          openExecutionRunV1: (request, options) => createPublicAcpExecutionRun(request, options, fixture.dependencies),
          openExecutionRunConversationV1: (request, options) => createPublicAcpExecutionRunConversation(request, {
            ...options, transport: { ...fixture.options.transport,
              ...(options.transport.kind === 'stdio' && options.transport.env ? { env: options.transport.env } : {}),
            },
          }, fixture.dependencies),
        } },
      });
      const { context } = runFixture;
      const request = { kind: 'create' as const, runId: context.executionRun.id,
        cwd: dir, profile: { pluginId, localId: 'default' },
        launchEnvironment: { values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' }, unset: [] },
        configuration: AgentSessionConfigurationSnapshotV1Schema.parse({
          mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
        }),
        input: { text: 'initial input belongs to the host' },
      };
      const conversation = await factory.openConversation!(request, context);
      const events: AgentExecutionRunConversationEventV1[] = [];
      const subscription = conversation.watch(event => events.push(event));
      try {
        expect(events.some(event => event.kind === 'turn-start' || event.kind === 'turn-complete')).toBe(false);
        for (const [index, turnId] of ['turn-1', 'turn-2', 'turn-3'].entries()) {
          await expect(conversation.send({ inputIds: [turnId], input: { text: turnId },
            delivery: { kind: 'newTurn', turnId },
          }, agent === 'kilo' ? { permissionIntent: 'default' } : undefined)).resolves.toMatchObject({ status: 'admitted' });
          await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId })));
          const output = events.filter(event => event.kind === 'message-delta' && event.turnId === turnId)
            .map(event => event.kind === 'message-delta' ? event.text : '').join('');
          expect(JSON.parse(output)).toMatchObject({ turn: index + 1, previousInput: index === 0 ? null : `turn-${index}`,
            ...(agent === 'kilo' ? { nativePolicy: { '*': 'ask', read: 'allow', write: 'ask', bash: 'ask' } } : {}),
          });
        }
        expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(3);
        expect(events.every(event => !('sessionId' in event))).toBe(true);
        if (agent === 'kilo') {
          await expect(conversation.send({ inputIds: ['narrowed-input'], input: { text: 'cannot change launch-only policy' },
            delivery: { kind: 'newTurn', turnId: 'narrowed-turn' },
          }, { permissionIntent: 'read-only' })).resolves.toMatchObject({ status: 'unsupported' });
          expect(events.some(event => 'turnId' in event && event.turnId === 'narrowed-turn')).toBe(false);
        }
        const laterEvents: AgentExecutionRunConversationEventV1[] = [];
        const laterSubscription = conversation.watch(event => laterEvents.push(event));
        laterSubscription.dispose();
        expect(laterEvents.some(event => event.kind === 'turn-complete')).toBe(false);
        const olderHostContext = { ...context, protocols: { acp: {
          ...context.protocols.acp, openExecutionRunConversationV1: undefined,
        } } };
        await expect(Promise.resolve().then(() => factory.openConversation!(request, olderHostContext)))
          .rejects.toMatchObject({ code: 'execution_run_protocol_unsupported' });
        if (agent === 'kilo') {
          await conversation.dispose();
          const unsafeLaunches: readonly Pick<AgentExecutionRunOpenRequest, 'launchEnvironment' | 'configuration'>[] = [
            { launchEnvironment: { values: { KILO_PERMISSION: '{"*":"allow"}' }, unset: [] } },
            { launchEnvironment: { values: {}, unset: ['KILO_PERMISSION'] } },
            { configuration: { ...request.configuration, mode: { value: 'yolo', updatedAtMs: 1 } } },
          ];
          for (const unsafeLaunch of unsafeLaunches) {
            const overridden = await factory.openConversation!({ ...request, ...unsafeLaunch }, context);
            const overriddenEvents: AgentExecutionRunConversationEventV1[] = [];
            const overriddenWatch = overridden.watch(event => overriddenEvents.push(event));
            try {
              await expect(overridden.send({ inputIds: ['overridden-input'], input: { text: 'must not prompt' },
                delivery: { kind: 'newTurn', turnId: 'overridden-turn' },
              }, { permissionIntent: 'default' })).resolves.toMatchObject({ status: 'unsupported' });
              expect(overriddenEvents.some(event => 'turnId' in event && event.turnId === 'overridden-turn')).toBe(false);
            } finally { overriddenWatch.dispose(); await overridden.dispose(); }
          }
        }
      } finally { subscription.dispose(); await conversation.dispose(); await runFixture.dispose(); }
    });
  });

  it.each(['mapped', 'unmapped'] as const)('enforces raw ACP input policy before native prompts despite an explicit wider mode (%s)', async (mapping) => {
    await withTempDir('happier-public-acp-input-policy-', async dir => {
      const fixture = createFixture(dir, 'configuration-update-input-policy');
      const authored = applyAcpBackendUpsertV1({ settings: undefined, nowMs: 1, backend: {
        id: 'raw-policy', name: 'raw-policy', title: 'Raw policy',
        launch: { kind: 'command', command: 'fixture-agent', args: [] },
        runtime: { permissionModeMapping: {
          default: null, yolo: 'bypass', plan: 'plan', 'safe-yolo': 'smart', 'read-only': mapping === 'mapped' ? ['missing', 'ask'] : null,
        } },
      } });
      expect(authored).toMatchObject({ ok: true });
      if (!authored.ok) throw new Error('Configured runtime declaration must be authorable');
      const opened = openAcpCatalogContentV1({ mode: 'plain', material: null,
        // Persisted Account content is JSON, not the author's optional undefined fields.
        content: { t: 'plain', v: JSON.parse(JSON.stringify({ v: 1, definitions: [authored.backend] })) },
      });
      expect(opened).toMatchObject({ status: 'opened' });
      if (opened.status !== 'opened') throw new Error('Configured runtime declaration must survive stored ingress');
      const backend = resolveConfiguredAcpBackendFromAccountSettings({}, 'raw-policy', {
        status: 'ready', revision: 1, record: opened.record,
      });
      if (!backend) throw new Error('Configured ACP definition must resolve');
      const conversation = await createPublicAcpExecutionRunConversation({ kind: 'create', runId: 'raw-policy', cwd: dir,
        profile: { pluginId: 'acme.plugin', localId: 'default' }, input: { text: 'host owns this input' },
        configuration: { mode: { value: 'bypass', updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: 'yolo', updatedAtMs: 1 }, options: {} },
      }, { ...fixture.options, definition: configuredAcpRuntimeConfiguration(backend) }, fixture.dependencies);
      const events: AgentExecutionRunConversationEventV1[] = [];
      conversation.watch(event => events.push(event));
      try {
        for (const [index, permissionIntent] of (['plan', 'read-only'] as const).entries()) {
          const turnId = `policy-${index}`;
          const result = await conversation.send({ inputIds: [turnId], input: { text: 'report configuration' },
            delivery: { kind: 'newTurn', turnId },
          }, { permissionIntent });
          if (mapping === 'unmapped' && permissionIntent === 'read-only') {
            expect(result).toMatchObject({ status: 'unsupported' });
            expect(events.some(event => 'turnId' in event && event.turnId === turnId)).toBe(false);
          } else {
            expect(result).toMatchObject({ status: 'admitted' });
            await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId })));
            expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId,
              text: JSON.stringify({ selectedMode: permissionIntent === 'plan' ? 'plan' : 'ask', selectedModel: null, selectedOptions: {} }),
            }));
          }
        }
      } finally { await conversation.dispose(); }
    });
  });

  it.each([false, true])('removes selected-purpose mixed-case keys after ACP launch overlays while native launches retain them (host resolved=%s)', async (hostResolved) => {
    await withTempDir('happier-public-acp-environment-unset-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const nativeValues = Object.freeze({
        AGY_ACP_CCPA_BASE_URL: 'https://native.example',
        agy_acp_ccpa_project: 'native-project',
        PUBLIC_ACP_USER_TOOL_VALUE: 'user-tool',
      });
      fixture.resolve.mockResolvedValue({
        toolId: 'fixture-acp',
        launch: {
          kind: 'binary', executablePath: process.execPath,
          args: [path.join(dir, 'public-composer-agent.mjs')], env: nativeValues,
        },
      });
      for (const connected of [true, false]) {
        const capturePath = path.join(dir, `environment-${connected}.json`);
        const session = await createPublicAcpSession({
          kind: 'create', sessionId: `environment-${connected}`, cwd: dir,
          launchEnvironment: {
            values: { PUBLIC_ACP_ENV_CAPTURE: capturePath },
            unset: connected ? ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'] : [],
          },
        }, fixture.options, {
          ...fixture.dependencies,
          ...(hostResolved ? { resolveHostLaunch: async () => ({
            command: process.execPath,
            args: [path.join(dir, 'public-composer-agent.mjs')],
            env: nativeValues, unsetEnv: [], timeouts: {},
          }) } : {}),
        });
        try {
          expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual({
            baseUrl: connected ? null : nativeValues.AGY_ACP_CCPA_BASE_URL,
            project: connected ? null : nativeValues.agy_acp_ccpa_project,
            toolValue: nativeValues.PUBLIC_ACP_USER_TOOL_VALUE,
          });
        } finally {
          await session.dispose();
        }
      }
    });
  });

  it('uses the host-owned launch resolver for Account-configured ACP without invoking public system-tool resolution', async () => {
    await withTempDir('happier-public-acp-host-launch-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const resolveHostLaunch = vi.fn(async () => ({
        command: process.execPath,
        args: [path.join(dir, 'public-composer-agent.mjs')],
        env: {
          PUBLIC_ACP_SCENARIO: 'completed',
          PUBLIC_ACP_MEDIA_PATH: path.join(dir, 'generated', 'generated.png'),
          HOST_ONLY_VALUE: 'kept',
        },
        unsetEnv: ['REMOVED_VALUE'],
        timeouts: { initializeMs: 2_000, idleMs: 20 },
      }));
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-configured-acp',
        cwd: dir,
        launchEnvironment: {
          values: {
            HOST_ONLY_VALUE: 'overridden',
            REQUEST_VALUE: 'present',
          },
          unset: ['REMOVED_VALUE'],
        },
      }, fixture.options, {
        ...fixture.dependencies,
        resolveHostLaunch,
      });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-host-configured'],
          input: { text: 'hello' },
          delivery: { kind: 'newTurn', turnId: 'turn-host-configured' },
        });
        await collectUntil(events, 'turn-complete');
        expect(resolveHostLaunch).toHaveBeenCalledWith(expect.objectContaining({
          cwd: dir,
          launchEnvironment: expect.objectContaining({
            values: expect.objectContaining({ REQUEST_VALUE: 'present' }),
          }),
        }));
        expect(fixture.resolve).not.toHaveBeenCalled();
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('preserves ACP session capability evidence through Cursor output diagnostics', async () => {
    await withTempDir('happier-cursor-acp-capabilities-', async (dir) => {
      const fixture = createFixture(dir, 'capabilities');
      const composed = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-cursor-capabilities',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const session = withCursorEmptyResponseFailure(composed);
      try {
        expect(session.runtimeCapabilities?.sessionCapabilities).toMatchObject({
          sessionListing: 'supported',
          sessionFork: { conversation: 'supported', protocol: 'acp' },
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('exposes negotiated list, close, and delete through the public ACP runtime', async () => {
    await withTempDir('happier-public-acp-lifecycle-', async (dir) => {
      const fixture = createFixture(dir, 'capabilities');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-lifecycle', cwd: dir,
      }, fixture.options, fixture.dependencies);
      try {
        await expect(session.listSessions({ cwd: dir, cursor: ' page\n1 ' }))
          .resolves.toEqual({
            sessions: [{
              sessionId: ' provider\nsession ',
              cwd: dir,
              title: 'Provider session',
              updatedAt: '2026-09-13T08:30:00.000Z',
            }],
            nextCursor: ' page\n2 ',
          });
        await expect(session.closeSession(' provider\nsession ')).resolves.toBeUndefined();
        await expect(session.deleteSession(' provider\nsession ')).resolves.toBeUndefined();
      } finally {
        await session.dispose();
      }
    });
  });

  it('fails closed when ACP does not advertise optional listing or fork capabilities', async () => {
    await withTempDir('happier-public-acp-capabilities-closed-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-capabilities-closed', cwd: dir,
      }, fixture.options, fixture.dependencies);
      try {
        expect(session.runtimeCapabilities?.sessionCapabilities).toMatchObject({
          sessionListing: 'unsupported',
          sessionFork: {
            conversation: 'unsupported',
            fromMessage: 'unsupported',
          },
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('projects ACP reasoning and usage observations through the canonical runtime event stream', async () => {
    await withTempDir('happier-public-acp-runtime-observations-', async (dir) => {
      const fixture = createFixture(dir, 'runtime-observations');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-runtime-observations', cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-runtime-observations'],
          input: { text: 'observe' },
          delivery: { kind: 'newTurn', turnId: 'turn-runtime-observations' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-runtime-observations',
          channel: 'reasoning',
          text: 'reasoning trace',
        }));
        const usage = events.find((event) => event.kind === 'usage-observed');
        expect(usage).toMatchObject({
          kind: 'usage-observed',
          turnId: 'turn-runtime-observations',
          source: 'acp-usage-update',
          scope: 'session_cumulative',
          context: expect.objectContaining({
            usedTokens: 21,
            windowTokens: 200_000,
            source: 'provider_turn',
          }),
        });
        expect(usage).not.toHaveProperty('tokens');
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('transforms the raw ACP session/prompt request at the provider dispatch boundary', async () => {
    await withTempDir('happier-public-acp-request-transform-', async (dir) => {
      const fixture = createFixture(dir, 'request-transform');
      const transformAgentRequest = vi.fn(async (payload: Readonly<Record<string, unknown>>) => {
        const request = payload.request as Readonly<Record<string, unknown>>;
        const prompt = request.prompt as readonly Readonly<Record<string, unknown>>[];
        const text = prompt.find((block) => block.type === 'text')?.text;
        return text === 'invalid transform source'
          ? { ...payload, request: { ...request, prompt: 'invalid' } }
          : {
              ...payload,
              request: {
                ...request,
                prompt: [{ type: 'text', text: 'transformed by plugin hook' }],
              },
            };
      });
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-request-transform',
        cwd: dir,
      }, fixture.options, {
        ...fixture.dependencies,
        transformAgentRequest,
      } satisfies PublicAcpComposerDependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-request-transform'],
          input: { text: 'original prompt' },
          delivery: { kind: 'newTurn', turnId: 'turn-request-transform' },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');

        expect(transformAgentRequest).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: 'host-request-transform',
          agentId: 'acme-agent',
          runtimeFamily: 'acpSession',
          method: 'session/prompt',
          request: expect.objectContaining({
            sessionId: 'provider-created',
            prompt: [{ type: 'text', text: 'original prompt' }],
          }),
          timestampMs: expect.any(Number),
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-request-transform',
          text: 'transformed by plugin hook',
        }));

        await expect(session.send({
          inputIds: ['input-invalid-request-transform'],
          input: { text: 'invalid transform source' },
          delivery: { kind: 'newTurn', turnId: 'turn-invalid-request-transform' },
        })).resolves.toEqual({ status: 'admitted' });
        await waitForCondition(
          () => events.filter((event) => event.kind === 'turn-complete').length === 2,
          { timeoutMs: 5_000, intervalMs: 10, label: 'second public ACP turn completion' },
        );

        expect(transformAgentRequest).toHaveBeenCalledTimes(2);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-invalid-request-transform',
          text: 'invalid transform source',
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('settles real non-detached ACP disposal through native descendant discovery', async () => {
    await withTempDir('happier-public-acp-process-census-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-process-census',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const outcome = await Promise.race([
        Promise.resolve(session.dispose()).then(() => 'disposed' as const),
        new Promise<'timedOut'>((resolve) => {
          setTimeout(() => resolve('timedOut'), 3_000);
        }),
      ]);

      expect(outcome).toBe('disposed');
    });
  }, 20_000);

  it('launches a declared managed-dependency ACP transport and releases its executable lease', async () => {
    await withTempDir('happier-public-acp-managed-dependency-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const release = vi.fn();
      const resolveManagedDependency = vi.fn(async () => ({
        command: process.execPath,
        args: [writePublicComposerAgent(dir)],
        release,
      }));
      const dependencies = {
        ...fixture.dependencies,
        managedDependencies: { resolve: resolveManagedDependency },
      } satisfies PublicAcpComposerDependencies;

      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-managed-dependency',
        cwd: dir,
      }, {
        ...fixture.options,
        transport: {
          ...fixture.options.transport,
          executable: { kind: 'managedDependency', id: 'codex-acp' },
        },
      }, dependencies);
      expect(resolveManagedDependency).toHaveBeenCalledWith({
        pluginId: fixture.dependencies.pluginId,
        dependencyId: 'codex-acp',
        signal: fixture.dependencies.signal,
      });
      expect(fixture.resolve).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();

      await session.dispose();
      await session.dispose();
      expect(release).toHaveBeenCalledOnce();
    });
  });

  it('passes the stdio preferred path through the canonical system-tool resolver', async () => {
    await withTempDir('happier-public-acp-preferred-path-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-preferred-path',
        cwd: dir,
      }, {
        ...fixture.options,
        transport: {
          ...fixture.options.transport,
          preferredPath: '/opt/cursor-agent',
        },
      }, fixture.dependencies);
      try {
        expect(fixture.resolve).toHaveBeenCalledWith({
          toolId: 'fixture-acp',
          purpose: 'agent-acp:acme-agent',
          cwd: dir,
          preferredPath: '/opt/cursor-agent',
          signal: fixture.dependencies.signal,
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it.each([1, 9])('projects all %i images from one terminal provider output through the existing session media service exactly once', async (imageCount) => {
    await withTempDir('happier-public-acp-generated-media-', async (dir) => {
      const fixture = createFixture(dir, 'generated-media');
      const mediaPath = path.join(dir, 'generated', 'generated.png');
      const mediaPaths = Array.from({ length: imageCount }, (_, index) => path.join(dir, 'generated', `generated-${index}.png`));
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-generated-media',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          generatedMedia: {
            projectTerminalOutput({ rawOutput }) {
              if (
                typeof rawOutput !== 'object'
                || rawOutput === null
                || Array.isArray(rawOutput)
              ) {
                return null;
              }
              const output = rawOutput as Readonly<Record<string, unknown>>;
              if (output.type !== 'ImageGen' || output.path !== mediaPath) return null;
              return mediaPaths.map(imagePath => ({ rootPath: path.dirname(mediaPath), path: imagePath }));
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-generated-media'],
          input: { text: 'generate' },
          delivery: { kind: 'newTurn', turnId: 'turn-generated-media' },
        });
        await collectUntil(events, 'turn-complete');
        await waitForCondition(
          () => fixture.publishGeneratedMedia.mock.calls.length === imageCount,
          { timeoutMs: 2_000, intervalMs: 10, label: 'generated media publication' },
        );

        expect(fixture.registerMediaSourceRoot).toHaveBeenCalledTimes(imageCount);
        expect(fixture.registerMediaSourceRoot).toHaveBeenCalledWith({
          rootPath: path.dirname(mediaPath),
        });
        expect(fixture.publishGeneratedMedia.mock.calls.map(([input]) => input.path)).toEqual(mediaPaths);
        expect(fixture.publishGeneratedMedia.mock.calls.every(([input]) => input.toolCallId === 'generated-image-1')).toBe(true);
        expect(fixture.disposeMediaSourceRoot).toHaveBeenCalledTimes(imageCount);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('rejects a late terminal media result after the native generation becomes stale', async () => {
    await withTempDir('happier-public-acp-generated-media-stale-', async (dir) => {
      const fixture = createFixture(dir, 'generated-media-stale');
      const mediaPath = path.join(dir, 'generated', 'generated.png');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-generated-media-stale',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          generatedMedia: {
            projectTerminalOutput: () => [{
              rootPath: path.dirname(mediaPath),
              path: mediaPath,
            }],
          },
        },
      }, fixture.dependencies);
      try {
        const sending = session.send({
          inputIds: ['input-generated-media-stale'],
          input: { text: 'generate' },
          delivery: { kind: 'newTurn', turnId: 'turn-generated-media-stale' },
        });
        fixture.setCurrent(false);
        await sending;
        await new Promise((resolve) => setTimeout(resolve, 250));

        expect(fixture.registerMediaSourceRoot).not.toHaveBeenCalled();
        expect(fixture.publishGeneratedMedia).not.toHaveBeenCalled();
      } finally {
        await session.dispose();
      }
    });
  });

  it('rejects a projected path outside its claimed source root before registration', async () => {
    await withTempDir('happier-public-acp-generated-media-root-', async (dir) => {
      const fixture = createFixture(dir, 'generated-media');
      const mediaPath = path.join(dir, 'generated', 'generated.png');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-generated-media-wrong-root',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          generatedMedia: {
            projectTerminalOutput: () => [{
              rootPath: path.join(dir, 'untrusted-root'),
              path: mediaPath,
            }],
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-generated-media-wrong-root'],
          input: { text: 'generate' },
          delivery: { kind: 'newTurn', turnId: 'turn-generated-media-wrong-root' },
        });
        await collectUntil(events, 'turn-complete');
        await session.dispose();

        expect(fixture.registerMediaSourceRoot).not.toHaveBeenCalled();
        expect(fixture.publishGeneratedMedia).not.toHaveBeenCalled();
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('refuses hands-off before launching an ACP Agent with provider-owned filesystem access', async () => {
    await withTempDir('happier-public-acp-hands-off-', async (dir) => {
      const fixture = createFixture(dir, 'configuration-update');
      await expect(createPublicAcpSession({
        kind: 'create', sessionId: 'hands-off', cwd: dir,
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'yolo', updatedAtMs: 0 }, options: {}, workspaceWrites: 'deny' },
      }, fixture.options, fixture.dependencies)).rejects.toMatchObject({ code: 'role_policy_unenforceable' });
    });
  });

  it.each(['empty', 'config', 'current'])('preserves catalog observation semantics for %s through ACP transport', async (kind) => {
    await withTempDir('happier-public-acp-observation-', async (dir) => {
      const fixture = createFixture(dir, `model-observation-${kind}`);
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'model-observation', cwd: dir }, {
        ...fixture.options, definition: { mcp: { policy: 'drop' }, modelConfigOptionId: 'model' },
      }, fixture.dependencies);
      try {
        if (kind === 'empty' || kind === 'config') {
          expect(fixture.readModels()).toMatchObject({ currentModelId: 'current', models: [], observedAt: expect.any(Number) });
          expect(fixture.readModels().observedAt).toBeGreaterThan(0);
        } else {
          const observedAt = fixture.readModels().observedAt ?? 0;
          await session.send({ inputIds: ['observation-input'], input: { text: 'continue' }, delivery: { kind: 'newTurn', turnId: 'observation-turn' } });
          await vi.waitFor(() => expect(fixture.readModels().currentModelId).toBe('next'));
          expect(fixture.readModels().observedAt).toBeGreaterThanOrEqual(observedAt);
          expect(fixture.readModels().models).toEqual([]);
        }
      } finally { await session.dispose(); }
    });
  });

  it.each(['create', 'resume'] as const)('publishes negotiated modes and initial selection before the first prompt on %s, then retires the source', async (kind) => {
    await withTempDir('happier-public-acp-modes-', async (dir) => {
      const fixture = createFixture(dir, 'mode-publication');
      const identity = kind === 'resume'
        ? { kind, providerSessionId: 'provider-resume' }
        : { kind };
      const session = await createPublicAcpSession({
        ...identity, sessionId: 'host-modes', cwd: dir,
        configuration: {
          mode: { value: 'auto_edit', updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 }, options: {},
        },
      }, { ...fixture.options, definition: { mcp: { policy: 'drop' } } }, fixture.dependencies);
      try {
        expect(fixture.readModes()).toMatchObject({
          currentModeId: 'auto_edit', observedAt: expect.any(Number),
          modes: [{ id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto edit' }, { id: 'yolo', name: 'YOLO' }],
        });
        expect(fixture.readModes().observedAt).toBeGreaterThan(0);
        await session.send({ inputIds: ['mode-input'], input: { text: 'continue' }, delivery: { kind: 'newTurn', turnId: 'mode-turn' } });
        await vi.waitFor(() => expect(fixture.readModes().currentModeId).toBe('yolo'));
      } finally { await session.dispose(); }
      expect(fixture.readModes()).toEqual({ modes: null });
    });
  });

  it('applies standalone ACP configuration before the requested model and its scoped options on creation', async () => {
    await withTempDir('happier-public-acp-config-order-', async (dir) => {
      const fixture = createFixture(dir, 'config-catalog');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-config-order', cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'gpt-6-luna', updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 0 }, options: {
            provider: { value: 'codex', updatedAtMs: 1 }, fast: { value: 'true', updatedAtMs: 1 },
          },
        },
      }, { ...fixture.options, definition: { mcp: { policy: 'drop' }, modelConfigOptionId: 'model' } }, fixture.dependencies);
      try {
        expect(fixture.readModels()).toMatchObject({ currentModelId: 'gpt-6-luna', models: expect.arrayContaining([
          expect.objectContaining({ id: 'gpt-6-luna', modelOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'fast', currentValue: 'true' }),
          ]) }),
        ]) });
      } finally { await session.dispose(); }
    });
  });

  it('publishes full ACP configuration catalogs, setter responses, notification refresh and live commands', async () => {
    await withTempDir('happier-public-acp-config-catalog-', async (dir) => {
      const fixture = createFixture(dir, 'config-catalog');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-config-catalog', cwd: dir }, {
        ...fixture.options, definition: { mcp: { policy: 'drop' }, modelConfigOptionId: 'model' },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      const configEvents = () => events.filter(event => event.kind === 'config-options');
      const update = (model: string | null, options: Record<string, { value: string; updatedAtMs: number }>, at: number) => session.updateConfiguration!({
        mode: { value: null, updatedAtMs: 0 }, model: { value: model, updatedAtMs: at },
        permissionIntent: { value: null, updatedAtMs: 0 }, options,
      });
      try {
        await vi.waitFor(() => expect(configEvents().at(-1)).toMatchObject({ modelConfigOptionId: 'model', configOptions: createFxConfigOptionsFixture() }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'available-commands', commands: [] }));
        expect(fixture.readModels()).toMatchObject({ currentModelId: 'gpt-6.1-sol', models: expect.arrayContaining([
          expect.objectContaining({ id: 'gpt-6.1-sol', modelOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'effort' }), expect.objectContaining({ id: 'fast', currentValue: 'false' }),
          ]) }),
        ]) });

        await expect(update('gpt-6-luna', {}, 1)).resolves.toMatchObject({ status: 'applied' });
        await vi.waitFor(() => expect(configEvents().at(-1)).toMatchObject({ configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'model', currentValue: 'gpt-6-luna' }),
          expect.objectContaining({ id: 'effort', options: createFxConfigOptionsFixture().find(option => option.id === 'effort')!.options.filter(choice => choice.value !== 'ultra') }),
        ]) }));
        await expect(update('gpt-6-luna', { fast: { value: 'true', updatedAtMs: 2 } }, 1)).resolves.toMatchObject({ status: 'applied' });
        await vi.waitFor(() => expect(configEvents().at(-1)).toMatchObject({ configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'fast', currentValue: 'true' }),
        ]) }));
        const lastGood = configEvents().at(-1);
        await expect(update('gpt-6-luna', { provider: { value: 'gateway', updatedAtMs: 3 } }, 1)).resolves.toMatchObject({
          status: 'rejected', diagnostic: { code: 'acp_configuration_update_failed', message: expect.stringContaining('Vercel AI Gateway') },
        });
        expect(configEvents().at(-1)).toBe(lastGood);
        expect(fixture.readModels().currentModelId).toBe('gpt-6-luna');

        await session.send({ inputIds: ['config-refresh'], input: { text: 'refresh' }, delivery: { kind: 'newTurn', turnId: 'config-refresh' } });
        await collectUntil(events, 'turn-complete');
        expect(configEvents().at(-1)).toMatchObject({ configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'fast', currentValue: 'false' }),
        ]) });
        expect(events).toContainEqual(expect.objectContaining({ kind: 'available-commands', commands: [{ name: 'review', description: 'Review changes' }] }));
        await session.send({ inputIds: ['config-withdraw'], input: { text: 'withdraw catalog' }, delivery: { kind: 'newTurn', turnId: 'config-withdraw' } });
        await vi.waitFor(() => expect(configEvents().at(-1)).toMatchObject({ configOptions: [] }));
        expect(configEvents().at(-1)).not.toHaveProperty('modelConfigOptionId');
        expect(fixture.readModels()).toMatchObject({ models: [], currentModelId: 'gpt-6-luna' });
        await vi.waitFor(() => expect(events.filter(event => event.kind === 'available-commands').at(-1)).toMatchObject({ commands: [] }));
        expect(events.every(event => AgentSessionRuntimeEventSchema.safeParse(event).success)).toBe(true);
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it('publishes provider-authoritative models and model-scoped options without a requested selection', async () => {
    await withTempDir('happier-public-acp-models-', async (dir) => {
      const fixture = createFixture(dir, 'provider-models');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-provider-models',
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {},
        },
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          models: {
            projectModel(rawModel, normalizedModel) {
              const metadata = (rawModel as { _meta?: {
                reasoningEffort?: string;
                reasoningEfforts?: Array<{ value: string; label: string }>;
              } })._meta;
              if (!metadata?.reasoningEffort || !metadata.reasoningEfforts) return normalizedModel;
              return {
                ...normalizedModel,
                modelOptions: [{
                  id: 'reasoning_effort',
                  name: 'Reasoning effort',
                  type: 'select',
                  currentValue: metadata.reasoningEffort,
                  options: metadata.reasoningEfforts.map((option) => ({
                    value: option.value,
                    name: option.label.replace(/ Effort$/u, ''),
                  })),
                }],
              };
            },
            projectUpdate({ configId, value, currentModel }) {
              if (configId !== 'reasoning_effort' || typeof value !== 'string') return undefined;
              return { modelId: currentModel.id, requestMeta: { reasoningEffort: value } };
            },
            projectSetModelResponse({ response, requestedModelId, requestMeta, targetModel }) {
              const acknowledged = (response as { _meta?: { model?: { Ok?: unknown } } })?._meta?.model?.Ok;
              const effort = requestMeta?.reasoningEffort;
              if (acknowledged !== requestedModelId || typeof effort !== 'string') return null;
              return {
                ...targetModel,
                modelOptions: targetModel.modelOptions?.map((option) => option.id === 'reasoning_effort'
                  ? { ...option, currentValue: effort }
                  : option),
              };
            },
          },
        },
      }, fixture.dependencies);
      try {
        expect(fixture.readModels()).toEqual({
          observedAt: expect.any(Number),
          currentModelId: 'provider-current',
          models: [
            {
              id: 'provider-current',
              name: 'Provider current',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Reasoning effort',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              }],
            },
            { id: 'stale-host', name: 'Stale host' },
          ],
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('preserves the provider model context window in the host model snapshot', async () => {
    await withTempDir('happier-public-acp-model-context-', async (dir) => {
      const fixture = createFixture(dir, 'provider-models-context');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-provider-model-context', cwd: dir,
      }, fixture.options, fixture.dependencies);
      try {
        expect(fixture.readModels()).toEqual({
          observedAt: expect.any(Number),
          currentModelId: 'provider-current',
          models: [
            {
              id: 'provider-current',
              name: 'Provider current',
              contextWindowTokens: 200_000,
            },
            { id: 'stale-host', name: 'Stale host' },
          ],
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('applies inherited fork model options after the model without publishing the provider default first', async () => {
    await withTempDir('happier-public-acp-initial-fork-options-', async (dir) => {
      const fixture = createFixture(dir, 'history-fork-provider-models-initial');
      const session = await createPublicAcpSession({
        kind: 'fork',
        sessionId: 'host-provider-models-fork',
        cwd: dir,
        source: {
          sessionId: 'host-parent',
          providerSessionId: 'provider-parent',
          cwd: '/source-workspace',
        },
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'provider-current', updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'low', updatedAtMs: 1 } },
        },
      }, {
        ...fixture.options,
        definition: {
          ...createHistoryDefinition(),
          models: {
            projectModel(rawModel, normalizedModel) {
              const metadata = (rawModel as { _meta?: {
                reasoningEffort?: string;
                reasoningEfforts?: Array<{ value: string; label: string }>;
              } })._meta;
              if (!metadata?.reasoningEffort || !metadata.reasoningEfforts) return normalizedModel;
              return {
                ...normalizedModel,
                modelOptions: [{
                  id: 'reasoning_effort',
                  name: 'Reasoning effort',
                  type: 'select',
                  currentValue: metadata.reasoningEffort,
                  options: metadata.reasoningEfforts.map((option) => ({
                    value: option.value,
                    name: option.label.replace(/ Effort$/u, ''),
                  })),
                }],
              };
            },
            projectUpdate({ configId, value, currentModel }) {
              if (configId !== 'reasoning_effort' || typeof value !== 'string') return undefined;
              return { modelId: currentModel.id, requestMeta: { reasoningEffort: value } };
            },
            projectSetModelResponse({ response, requestedModelId, requestMeta, targetModel }) {
              const acknowledged = (response as { _meta?: { model?: { Ok?: unknown } } })?._meta?.model?.Ok;
              if (acknowledged !== requestedModelId) return null;
              const effort = requestMeta?.reasoningEffort;
              if (effort === undefined) return targetModel;
              if (typeof effort !== 'string') return null;
              return {
                ...targetModel,
                modelOptions: targetModel.modelOptions?.map((option) => option.id === 'reasoning_effort'
                  ? { ...option, currentValue: effort }
                  : option),
              };
            },
          },
        },
      }, fixture.dependencies);
      try {
        expect(fixture.readModels()).toEqual({
          observedAt: expect.any(Number),
          currentModelId: 'provider-current',
          models: [{
            id: 'provider-current',
            name: 'Provider current',
            modelOptions: [{
              id: 'reasoning_effort',
              name: 'Reasoning effort',
              type: 'select',
              currentValue: 'low',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            }],
          }],
        });
        expect(
          fixture.readModelPublications().filter((publication) => publication.models !== null),
        ).toEqual([fixture.readModels()]);
      } finally {
        await session.dispose();
      }
    });
  });

  it('composes multiple projected model options before applying initial execution configuration', async () => {
    await withTempDir('happier-public-acp-projected-model-options-', async (dir) => {
      const fixture = createFixture(dir, 'projected-config-model-options');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-projected-model-options',
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'gpt', updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {
            reasoning_effort: { value: 'low', updatedAtMs: 1 },
            service_tier: { value: 'priority', updatedAtMs: 1 },
          },
        },
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          modelConfigOptionId: 'model',
          models: buildAcpModelSuffixOptionControls({
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            values: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
            trailingOption: {
              id: 'service_tier',
              name: 'Speed',
              defaultValue: { value: 'standard', name: 'Standard' },
              values: [{ segment: 'priority', value: 'priority', name: 'Fast' }],
            },
          }),
        },
      }, fixture.dependencies);
      try {
        expect(fixture.readModels()).toMatchObject({
          currentModelId: 'gpt',
          models: [{
            id: 'gpt',
            modelOptions: [
              { id: 'reasoning_effort', currentValue: 'low' },
              { id: 'service_tier', currentValue: 'priority' },
            ],
          }],
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('awaits the private ACP adapter before publishing one complete provider model snapshot', async () => {
    await withTempDir('happier-public-acp-awaitable-models-', async (dir) => {
      const fixture = createFixture(dir, 'provider-models');
      const projectionOrder: string[] = [];
      const session = await createPublicAcpSessionFromAwaitableAdapter({
        kind: 'create',
        sessionId: 'host-awaitable-provider-models',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies, {
        async projectModel(rawModel, normalizedModel) {
          await Promise.resolve();
          projectionOrder.push(normalizedModel.id);
          const metadata = (rawModel as { _meta?: { reasoningEffort?: string } })._meta;
          return metadata?.reasoningEffort
            ? {
                ...normalizedModel,
                modelOptions: [{
                  id: 'reasoning_effort',
                  name: 'Reasoning effort',
                  type: 'select',
                  currentValue: metadata.reasoningEffort,
                }],
              }
            : normalizedModel;
        },
      });
      try {
        expect(projectionOrder).toEqual(['provider-current', 'stale-host']);
        expect(fixture.readModels()).toEqual({
          observedAt: expect.any(Number),
          currentModelId: 'provider-current',
          models: [
            {
              id: 'provider-current',
              name: 'Provider current',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Reasoning effort',
                type: 'select',
                currentValue: 'high',
              }],
            },
            { id: 'stale-host', name: 'Stale host' },
          ],
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('applies a projected active-model option through one provider set-model request without optimistic publication', async () => {
    await withTempDir('happier-public-acp-model-update-', async (dir) => {
      const observedClock = vi.spyOn(Date, 'now').mockReturnValue(100);
      const fixture = createFixture(dir, 'provider-models');
      const projectModel = (
        rawModel: unknown,
        normalizedModel: AgentAcpModel,
      ) => {
        const metadata = (rawModel as {
          _meta?: { reasoningEffort?: string; reasoningEfforts?: Array<{ value: string; label: string }> };
        })._meta;
        if (!metadata?.reasoningEffort || !metadata.reasoningEfforts) return normalizedModel;
        return {
          ...normalizedModel,
          modelOptions: [{
            id: 'reasoning_effort', name: 'Reasoning effort', type: 'select',
            currentValue: metadata.reasoningEffort,
            options: metadata.reasoningEfforts.map((option) => ({
              value: option.value, name: option.label.replace(/ Effort$/u, ''),
            })),
          }],
        };
      };
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-provider-model-update', cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'high', updatedAtMs: 1 } },
        },
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          models: {
            projectModel,
            projectUpdate({ configId, value, currentModel }) {
              if (configId !== 'reasoning_effort' || typeof value !== 'string') return undefined;
              return { modelId: currentModel.id, requestMeta: { reasoningEffort: value } };
            },
            projectSetModelResponse({ response, requestedModelId, requestMeta, targetModel }) {
              const acknowledged = (response as { _meta?: { model?: { Ok?: unknown } } })?._meta?.model?.Ok;
              const effort = requestMeta?.reasoningEffort;
              if (acknowledged !== requestedModelId || typeof effort !== 'string') return null;
              return {
                ...targetModel,
                modelOptions: targetModel.modelOptions?.map((option) => option.id === 'reasoning_effort'
                  ? { ...option, currentValue: effort }
                  : option),
              };
            },
          },
        },
      }, fixture.dependencies);
      try {
        const initial = fixture.readModels();
        observedClock.mockReturnValue(200);

        await expect(session.updateConfiguration?.({
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'provider-current', updatedAtMs: 2 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'medium', updatedAtMs: 2 } },
        })).resolves.toEqual({
          status: 'applied',
          changed: ['model', 'options.reasoning_effort'],
        });
        expect(fixture.readModels()).toMatchObject({
          currentModelId: 'provider-current',
          models: [expect.objectContaining({
            id: 'provider-current',
            modelOptions: [expect.objectContaining({
              id: 'reasoning_effort', currentValue: 'medium',
            })],
          }), { id: 'stale-host', name: 'Stale host' }],
        });
        expect(fixture.readModels()).not.toEqual(initial);
        const afterApplied = fixture.readModels();
        expect(afterApplied.observedAt).toBe(initial.observedAt);

        await expect(session.updateConfiguration?.({
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'provider-current', updatedAtMs: 2 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'low', updatedAtMs: 3 } },
        })).resolves.toMatchObject({ status: 'rejected' });
        expect(fixture.readModels()).toEqual(afterApplied);
      } finally {
        observedClock.mockRestore();
        await session.dispose();
      }
    });
  });

  it.each([
    ['oauth', {}], ['native-import', {}], ['key', { GEMINI_API_KEY: 'fake-gemini-key' }], ['missing', {}],
  ] as const)('selects Antigravity launch authentication through the real composer (%s)', async (mode, values) => {
    await withTempDir('public-acp-agy-select-', async dir => {
      const fixture = createFixture(dir, 'agy-select-' + (mode === 'native-import' ? 'oauth' : mode));
      const { definition } = buildAntigravityAcpRuntimeOptions(values);
      const opened = createPublicAcpSession({ kind: 'create', sessionId: 'agy-select', cwd: dir,
        launchEnvironment: { values, unset: [] } }, { ...fixture.options, definition }, fixture.dependencies);
      if (mode === 'missing') { await expect(opened).rejects.toMatchObject({ code: -32000 }); return; }
      const session = await opened;
      try { expect(session.getProviderSessionId()).toBe('provider-created'); }
      finally { await session.dispose(); }
    });
  });

  it('orders initialize, advertised-method verification, authentication, and session creation with closed metadata', async () => {
    await withTempDir('happier-public-acp-auth-', async (dir) => {
      const fixture = createFixture(dir, 'auth');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-auth', cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          auth: { methodId: 'cursor_login' },
          parameterizedModelPicker: true,
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-auth'],
          input: { text: 'report lifecycle' },
          delivery: { kind: 'newTurn', turnId: 'turn-auth' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            lifecycleMethods: ['initialize', 'authenticate', 'session/new'],
            initializeMetadata: { parameterizedModelPicker: true },
            newSessionMetadata: { parameterizedModelPicker: true },
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('fails before authentication/session creation when the requested auth method is not advertised', async () => {
    await withTempDir('happier-public-acp-auth-missing-', async (dir) => {
      const fixture = createFixture(dir, 'auth-missing');
      await expect(createPublicAcpSession({
        kind: 'create', sessionId: 'host-auth-missing', cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          auth: { methodId: 'cursor_login' },
          parameterizedModelPicker: true,
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies)).rejects.toThrow(/does not advertise auth method 'cursor_login'/i);
    });
  });

  it('selects authentication after initialize from bounded advertised ids and metadata', async () => {
    await withTempDir('happier-public-acp-auth-dynamic-', async (dir) => {
      const fixture = createFixture(dir, 'auth-dynamic');
      const selections: unknown[] = [];
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-auth-dynamic', cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          auth: {
            selectMethod(context) {
              selections.push(context);
              return { methodId: 'cursor_login', metadata: { selectedBy: 'plugin' } };
            },
          },
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-auth-dynamic'],
          input: { text: 'report lifecycle' },
          delivery: { kind: 'newTurn', turnId: 'turn-auth-dynamic' },
        });
        await collectUntil(events, 'turn-complete');
        expect(selections).toEqual([{
          advertisedMethodIds: ['cursor_login'],
          initializeMetadata: { defaultAuthMethodId: 'cursor_login', providerOnly: 'bounded' },
        }]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            lifecycleMethods: ['initialize', 'authenticate', 'session/new'],
            initializeMetadata: {
              client: null,
              authenticate: { selectedBy: 'plugin' },
            },
            newSessionMetadata: null,
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('revalidates a dynamic auth selection and rejects an unadvertised method before resume', async () => {
    await withTempDir('happier-public-acp-auth-dynamic-rejected-', async (dir) => {
      const fixture = createFixture(dir, 'auth-dynamic');
      await expect(createPublicAcpSession({
        kind: 'resume',
        sessionId: 'host-auth-dynamic-rejected',
        providerSessionId: 'provider-resume',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          auth: { selectMethod: () => ({ methodId: 'not-advertised' }) },
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies)).rejects.toThrow(/does not advertise auth method 'not-advertised'/i);
    });
  });

  it('does not expose oversized initialize metadata to the authentication selector', async () => {
    await withTempDir('happier-public-acp-auth-dynamic-bounded-', async (dir) => {
      const fixture = createFixture(dir, 'auth-dynamic-large');
      let observedMetadata: unknown = 'not-called';
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-auth-dynamic-bounded', cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          auth: {
            selectMethod(context) {
              observedMetadata = context.initializeMetadata;
              return { methodId: 'cursor_login' };
            },
          },
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies);
      try {
        expect(observedMetadata).toBeNull();
      } finally {
        await session.dispose();
      }
    });
  });

  it('sanitizes tool content before canonical parsing and resolves the stable public tool name', async () => {
    await withTempDir('happier-public-acp-tool-hooks-', async (dir) => {
      const fixture = createFixture(dir, 'tool-hooks');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-tool-hooks', cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          sanitizeToolUpdateContent: (update) => ({
            ...update,
            content: [{ type: 'diff', path: '/workspace/file.ts', oldText: 'clean-old', newText: 'clean-new' }],
          }),
          toolNameResolver: ({ input }) => (
            typeof input._acp === 'object' && input._acp !== null ? 'CursorEdit' : null
          ),
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-tool-hooks'],
          input: { text: 'edit' },
          delivery: { kind: 'newTurn', turnId: 'turn-tool-hooks' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'tool-call',
          toolCallId: 'cursor-tool-1',
          toolName: 'CursorEdit',
          input: expect.objectContaining({
            _acp: expect.objectContaining({
              content: [{ type: 'diff', path: '/workspace/file.ts', oldText: 'clean-old', newText: 'clean-new' }],
            }),
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('keeps standard ACP tool content unchanged when no sanitizer is configured', async () => {
    await withTempDir('happier-public-acp-tool-standard-', async (dir) => {
      const fixture = createFixture(dir, 'tool-hooks');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-tool-standard', cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-tool-standard'],
          input: { text: 'edit' },
          delivery: { kind: 'newTurn', turnId: 'turn-tool-standard' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'tool-call',
          toolCallId: 'cursor-tool-1',
          input: expect.objectContaining({
            _acp: expect.objectContaining({
              content: [{ type: 'diff', path: '/workspace/file.ts', oldText: 'dirty-old', newText: 'dirty-new' }],
            }),
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each([
    { fail: false },
    { fail: true },
  ])('delivers declared native Session MCP config through real ACP launch (failure=$fail)', async ({ fail }) => {
    await withTempDir('happier-public-acp-native-mcp-', async (dir) => {
      const sourceHome = path.join(dir, 'source');
      const sourceConfigRoot = path.join(sourceHome, '.config');
      const sourceAgentDir = path.join(sourceConfigRoot, 'fixture-agent');
      await mkdir(sourceAgentDir, { recursive: true });
      const originalConfig = { version: 3, mcpServers: { userTool: { command: 'user-tool' } } };
      await writeFile(path.join(sourceAgentDir, 'mcp_config.json'), JSON.stringify(originalConfig));
      await writeFile(path.join(sourceAgentDir, 'settings.json'), 'user-settings');
      const capturePath = path.join(dir, 'native-mcp-launch.json');
      const fixture = createFixture(dir, fail ? 'native-mcp-overlay-fail' : 'native-mcp-overlay');
      if (fixture.options.transport.kind !== 'stdio') {
        throw new Error('Expected the public ACP fixture to use stdio transport');
      }
      const options = {
        ...fixture.options,
        definition: {
          mcp: {
            policy: 'drop' as const,
            nativeSessionConfig: {
              configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
              homeRelativeConfigRoot: { posix: ['.config'], win32: ['AppData', 'Roaming'] },
              directory: 'fixture-agent',
              fileName: 'mcp_config.json',
              serversKey: 'mcpServers',
              serverEntryConstants: { transport: 'stdio' },
            },
          },
        },
      } satisfies AgentAcpRuntimeOptions;
      const opening = createPublicAcpSession({
        kind: 'create',
        sessionId: 'native-mcp-overlay',
        cwd: dir,
        mcpServers: { happier: { command: '/opt/happier-mcp', args: ['bridge'] } },
        launchEnvironment: {
          values: {
            HOME: sourceHome,
            XDG_CONFIG_HOME: sourceConfigRoot,
            NATIVE_MCP_CAPTURE: capturePath,
          },
          unset: ['DROP_ME'],
        },
      }, options, fixture.dependencies);

      const readCapture = () => JSON.parse(readFileSync(capturePath, 'utf8')) as Readonly<{
        configRoot: string | null;
        config: Readonly<{ version: number; mcpServers: Readonly<Record<string, unknown>> }> | null;
        linkedSetting: string | null;
        dropped: string | null;
      }>;

      if (fail) {
        await expect(opening).rejects.toThrow('fixture initialization rejected');
        const capture = readCapture();
        expect(capture.configRoot).toBeTruthy();
        expect(existsSync(capture.configRoot!)).toBe(false);
      } else {
        const session = await opening;
        const capture = readCapture();
        try {
          expect(capture.configRoot).toBeTruthy();
          expect(capture.configRoot).not.toBe(sourceConfigRoot);
          expect(capture.dropped).toBeNull();
          expect(capture.linkedSetting).toBe('user-settings');
          expect(capture.config).toEqual({
            version: 3,
            mcpServers: {
              userTool: { command: 'user-tool', env: { XDG_CONFIG_HOME: sourceConfigRoot } },
              happier: {
                command: '/opt/happier-mcp',
                args: ['bridge'],
                env: { XDG_CONFIG_HOME: sourceConfigRoot },
                transport: 'stdio',
              },
            },
          });
        } finally {
          await session.dispose();
          await session.dispose();
        }
        expect(existsSync(capture.configRoot!)).toBe(false);
      }
      expect(JSON.parse(readFileSync(path.join(sourceAgentDir, 'mcp_config.json'), 'utf8')))
        .toEqual(originalConfig);
    });
  });

  it.each([
    { unset: [], fail: false },
    { unset: ['HOME'], fail: false },
    { unset: ['GEMINI_CLI_HOME', 'XDG_CONFIG_HOME'], fail: false },
    { unset: [], fail: true },
  ])('keeps Gemini native home isolation through real ACP launch ($unset, failure=$fail)', async ({ unset, fail }) => {
    await withTempDir('happier-public-acp-gemini-', async (dir) => {
      const sourceHome = path.join(dir, 'source');
      const sourceSettings = path.join(sourceHome, '.gemini', 'settings.json');
      await mkdir(path.dirname(sourceSettings), { recursive: true });
      const originalSettings = { theme: 'dark', mcpServers: { unwanted: { command: 'unwanted-mcp' } } };
      await writeFile(sourceSettings, JSON.stringify(originalSettings));
      await writeFile(path.join(sourceHome, '.gemini', 'oauth_creds.json'), '{"fixture":true}');
      const capturePath = path.join(dir, 'launch.json');
      const fixture = createFixture(dir, fail ? 'gemini-overlay-fail' : 'gemini-overlay');
      const resolved = await fixture.resolve();
      fixture.resolve.mockResolvedValue({
        ...resolved,
        toolId: 'gemini-cli',
        launch: { ...resolved.launch, env: { ...resolved.launch.env, DROP_ME: 'remove-this' } },
      });
      let shapedHome: string | undefined;
      // The help command is an OS boundary; factory, shaping, composer and ACP subprocess remain real.
      const run: ExecService['run'] = async (request) => {
        shapedHome = request.env?.GEMINI_CLI_HOME;
        return {
          termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(),
          stdoutTruncated: false, stderrTruncated: false,
        };
      };
      const signal = new AbortController().signal;
      const runtime = await createGeminiAgentRuntime({
        plugin: { id: 'gemini', version: '0.0.0' }, agent: { id: 'gemini' }, signal,
      });
      // This fixture supplies only capabilities the native factory consumes, with the real host composer.
      const context = {
        signal,
        services: { exec: { run, readEnvironment: () => ({}) } },
        protocols: { acp: { open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) =>
          createPublicAcpSession(request, options, fixture.dependencies) } },
      } as unknown as AgentSessionRuntimeContext;
      if (!runtime.sessions) throw new Error('Gemini must expose sessions');
      const values: Record<string, string> = {
        HOME: sourceHome, GEMINI_CLI_HOME: sourceHome, XDG_CONFIG_HOME: path.join(sourceHome, '.config'),
        HAPPIER_GEMINI_ACP_AUTH_METHOD: 'vertex-ai', GOOGLE_CLOUD_PROJECT: 'fixture-project',
        GOOGLE_CLOUD_LOCATION: 'fixture-location', GEMINI_CAPTURE: capturePath,
      };
      for (const key of unset) delete values[key];
      const opening = runtime.sessions.open({
        kind: 'create', sessionId: 'gemini-overlay', cwd: dir,
        launchEnvironment: {
          values,
          unset: [...unset, 'DROP_ME', 'GOOGLE_GENAI_USE_VERTEXAI'],
        },
      }, context);
      if (fail) {
        await expect(opening).rejects.toThrow('fixture initialization rejected');
        expect(shapedHome).toBeTruthy();
        expect(existsSync(shapedHome!)).toBe(false);
      } else {
        const session = await opening;
        try {
          expect(shapedHome).toBeTruthy();
          expect(shapedHome).not.toBe(sourceHome);
          expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual({
            home: shapedHome, cliHome: shapedHome, xdgHome: path.join(shapedHome!, '.config'),
            settings: { theme: 'dark' }, authExists: false, dropped: null, vertex: '1',
          });
          expect(existsSync(shapedHome!)).toBe(true);
        } finally {
          await session.dispose();
          await session.dispose();
        }
        expect(existsSync(shapedHome!)).toBe(false);
      }
      expect(JSON.parse(readFileSync(sourceSettings, 'utf8'))).toEqual(originalSettings);
    });
  });

  it.each([
    { scope: 'session', requestErrorCode: 429 },
    { scope: 'run', requestErrorCode: 429 },
    { scope: 'session', requestErrorCode: -32603 },
  ] as const)('classifies Gemini numeric ACP failures through its native $scope codec ($requestErrorCode)', async ({ scope, requestErrorCode }) => {
    await withTempDir('happier-gemini-native-failure-', async dir => {
      const fixture = createFixture(dir, `gemini-request-error-${requestErrorCode}`);
      const promptCountPath = path.join(dir, 'prompt-count');
      const resolved = await fixture.resolve();
      fixture.resolve.mockResolvedValue({ ...resolved, toolId: 'gemini-cli' });
      const signal = new AbortController().signal;
      const runHelp: ExecService['run'] = async () => ({
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(),
        stdoutTruncated: false, stderrTruncated: false,
      });
      const factory = await createGeminiAgentRuntime({
        plugin: { id: 'happier.agent.gemini', version: '0.0.0' }, agent: { id: 'gemini' }, signal,
      });
      // Only OS help and the ACP subprocess are external fakes; the native factory and composer are real.
      const protocols = { acp: {
          open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => createPublicAcpSession(request, options, fixture.dependencies),
          openExecutionRunV1: (request: Parameters<typeof createPublicAcpExecutionRun>[0], options: AgentAcpRuntimeOptions) => createPublicAcpExecutionRun(request, options, fixture.dependencies),
      } };
      const unavailableServices = createUnavailablePluginServices();
      const services = { ...unavailableServices, exec: { ...unavailableServices.exec, run: runHelp, readEnvironment: () => ({}) } };
      if (!factory.sessions?.executionRunContextV1) throw new Error('Expected Gemini native Session and Run');
      const sessions = factory.sessions;
      const runs = factory.sessions.executionRunContextV1;
      const opened = await (async () => {
        if (scope === 'session') {
          const agent = PluginAgentContributionV2Schema.parse(GEMINI_PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'gemini'));
          const contextFixture = createAcpSessionRuntimeContextFixture({ agent, pluginId: 'happier.agent.gemini',
            sessionId: 'gemini-failure', directory: dir, signal, services, protocols });
          try {
            const session = await sessions.open({ kind: 'create', sessionId: 'gemini-failure', cwd: dir,
              launchEnvironment: { values: { HOME: dir, GEMINI_CLI_HOME: dir, GEMINI_API_KEY: 'fixture-gemini-key', PUBLIC_ACP_PROMPT_COUNT_PATH: promptCountPath }, unset: [] } }, contextFixture.context);
            return { native: session, session, disposeContext: () => contextFixture.dispose() };
          } catch (error) { await contextFixture.dispose(); throw error; }
        }
        const contextFixture = createAcpExecutionRunRuntimeContextFixture({ pluginId: 'happier.agent.gemini', agentId: 'gemini',
          executionRunId: 'gemini-failure', directory: dir, signal, services, protocols });
        try {
          const native = await runs.open({ kind: 'create', runId: 'gemini-failure', cwd: dir,
            profile: { pluginId: 'happier.agent.gemini', localId: 'gemini' },
            input: { text: 'hello' }, localInputId: 'gemini-input',
            launchEnvironment: { values: { HOME: dir, GEMINI_CLI_HOME: dir, GEMINI_API_KEY: 'fixture-gemini-key', PUBLIC_ACP_PROMPT_COUNT_PATH: promptCountPath }, unset: [] } }, contextFixture.context);
          return { native, session: null, disposeContext: () => contextFixture.dispose() };
        } catch (error) { await contextFixture.dispose(); throw error; }
      })();
      const native = opened.native;
      const events: Array<AgentSessionRuntimeEvent | AgentExecutionRunEvent> = [];
      const subscription = native.watch(event => { events.push(event); });
      try {
        if (opened.session) {
          await opened.session.send({ inputIds: ['gemini-input'], input: { text: 'hello' }, delivery: { kind: 'newTurn', turnId: 'gemini-turn' } });
        }
        await waitForCondition(() => events.some(event => event.kind === 'input-rejected' || event.kind === 'turn-failed' || event.kind === 'run-failed'),
          { timeoutMs: 5000, intervalMs: 10, label: 'Gemini native numeric failure' });
        const failure = events.find(event => event.kind === 'input-rejected' || event.kind === 'turn-failed' || event.kind === 'run-failed');
        if (!failure || !('diagnostic' in failure) || !failure.diagnostic) throw new Error('Expected native failed diagnostic');
        expect(failure.diagnostic).toMatchObject({ code: requestErrorCode === -32603 ? 'acp_turn_failed' : 'acp_input_rejected_before_effect', details: { requestErrorCode } });
        expect(failure.diagnostic.details).toMatchObject({ failureCause: {
          phase: 'turn', providerErrorCode: requestErrorCode,
        } });
        expect(readFileSync(promptCountPath, 'utf8')).toBe('1');
        expect(events.some(event => event.kind === 'input-accepted')).toBe(requestErrorCode === -32603);
        expect(events.some(event => event.kind === 'run-complete')).toBe(false);
        expect(JSON.stringify(failure)).not.toContain('private-provider-token');
        const adapter = createGeminiConnectedServiceRuntimeAuthAdapter();
        const classification = adapter.classifyRuntimeAuthFailure({ target: { agentId: 'gemini' }, error: failure.diagnostic,
          selection: { kind: 'group', serviceId: 'happier.agent.gemini/gemini-account', groupId: 'current-group', activeProfileId: 'current-profile', generation: 3,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv' } });
        if (requestErrorCode === 429) {
          expect(failure.diagnostic.details).toMatchObject({ runtimeAuthClassification: {
            kind: 'rate_limit', limitCategory: 'rate_limit', serviceId: 'happier.agent.gemini/gemini-account',
            profileId: null, groupId: null, source: 'structured_provider_error',
          } });
          expect(classification).toMatchObject({ kind: 'rate_limit', serviceId: 'happier.agent.gemini/gemini-account',
            profileId: 'current-profile', groupId: 'current-group', groupGeneration: 3, expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv' });
        } else {
          expect(failure.diagnostic.details).not.toHaveProperty('runtimeAuthClassification');
          expect(classification).toBeNull();
        }
      } finally {
        subscription.dispose();
        try { await native.dispose(); } finally { await opened.disposeContext(); }
      }
    });
  });

  it('composes VB4 launch environment, model, MCP, and plugin-owned static ACP policy', async () => {
    await withTempDir('happier-public-acp-vb4-', async (dir) => {
      const fixture = createFixture(dir, 'vb4');
      if (fixture.options.transport.kind !== 'stdio') {
        throw new Error('Expected the public ACP fixture to use stdio transport');
      }
      const options = {
        ...fixture.options,
        transport: {
          ...fixture.options.transport,
          env: { DROP_ME: 'transport-value' },
        },
        definition: {
          modelConfigOptionId: 'model',
          mcp: { policy: 'pass_through' },
          timeouts: {
            initMs: 2_000,
            idleMs: 20,
          },
          toolNameInference: {
            patterns: [{ name: 'read', patterns: ['read'], inputFields: ['locations'] }],
            unknownToolNames: ['Unknown tool'],
            investigationToolIdPatterns: ['index'],
            investigationToolKinds: ['investigation'],
          },
          stderrRules: {
            statusErrors: [{ includes: ['unauthorized'], detail: 'Authentication required.' }],
          },
        },
      } as const satisfies AgentAcpRuntimeOptions;
      const dependencies = {
        ...fixture.dependencies,
      };
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-vb4',
        cwd: dir,
        mcpServers: { happier: { command: 'happier-mcp', args: ['serve'] } },
        launchEnvironment: {
          values: {
            AUGMENT_SESSION_AUTH: 'host-authorized-auth',
            KEEP_ME: 'yes',
          },
          unset: ['DROP_ME'],
        },
        configuration: {
          mode: { value: null, updatedAtMs: 10 },
          model: { value: 'model-vb4', updatedAtMs: 11 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
          options: { allowIndexing: { value: true, updatedAtMs: 13 } },
        },
      }, options, dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-vb4'],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'turn-vb4' },
        });
        await collectUntil(events, 'turn-complete');

        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            auth: 'host-authorized-auth',
            keep: 'yes',
            dropped: null,
            mcpServers: [{ name: 'happier', command: 'happier-mcp', args: ['serve'], env: [] }],
            selectedModel: 'model-vb4',
          }),
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'tool-call',
          toolCallId: 'index-workspace-1',
          toolName: 'read',
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('opens the Antigravity ACP transport with its native MCP servers', async () => {
    await withTempDir('happier-public-acp-antigravity-mcp-', async (dir) => {
      const fixture = createFixture(dir, 'vb4');
      const agent = PluginAgentContributionV2Schema.parse(ANTIGRAVITY_PLUGIN_MANIFEST.contributes.agents?.[0]);
      const options = buildAntigravityAcpRuntimeOptions({});
      const runtimeOptions: AgentAcpRuntimeOptions = {
        transport: options.transport, definition: { mcp: options.definition?.mcp },
      };
      const release = vi.fn();
      const resolveManagedDependency = vi.fn(async () => ({
        command: process.execPath,
        args: [writePublicComposerAgent(dir)],
        env: { PUBLIC_ACP_SCENARIO: 'vb4' },
        release,
      }));
      const events: AgentSessionRuntimeEvent[] = [];
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-antigravity-mcp',
        cwd: dir,
        mcpServers: { happier: { command: 'happier-mcp', args: ['serve'] } },
      }, runtimeOptions, {
        ...fixture.dependencies,
        pluginId: ANTIGRAVITY_PLUGIN_MANIFEST.id,
        agentId: 'antigravity',
        managedDependencies: { resolve: resolveManagedDependency },
      });
      const subscription = session.watch((event) => { events.push(event); });

      try {
        await session.send({
          inputIds: ['input-antigravity-mcp'],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'turn-antigravity-mcp' },
        });
        await collectUntil(events, 'turn-complete');

        expect('tools' in agent.capabilities ? agent.capabilities.tools : undefined)
          .toEqual({ delivery: 'native_mcp' });
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            auth: null,
            keep: null,
            dropped: null,
            mcpServers: [{ name: 'happier', command: 'happier-mcp', args: ['serve'], env: [] }],
            selectedModel: null,
          }),
        }));
        expect(resolveManagedDependency).toHaveBeenCalledWith({
          pluginId: ANTIGRAVITY_PLUGIN_MANIFEST.id,
          dependencyId: 'agy-acp-server',
          signal: fixture.dependencies.signal,
        });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
      expect(release).toHaveBeenCalledOnce();
    });
  });

  it.each([false, true])('applies newer native configuration fields through the canonical ACP session controls (launch-only enforcement=%s)', async (launchOnly) => {
    await withTempDir('happier-public-acp-configuration-update-', async (dir) => {
      const fixture = createFixture(dir, 'configuration-update');
      const options = {
        ...fixture.options,
        definition: {
          modelConfigOptionId: 'model',
          ...(launchOnly ? {
            permissionModeArgv: {
              flag: '--approval-mode',
              map: { default: null, 'read-only': 'ask', 'safe-yolo': 'smart', yolo: 'bypass', plan: 'plan' },
            },
          } : {}),
          mcp: { policy: 'pass_through' },
        },
      } as const satisfies AgentAcpRuntimeOptions;
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-configuration-update',
        cwd: dir,
        configuration: {
          mode: { value: 'default', updatedAtMs: 10 },
          model: { value: 'model-initial', updatedAtMs: 11 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
          options: { reviewDepth: { value: 'brief', updatedAtMs: 13 } },
        },
      }, options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.updateConfiguration?.({
          mode: { value: 'plan', updatedAtMs: 20 },
          model: { value: 'model-next', updatedAtMs: 21 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
          options: { reviewDepth: { value: 'thorough', updatedAtMs: 22 } },
        })).resolves.toEqual({
          status: 'applied',
          changed: ['mode', 'model', 'options.reviewDepth'],
        });
        await expect(session.updateConfiguration?.({
          mode: { value: 'stale-mode', updatedAtMs: 19 },
          model: { value: 'stale-model', updatedAtMs: 20 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
          options: { reviewDepth: { value: 'stale-depth', updatedAtMs: 21 } },
        })).resolves.toEqual({ status: 'applied', changed: [] });
        await expect(session.updateConfiguration?.({
          mode: { value: 'must-not-partially-apply', updatedAtMs: 30 },
          model: { value: 'model-next', updatedAtMs: 21 },
          permissionIntent: { value: 'read-only', updatedAtMs: 31 },
          options: { reviewDepth: { value: 'thorough', updatedAtMs: 22 } },
        })).resolves.toMatchObject({
          status: 'unsupported',
          diagnostic: { code: 'acp_permission_intent_update_requires_provider_restart' },
        });

        await session.send({
          inputIds: ['input-configuration-update'],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'turn-configuration-update' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            selectedMode: 'plan',
            selectedModel: 'model-next',
            selectedOptions: {
              model: 'model-next',
              reviewDepth: 'thorough',
            },
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each(['absent', 'declined', 'codec'] as const)('rejects an unlisted model independently of native model mapping (resolver=%s)', async resolver => {
    await withTempDir('happier-public-acp-declined-model-', async dir => {
      const fixture = createFixture(dir, 'projected-config-models');
      const configuration = { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 }, options: {} };
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'declined-model', cwd: dir, configuration }, {
        ...fixture.options, definition: { modelConfigOptionId: 'model', mcp: { policy: 'drop' },
          ...(resolver === 'absent' ? {} : { models: { projectModel: (_raw, normalized) => normalized,
            resolveModelUpdate: ({ modelId }) => resolver === 'codec' ? { modelId } : null } }) },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => events.push(event));
      try {
        expect(await session.updateConfiguration!({ ...configuration, model: { value: 'unlisted-model', updatedAtMs: 2 } }))
          .toMatchObject({ status: 'rejected', diagnostic: { code: 'acp_model_not_available' } });
        await session.send({ inputIds: ['declined-model'], input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'declined-model' } });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: JSON.stringify({
          selectedMode: null, selectedModel: null, selectedOptions: {},
        }) }));
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it('composes public model-state projection and provider identity resolution through configuration updates', async () => {
    await withTempDir('happier-public-acp-projected-config-models-', async (dir) => {
      const fixture = createFixture(dir, 'projected-config-models');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-projected-config-models',
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {},
        },
      }, {
        ...fixture.options,
        definition: {
          modelConfigOptionId: 'model',
          mcp: { policy: 'drop' },
          models: {
            projectModel: (_rawModel, normalizedModel) => normalizedModel,
            projectModelState: ({ normalizedModelState }) => ({
              currentModelId: `projected:${normalizedModelState.currentModelId}`,
              availableModels: normalizedModelState.availableModels.map((model) => ({
                ...model,
                id: `projected:${model.id}`,
              })),
            }),
            projectModelId: ({ modelId }) => `projected:${modelId}`,
            resolveModelUpdate: ({ modelId }) => ({
              modelId: modelId.replace(/^projected:/, ''),
            }),
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.updateConfiguration?.({
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'projected:model-b', updatedAtMs: 2 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {},
        })).resolves.toEqual({ status: 'applied', changed: ['model'] });
        expect(fixture.readModels().currentModelId).toBe('projected:model-b');

        await session.send({
          inputIds: ['input-projected-config-models'],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'turn-projected-config-models' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            selectedMode: null,
            selectedModel: 'model-b',
            selectedOptions: { model: 'model-b' },
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each([
    ['default', null],
    ['read-only', 'ask'],
    ['safe-yolo', 'smart'],
    ['yolo', 'bypass'],
    ['plan', 'plan'],
  ] as const)('maps initial permission intent %s to ACP mode %s before the first prompt', async (permissionIntent, expectedMode) => {
    await withTempDir('happier-public-acp-permission-mode-', async (dir) => {
      const fixture = createFixture(dir, 'configuration-update');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: `host-permission-${permissionIntent}`,
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 10 },
          model: { value: null, updatedAtMs: 11 },
          permissionIntent: { value: permissionIntent, updatedAtMs: 12 },
          options: {},
        },
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          permissionModeMapping: {
            default: null,
            'read-only': 'ask',
            'safe-yolo': 'smart',
            yolo: 'bypass',
            plan: 'plan',
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: [`input-${permissionIntent}`],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: `turn-${permissionIntent}` },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({ selectedMode: expectedMode, selectedModel: null, selectedOptions: {} }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });


  it.each([
    ['current', 'safe-yolo', 'preferred'],
    ['legacy', 'safe-yolo', 'legacy'],
    ['both', 'safe-yolo', 'preferred'],
    ['current', 'read-only', 'ask'],
    ['unmatched', 'safe-yolo', null],
  ] as const)('applies advertised permission candidates for %s / %s', async (version, permissionIntent, expectedMode) => {
    await withTempDir('happier-public-acp-permission-candidates-', async dir => {
      const fixture = createFixture(dir, `configuration-update-candidates-${version}`);
      const opening = createPublicAcpSession({
        kind: 'create', sessionId: 'host-permission-candidates', cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: permissionIntent, updatedAtMs: 1 }, options: {},
        },
      }, { ...fixture.options, definition: { mcp: { policy: 'drop' }, permissionModeMapping: {
        default: null, 'read-only': 'ask', 'safe-yolo': ['preferred', 'legacy'],
      } } }, fixture.dependencies);
      if (expectedMode === null) {
        const failure = await opening.then(async session => {
          await session.dispose();
          return null;
        }, (error: unknown) => error);
        expect(failure).toMatchObject({ code: 'acp_permission_intent_unsupported' });
        return;
      }
      const session = await opening;
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => events.push(event));
      try {
        await session.send({ inputIds: ['permission-candidates'], input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'permission-candidates' } });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta',
          text: JSON.stringify({ selectedMode: expectedMode, selectedModel: null, selectedOptions: {} }),
        }));
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it.each(['create', 'resume'] as const)('preserves explicit native mode precedence through %s, permission changes, and clear', async (kind) => {
    await withTempDir('happier-public-acp-mode-precedence-', async (dir) => {
      const fixture = createFixture(dir, 'configuration-update-clear-retry');
      let configuration: NonNullable<AgentSessionOpenRequest['configuration']> = {
        mode: { value: 'plan', updatedAtMs: 10 },
        model: { value: null, updatedAtMs: 10 },
        permissionIntent: { value: 'safe-yolo', updatedAtMs: 10 },
        options: {},
      };
      const request: AgentSessionOpenRequest = {
        ...(kind === 'create'
          ? { kind, sessionId: 'host-mode-precedence' }
          : { kind, sessionId: 'host-mode-precedence', providerSessionId: 'provider-restored' }),
        cwd: dir,
        configuration,
      };
      const session = await createPublicAcpSession(request, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          permissionModeMapping: {
            default: null, 'read-only': 'ask', 'safe-yolo': 'smart', yolo: 'bypass', plan: 'plan',
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      let sequence = 0;
      const expectProviderMode = async (selectedMode: string) => {
        events.length = 0;
        const turnId = `turn-mode-precedence-${++sequence}`;
        await session.send({
          inputIds: [`input-mode-precedence-${sequence}`],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({ selectedMode, selectedModel: null, selectedOptions: {} }),
        }));
      };
      try {
        await expectProviderMode('plan');
        configuration = {
          ...configuration,
          permissionIntent: { value: 'read-only', updatedAtMs: 20 },
        };
        await expect(session.updateConfiguration?.(configuration)).resolves.toEqual({
          status: 'applied', changed: ['permissionIntent'],
        });
        await expectProviderMode('plan');

        configuration = { ...configuration, mode: { value: null, updatedAtMs: 30 } };
        await expect(session.updateConfiguration?.(configuration)).resolves.toMatchObject({
          status: 'rejected', diagnostic: { code: 'acp_configuration_update_failed' },
        });
        await expectProviderMode('plan');
        await expect(session.updateConfiguration?.(configuration)).resolves.toEqual({
          status: 'applied', changed: ['mode'],
        });
        await expectProviderMode('ask');

        configuration = { ...configuration, mode: { value: 'bypass', updatedAtMs: 40 } };
        await expect(session.updateConfiguration?.(configuration)).resolves.toEqual({
          status: 'applied', changed: ['mode'],
        });
        await expectProviderMode('bypass');

        configuration = {
          ...configuration,
          mode: { value: null, updatedAtMs: 35 },
          permissionIntent: { value: 'default', updatedAtMs: 50 },
        };
        await expect(session.updateConfiguration?.(configuration)).resolves.toEqual({
          status: 'applied', changed: ['permissionIntent'],
        });
        await expectProviderMode('bypass');

        configuration = { ...configuration, mode: { value: null, updatedAtMs: 60 } };
        await expect(session.updateConfiguration?.(configuration)).resolves.toEqual({
          status: 'applied', changed: ['mode'],
        });
        await expectProviderMode('bypass');

        configuration = {
          ...configuration,
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 70 },
        };
        await expect(session.updateConfiguration?.(configuration)).resolves.toEqual({
          status: 'applied', changed: ['permissionIntent'],
        });
        await expectProviderMode('smart');
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('launches Qwen with approval-mode enforcement before opening the ACP session', async () => {
    await withTempDir('happier-public-acp-qwen-permission-argv-', async (dir) => {
      await mkdir(path.join(dir, 'generated'), { recursive: true });
      const fixture = createFixture(dir, 'launch-argv');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-qwen-permission-argv',
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 10 },
          model: { value: null, updatedAtMs: 11 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
          options: {},
        },
      }, {
        ...fixture.options,
        definition: QWEN_ACP_RUNTIME_DEFINITION,
      }, fixture.dependencies);
      try {
        const capturePath = path.join(dir, 'generated', 'generated.png');
        await waitForCondition(
          () => existsSync(capturePath),
          { timeoutMs: 5_000, intervalMs: 10, label: 'Qwen launch argv capture' },
        );
        expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual([
          '--approval-mode',
          'auto-edit',
        ]);
      } finally {
        await session.dispose();
      }
    });
  });

  it('fails closed before spawn when declared launch enforcement cannot map the requested permission intent', async () => {
    await withTempDir('happier-public-acp-permission-argv-unmapped-', async (dir) => {
      const fixture = createFixture(dir, 'launch-argv');
      await expect(createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-permission-argv-unmapped',
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 10 },
          model: { value: null, updatedAtMs: 11 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
          options: {},
        },
      }, {
        ...fixture.options,
        definition: {
          mcp: { policy: 'drop' },
          permissionModeArgv: {
            flag: '--approval-mode',
            map: { default: null },
          },
        },
      }, fixture.dependencies)).rejects.toThrow(
        "ACP permission intent 'safe-yolo' has no launch-time enforcement mapping.",
      );
      expect(fixture.resolve).not.toHaveBeenCalled();
    });
  });

  it('serializes overlapping configuration updates so an older provider response cannot win', async () => {
    await withTempDir('happier-public-acp-configuration-concurrent-', async (dir) => {
      const fixture = createFixture(dir, 'configuration-update-concurrent');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-configuration-concurrent',
        cwd: dir,
        configuration: {
          mode: { value: 'default', updatedAtMs: 10 },
          model: { value: null, updatedAtMs: 10 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 10 },
          options: {},
        },
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        const older = session.updateConfiguration?.({
          mode: { value: 'slow-old', updatedAtMs: 20 },
          model: { value: null, updatedAtMs: 10 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 10 },
          options: {},
        });
        const newer = session.updateConfiguration?.({
          mode: { value: 'newest', updatedAtMs: 30 },
          model: { value: null, updatedAtMs: 10 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 10 },
          options: {},
        });
        await expect(Promise.all([older, newer])).resolves.toEqual([
          { status: 'applied', changed: ['mode'] },
          { status: 'applied', changed: ['mode'] },
        ]);

        await session.send({
          inputIds: ['input-configuration-concurrent'],
          input: { text: 'report configuration' },
          delivery: { kind: 'newTurn', turnId: 'turn-configuration-concurrent' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            selectedMode: 'newest',
            selectedModel: null,
            selectedOptions: {},
          }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('routes ACP tool approval through the public current-session interaction service', async () => {
    await withTempDir('happier-public-acp-permission-', async (dir) => {
      const fixture = createFixture(dir, 'permission');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-permission',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-permission'],
          input: { text: 'run pwd' },
          delivery: { kind: 'newTurn', turnId: 'turn-permission' },
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
          },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');

        expect(fixture.requestInteraction).toHaveBeenCalledTimes(1);
        expect(fixture.requestInteraction).toHaveBeenCalledWith({
          kind: 'approval',
          title: 'Allow execute?',
          subject: {
            kind: 'tool',
            name: 'execute',
            input: { command: 'pwd' },
          },
          allowSessionPersistence: true,
          nativeChoices: {
            requirementId: expect.any(String),
            source: 'acp',
            choices: [
              { id: 'allow-once', label: 'Allow once', scope: 'once', decision: 'approved',
                response: { approved: true, decision: 'approved' } },
              { id: 'allow-session', label: 'Allow for session', scope: 'localPersistent', decision: 'approved',
                response: { approved: true, decision: 'approved' } },
              { id: 'reject-once', label: 'Deny', scope: 'once', decision: 'denied',
                response: { approved: false, decision: 'denied' } },
            ],
          },
        }, expect.objectContaining({
          signal: expect.any(AbortSignal),
          permissionContext: {
            turnId: 'turn-permission',
            causalPermissionAuthority: {
              kind: 'admittedSessionInputV1',
              admittedPermissionCeiling: 'read-only',
            },
          },
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-permission',
          text: JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
        }));
        const toolCalls = events.filter((event) => event.kind === 'tool-call');
        expect(new Set(toolCalls.map((event) => event.toolCallId))).toEqual(new Set(['tool-call-1']));
        for (const event of toolCalls) {
          expect(event).toMatchObject({
            turnId: 'turn-permission',
            toolName: 'execute',
            input: expect.objectContaining({ command: 'pwd' }),
          });
          expect(event.sequence).toBeLessThan(events.find((candidate) => candidate.kind === 'turn-complete')!.sequence);
        }
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('keeps public turns distinct when ACP reuses a tool-call id', async () => {
    await withTempDir('happier-public-acp-permission-correlation-', async (dir) => {
      const fixture = createFixture(dir, 'permission');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-permission-correlation',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-permission-first'],
          input: { text: 'run pwd first' },
          delivery: { kind: 'newTurn', turnId: 'turn-permission-first' },
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
          },
        });
        await collectUntil(events, 'turn-complete');

        await session.send({
          inputIds: ['input-permission-second'],
          input: { text: 'run pwd second' },
          delivery: { kind: 'newTurn', turnId: 'turn-permission-second' },
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
          },
        });
        await waitForCondition(
          () => events.filter((event) => event.kind === 'turn-complete').length === 2,
          { timeoutMs: 5_000, intervalMs: 10, label: 'second correlated ACP permission turn' },
        );

        const completedTurns = events.flatMap((event) => (
          event.kind === 'turn-complete' ? [event.turnId] : []
        ));
        expect(completedTurns).toEqual([
          'turn-permission-first',
          'turn-permission-second',
        ]);
        expect(fixture.requestInteraction).toHaveBeenCalledTimes(2);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('maps create and an official completed turn into one ordered public lifecycle', async () => {
    await withTempDir('happier-public-acp-completed-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-session',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-1'],
          input: { text: 'hello' },
          delivery: { kind: 'newTurn', turnId: 'turn-1' },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');

        expect(events.map(event => event.kind)).toEqual([
          'provider-session-id',
          'input-accepted',
          'turn-start',
          'message-delta',
          'turn-complete',
        ]);
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'provider-session-id',
            providerSessionId: 'provider-created',
          }),
          expect.objectContaining({
            kind: 'input-accepted',
            inputIds: ['input-1'],
          }),
          expect.objectContaining({
            kind: 'message-delta',
            turnId: 'turn-1',
            text: 'hello from ACP',
          }),
        ]));
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'host-session' });
        expect(events.map((event) => invariant.observe(event).status)).toEqual(events.map(() => 'accepted'));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-start', startedBy: 'host' }));
        expect(events.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('maps protocol validation rejection before provider effect to input-rejected', async () => {
    await withTempDir('happier-public-acp-prompt-rejected-', async (dir) => {
      const fixture = createFixture(dir, 'prompt-rejected-before-effect');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-prompt-rejected',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-prompt-rejected'],
          input: { text: 'reject this' },
          delivery: { kind: 'newTurn', turnId: 'turn-prompt-rejected' },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'input-rejected');

        expect(events).toContainEqual(expect.objectContaining({
          kind: 'input-rejected',
          inputIds: ['input-prompt-rejected'],
          retryable: true,
          diagnostic: expect.objectContaining({
            code: 'acp_input_rejected_before_effect',
            message: 'prompt rejected before effect',
          }),
        }));
        expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
        expect(events.some((event) => event.kind === 'turn-start')).toBe(false);
        expect(JSON.stringify(events)).not.toMatch(/private-api-token|private-error-data/u);
        const history: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
        const project = createRuntimeFailureTranscriptProjector({ provider: 'test-agent', providerName: 'Test Agent', session: {
          sessionId: 'host-prompt-rejected', enqueueAgentMessageCommitted: async (provider, body, options) => {
            TranscriptRawAgentContentV1Schema.parse({ type: 'acp', agentId: provider, data: body });
            history.push({ body, meta: options.meta });
            return { persisted: true, delivered: false };
          },
        } });
        for (const event of events) await project(event);
        expect(history).toMatchObject([{ body: { type: 'message', message: expect.stringContaining('prompt rejected before effect') },
          meta: { runtimeIssueCode: 'acp_input_rejected_before_effect', runtimeIssueRequestErrorCode: -32602 } }]);
        expect(history.some(row => row.body.type === 'turn_failed')).toBe(false);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each(['opencode-quota-error', 'opencode-generation-error', 'prompt-connection-rejected', 'prompt-long-rejected'])(
    'settles a terminal prompt-processing error without output as a failed turn (%s)', async scenario => {
      await withTempDir('happier-public-acp-provider-error-', async dir => {
        const fixture = createFixture(dir, scenario);
        const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-provider-error', cwd: dir },
          fixture.options, fixture.dependencies);
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = session.watch(event => { events.push(event); });
        try {
          await session.send({ inputIds: ['provider-error-input'], input: { text: 'hello' },
            delivery: { kind: 'newTurn', turnId: 'provider-error-turn' } });
          await waitForCondition(() => events.some(event => event.kind === 'turn-failed' || event.kind === 'input-rejected'),
            { timeoutMs: 5000, intervalMs: 10, label: 'terminal prompt error' });
          expect(events.map(event => event.kind)).toEqual([
            'provider-session-id', 'input-accepted', 'turn-start', 'turn-failed',
          ]);
          const failure = events.find(event => event.kind === 'turn-failed');
          if (!failure || failure.kind !== 'turn-failed') throw new Error('Expected a failed provider turn');
          expect(failure.diagnostic).toMatchObject({ code: 'acp_turn_failed', details: { requestErrorCode: -32603 } });
          const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure.diagnostic });
          if (scenario === 'opencode-quota-error') {
            expect(issue).toMatchObject({ source: 'usage_limit', usageLimit: { limitCategory: 'usage_limit' } });
          } else if (scenario === 'opencode-generation-error') {
            expect(failure.diagnostic.message).toContain('Cannot connect to API: Unable to connect. Is the computer able to access the url?');
            expect(issue.source).not.toBe('usage_limit');
          }
          const invariant = createAgentSessionTurnInvariant({ sessionId: 'host-provider-error' });
          expect(events.map(event => invariant.observe(event).status)).toEqual(events.map(() => 'accepted'));
          const history: ACPMessageData[] = [];
          const project = createRuntimeFailureTranscriptProjector({ provider: 'test-agent', providerName: 'Test Agent', session: {
            sessionId: 'host-provider-error', enqueueAgentMessageCommitted: async (_provider, body) => {
              history.push(body);
              return { persisted: true, delivered: false };
            },
          } });
          for (const event of events) await project(event);
          expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_failed' })]));
          expect(JSON.stringify({ events, history })).not.toMatch(/private-api-token|private-error-data/u);
        } finally { subscription.dispose(); await session.dispose(); }
      });
    },
  );

  it('settles consumed input before publishing a failed turn after provider output', async () => {
    await withTempDir('happier-public-acp-prompt-ambiguous-', async (dir) => {
      const fixture = createFixture(dir, 'prompt-rejected-after-update');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-prompt-ambiguous',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-prompt-ambiguous'],
          input: { text: 'maybe accepted' },
          delivery: { kind: 'newTurn', turnId: 'turn-prompt-ambiguous' },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-failed');

        expect(events.map(event => event.kind)).toEqual([
          'provider-session-id',
          'input-accepted',
          'turn-start',
          'message-delta',
          'turn-failed',
        ]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-prompt-ambiguous',
          text: 'provider output before rejected response',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'input-accepted', inputIds: ['input-prompt-ambiguous'],
          delivery: { kind: 'newTurn', turnId: 'turn-prompt-ambiguous' },
        }));
        expect(events.some((event) => event.kind === 'input-custody-unknown')).toBe(false);
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'host-prompt-ambiguous' });
        expect(events.map((event) => invariant.observe(event).status)).toEqual(events.map(() => 'accepted'));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-start', startedBy: 'host' }));
        const history: ACPMessageData[] = [];
        const project = createRuntimeFailureTranscriptProjector({ provider: 'test-agent', providerName: 'Test Agent', session: {
          sessionId: 'host-prompt-ambiguous', enqueueAgentMessageCommitted: async (provider, body) => {
            TranscriptRawAgentContentV1Schema.parse({ type: 'acp', agentId: provider, data: body });
            history.push(body);
            return { persisted: true, delivered: false };
          },
        } });
        for (const event of events) await project(event);
        expect(history).toContainEqual({ type: 'message', message: expect.stringContaining('prompt response lost after output') });
        expect(history).toContainEqual({ type: 'turn_failed', id: 'turn-prompt-ambiguous' });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each(['after-output', 'before-effect', 'refused'] as const)('streams a successor reply after a settled prompt failure (%s)', async failurePhase => {
    await withTempDir('happier-public-acp-recovery-', async dir => {
      const fixture = createFixture(dir, `prompt-recovery-${failurePhase}`);
      const sessionId = 'host-prompt-recovery';
      const session = await createPublicAcpSession({ kind: 'create', sessionId, cwd: dir }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId });
      const subscription = session.watch(event => {
        events.push(event);
        expect(invariant.observe(event).status).toBe('accepted');
      });
      try {
        await session.send({ inputIds: ['failed-input'], input: { text: 'first prompt' },
          delivery: { kind: 'newTurn', turnId: 'failed-turn' } });
        await collectUntil(events, failurePhase === 'before-effect' ? 'input-rejected' : 'turn-failed');
        await session.send({ inputIds: ['resend-input'], input: { text: 'resend after recovery' },
          delivery: { kind: 'newTurn', turnId: 'recovered-turn' } });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId: 'recovered-turn', text: 'recovered reply' }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'input-accepted', inputIds: ['resend-input'],
          delivery: { kind: 'newTurn', turnId: 'recovered-turn' } }));
        expect(events.filter(event => event.kind === 'input-custody-unknown')).toEqual([]);
        expect(events.filter(event => event.kind === 'turn-complete')).toEqual([
          expect.objectContaining({ turnId: 'recovered-turn' }),
        ]);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('preserves unknown input custody without starting a turn when no provider effect is observed', async () => {
    await withTempDir('happier-public-acp-effect-unobserved-', async (dir) => {
      const fixture = createFixture(dir, 'prompt-effect-unobserved');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-effect-unobserved', cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-unobserved'], input: { text: 'unknown effect' },
          delivery: { kind: 'newTurn', turnId: 'turn-unobserved' },
        });
        await collectUntil(events, 'runtime-ended');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'input-custody-unknown', inputIds: ['input-unobserved'],
        }));
        expect(events.some((event) => event.kind === 'input-accepted' || event.kind.startsWith('turn-'))).toBe(false);
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'host-effect-unobserved' });
        expect(events.map((event) => invariant.observe(event).status)).toEqual(events.map(() => 'accepted'));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('fails an admitted ACP turn before ending after a malformed publication', async () => {
    await withTempDir('happier-public-acp-malformed-publication-', async dir => {
      const fixture = createFixture(dir, 'malformed-publication');
      const sessionId = 'host-malformed-publication';
      const session = await createPublicAcpSession({ kind: 'create', sessionId, cwd: dir }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId });
      const observations: string[] = [];
      const subscription = session.watch(event => {
        events.push(event);
        observations.push(invariant.observe(event).status);
      });
      try {
        await session.send({ inputIds: ['malformed-input'], input: { text: 'begin' },
          delivery: { kind: 'newTurn', turnId: 'malformed-turn' } });
        await collectUntil(events, 'message-delta');
        await session.requestExtension('acme/malformed_publication', { sessionId: 'provider-created' });
        await collectUntil(events, 'runtime-ended');
        expect(events.filter(event => event.kind === 'turn-failed' || event.kind === 'runtime-ended')).toMatchObject([
          { kind: 'turn-failed', turnId: 'malformed-turn', diagnostic: { code: 'agent_runtime_event_invalid' } },
          { kind: 'runtime-ended', cause: 'protocolError', diagnostic: { code: 'agent_runtime_event_invalid' } },
        ]);
        expect(events.filter(event => event.kind === 'message-delta')).toMatchObject([{ text: 'accepted output' }]);
        expect(observations.every(status => status === 'accepted')).toBe(true);
        await expect(session.send({ inputIds: ['after-failure'], input: { text: 'must not reach ACP' },
          delivery: { kind: 'newTurn', turnId: 'after-failure' } })).resolves.toMatchObject({
          status: 'unavailable', retryable: false, diagnostic: { code: 'agent_runtime_event_invalid' },
        });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('terminalizes the public ACP producer when its lifecycle listener fails', async () => {
    await withTempDir('happier-public-acp-listener-failure-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-listener-failure', cwd: dir,
      }, fixture.options, fixture.dependencies);
      let observedProviderSession = false;
      session.watch((event) => {
        if (event.kind !== 'provider-session-id') return;
        observedProviderSession = true;
        throw new Error('listener failed');
      });

      try {
        await waitForCondition(
          () => observedProviderSession,
          { timeoutMs: 5_000, intervalMs: 10, label: 'public ACP listener failure' },
        );
        await expect(session.send({
          inputIds: ['input-after-listener-failure'],
          input: { text: 'must not reach ACP' },
          delivery: { kind: 'newTurn', turnId: 'turn-after-listener-failure' },
        })).resolves.toMatchObject({
          status: 'unavailable',
          diagnostic: { code: 'agent_runtime_event_listener_failed' },
          retryable: false,
        });
      } finally {
        await session.dispose();
      }
    });
  });

  it('does not join a blocked lifecycle listener during session disposal', async () => {
    await withTempDir('happier-public-acp-dispose-listener-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-dispose-listener', cwd: dir,
      }, fixture.options, fixture.dependencies);
      let listenerStarted = false;
      let releaseListener!: () => void;
      const listenerHeld = new Promise<void>((resolve) => {
        releaseListener = resolve;
      });
      session.watch(async (event) => {
        if (event.kind !== 'provider-session-id') return;
        listenerStarted = true;
        await listenerHeld;
      });
      await waitForCondition(
        () => listenerStarted,
        { timeoutMs: 5_000, intervalMs: 10, label: 'blocked public ACP listener' },
      );

      const disposal = Promise.resolve(session.dispose());
      const outcome = await Promise.race([
        disposal.then(() => 'disposed' as const),
        new Promise<'timedOut'>((resolve) => {
          setTimeout(() => resolve('timedOut'), 3_000);
        }),
      ]);
      releaseListener();
      await disposal;

      expect(outcome).toBe('disposed');
    });
  });

  it('maps follow-up and in-flight steer delivery without creating a second turn owner', async () => {
    await withTempDir('happier-public-acp-delivery-', async (dir) => {
      const completedFixture = createFixture(dir, 'completed');
      const completed = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-follow-up', cwd: dir,
      }, completedFixture.options, completedFixture.dependencies);
      const completedEvents: AgentSessionRuntimeEvent[] = [];
      const completedSubscription = completed.watch((event) => { completedEvents.push(event); });
      try {
        await completed.send({
          inputIds: ['input-first'],
          input: { text: 'first' },
          delivery: { kind: 'newTurn', turnId: 'turn-first' },
        });
        await collectUntil(completedEvents, 'turn-complete');
        await completed.send({
          inputIds: ['input-follow-up'],
          input: { text: 'follow up' },
          delivery: { kind: 'followUp', turnId: 'turn-follow-up', afterTurnId: 'turn-first' },
        });
        await waitForCondition(
          () => completedEvents.filter((event) => event.kind === 'turn-complete').length === 2,
          { timeoutMs: 5_000, intervalMs: 10, label: 'second public ACP completed turn' },
        );
        expect(completedEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'input-accepted',
            inputIds: ['input-follow-up'],
            delivery: { kind: 'followUp', turnId: 'turn-follow-up' },
          }),
          expect.objectContaining({
            kind: 'turn-start',
            turnId: 'turn-follow-up',
            causedByTurnId: 'turn-first',
          }),
        ]));
      } finally {
        completedSubscription.dispose();
        await completed.dispose();
      }

      const hangingFixture = createFixture(dir, 'permission-after-steer');
      const hanging = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-steer', cwd: dir,
      }, hangingFixture.options, hangingFixture.dependencies);
      const hangingEvents: AgentSessionRuntimeEvent[] = [];
      const hangingSubscription = hanging.watch((event) => { hangingEvents.push(event); });
      try {
        await hanging.send({
          inputIds: ['input-primary'],
          input: { text: 'primary' },
          delivery: { kind: 'newTurn', turnId: 'turn-primary' },
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'safe-yolo',
          },
        });
        await hanging.send({
          inputIds: ['input-steer'],
          input: { text: 'steer' },
          delivery: { kind: 'steer', turnId: 'turn-primary' },
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
          },
        });
        await waitForCondition(
          () => hangingEvents.some((event) => (
            event.kind === 'input-accepted' && event.inputIds[0] === 'input-steer'
          )),
          { timeoutMs: 5_000, intervalMs: 10, label: 'public ACP steer acceptance' },
        );
        expect(hangingEvents).toContainEqual(expect.objectContaining({
          kind: 'input-accepted',
          inputIds: ['input-steer'],
          delivery: { kind: 'steer', turnId: 'turn-primary' },
        }));
        expect(hangingFixture.requestInteraction).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'approval',
          allowSessionPersistence: true,
        }), expect.objectContaining({
          signal: expect.any(AbortSignal),
          permissionContext: {
            turnId: 'turn-primary',
            causalPermissionAuthority: {
              kind: 'admittedSessionInputV1',
              admittedPermissionCeiling: 'read-only',
            },
          },
        }));
        await waitForCondition(
          () => hangingEvents.some((event) => event.kind === 'turn-start'),
          { timeoutMs: 5_000, intervalMs: 10, label: 'public ACP primary turn start after steer evidence' },
        );
        expect(hangingEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
        await collectUntil(hangingEvents, 'turn-complete');
      } finally {
        hangingSubscription.dispose();
        await hanging.dispose();
      }
    });
  });

  it('preserves structured content when steering an active ACP turn', async () => {
    await withTempDir('happier-public-acp-structured-steer-', async (dir) => {
      const uploadDir = path.join(dir, '.happier', 'uploads', 'messages', 'steer');
      const uploadPath = path.join(uploadDir, 'image.png');
      const structuredUploadPath = '.happier/uploads/messages/steer/image.png';
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await mkdir(uploadDir, { recursive: true });
      await writeFile(uploadPath, bytes);
      const fixture = createFixture(dir, 'structured-steer');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-structured-steer', cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-primary'],
          input: { text: 'primary' },
          delivery: { kind: 'newTurn', turnId: 'turn-primary' },
        });
        await session.send({
          inputIds: ['input-structured-steer'],
          input: {
            text: 'look again',
            structuredInput: {
              v: 1,
              imageInputs: [{
                id: 'steer-image',
                kind: 'localImage',
                path: structuredUploadPath,
                mimeType: 'image/png',
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                provenance: { kind: 'sessionAttachmentUpload' },
              }],
            },
          },
          delivery: { kind: 'steer', turnId: 'turn-primary' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-primary',
          text: JSON.stringify([
            { type: 'text', text: 'look again' },
            { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
          ]),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each(['absorbed', 'dropped', 'unavailable'] as const)('honors declared steering capability and %s custody without echoing another user entry', async (outcome) => {
    await withTempDir('happier-public-acp-declared-steer-', async (dir) => {
      const fixture = createFixture(dir, `declared-steer-${outcome}`);
      const steer = {
        method: 'session/prompt',
        buildParams: ({ providerSessionId, content }: { providerSessionId: string; content: readonly JsonValue[] }) => ({
          sessionId: providerSessionId, prompt: [...content], _meta: { acme: { steer: true } },
        }),
        isSupported: (capabilities: JsonValue) => {
          const caps = capabilities as { _meta?: { acme?: { steering?: boolean } } };
          return caps._meta?.acme?.steering === true;
        },
        isAccepted: (response: JsonValue) => (response as { _meta?: { acme?: { steering?: string } } })._meta?.acme?.steering === 'absorbed',
        isRejected: (response: JsonValue) => (response as { _meta?: { acme?: { steering?: string } } })._meta?.acme?.steering === 'dropped',
      };
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-declared-steer', cwd: dir }, {
        ...fixture.options, definition: { mcp: { policy: 'pass_through' }, delivery: { steer } },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['primary'], input: { text: 'primary' }, delivery: { kind: 'newTurn', turnId: 'turn-primary' } });
        await waitForCondition(() => events.some(event => event.kind === 'message-delta' && event.text === 'primary active'),
          { timeoutMs: 5_000, intervalMs: 10, label: 'declared steer primary turn active' });
        const result = await session.send({ inputIds: ['steer'], input: { text: 'Instead reply steered.' }, delivery: { kind: 'steer', turnId: 'turn-primary' } });
        if (outcome === 'unavailable') {
          expect(result).toMatchObject({ status: 'unsupported', retryable: false });
          expect(events.some(event => event.kind === 'input-accepted' && event.inputIds.includes('steer'))).toBe(false);
        } else {
          expect(result.status).toBe('admitted');
          await collectUntil(events, 'turn-complete');
          if (outcome === 'absorbed') {
            await waitForCondition(() => events.some(event => event.kind === 'input-accepted' && event.inputIds.includes('steer')),
              { timeoutMs: 5_000, intervalMs: 10, label: 'declared steer input accepted' });
            expect(events.filter(event => event.kind === 'input-accepted' && event.inputIds.includes('steer'))).toHaveLength(1);
            expect(events.filter(event => event.kind === 'message-delta' && event.text === 'steered')).toHaveLength(1);
          } else {
            await session.drainPendingPublications();
            expect(events).toContainEqual(expect.objectContaining({ kind: 'input-rejected', inputIds: ['steer'], retryable: true }));
            expect(events.some(event => event.kind === 'input-custody-unknown')).toBe(false);
          }
          expect(events.filter(event => event.kind === 'turn-start')).toHaveLength(1);
          expect(events.filter(event => event.kind === 'message-delta' && event.text === 'Instead reply steered.')).toHaveLength(0);
        }
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('preserves active input permission authority when steer projection refuses before write', async () => {
    await withTempDir('happier-public-acp-unrepresentable-steer-', async dir => {
      const fixture = createFixture(dir, 'permission-after-steer');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-steer', cwd: dir }, {
        ...fixture.options, definition: { mcp: { policy: 'drop' }, delivery: { steer: {
          method: 'acme/unsupported-steer', buildParams: () => null, isAccepted: () => false,
        } } },
      }, fixture.dependencies);
      try {
        await session.send({ inputIds: ['primary'], input: { text: 'primary' }, delivery: { kind: 'newTurn', turnId: 'turn-primary' },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } });
        await expect(session.send({ inputIds: ['unrepresentable'], input: { text: 'steer' }, delivery: { kind: 'steer', turnId: 'turn-primary' },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' } })).resolves.toMatchObject({ status: 'unsupported' });
        await session.requestExtension('acme/probe_permission', { sessionId: session.getProviderSessionId() });
        expect(fixture.requestInteraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ permissionContext: {
          turnId: 'turn-primary', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
        } }));
      } finally { await session.dispose(); }
    });
  });

  it('uses a provider steer extension instead of a concurrent session prompt when configured', async () => {
    await withTempDir('happier-public-acp-provider-steer-', async (dir) => {
      const fixture = createFixture(dir, 'grok-interject');
      const definition = buildGrokAcpRuntimeDefinition({});
      const structuredUploadPath = '.happier/uploads/messages/steer/image.png';
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await mkdir(path.dirname(path.join(dir, structuredUploadPath)), { recursive: true });
      await writeFile(path.join(dir, structuredUploadPath), bytes);
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-grok-steer', cwd: dir,
      }, {
        ...fixture.options,
        definition,
      } as unknown as AgentAcpRuntimeOptions, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-primary'],
          input: { text: 'primary' },
          delivery: { kind: 'newTurn', turnId: 'turn-primary' },
        });
        await waitForCondition(
          () => events.some((event) => event.kind === 'message-delta' && event.text === 'primary active'),
          { timeoutMs: 5_000, intervalMs: 10, label: 'primary Grok turn active' },
        );

        await session.send({
          inputIds: ['input-steer'],
          input: { text: 'change direction', structuredInput: {
            v: 1,
            imageInputs: [{
              id: 'steer-image', kind: 'localImage', path: structuredUploadPath,
              mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'),
              sizeBytes: bytes.length, provenance: { kind: 'sessionAttachmentUpload' },
            }],
          } },
          delivery: { kind: 'steer', turnId: 'turn-primary' },
        });
        await collectUntil(events, 'turn-complete');

        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          channel: 'assistant',
          text: 'interjected=change direction;id=input-steer',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify([
            { type: 'text', text: 'change direction' },
            { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
          ]),
        }));
        expect(events).not.toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: 'wrong concurrent session prompt',
        }));
        expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('refuses provider steer dispatch when host currentness retires during prompt projection', async () => {
    await withTempDir('happier-public-acp-retired-extension-steer-', async (dir) => {
      const fixture = createFixture(dir, 'grok-interject');
      let current = true;
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-grok-steer', cwd: dir,
      }, { ...fixture.options, definition: buildGrokAcpRuntimeDefinition({}) }, {
        ...fixture.dependencies, isCurrent: () => current,
      });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({ inputIds: ['primary'], input: { text: 'primary' },
          delivery: { kind: 'newTurn', turnId: 'turn-primary' } });
        await waitForCondition(
          () => events.some((event) => event.kind === 'message-delta' && event.text === 'primary active'),
          { timeoutMs: 5_000, intervalMs: 10, label: 'primary Grok turn active' },
        );
        const steer = session.send({ inputIds: ['retired-steer'], input: { text: 'change direction' },
          delivery: { kind: 'steer', turnId: 'turn-primary' } });
        current = false;
        await expect(steer).resolves.toMatchObject({
          status: 'unavailable', diagnostic: { code: 'acp_runtime_unavailable' },
        });
      } finally {
        current = true;
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('rejects untrusted images before a provider steer extension can accept the input', async () => {
    await withTempDir('happier-public-acp-untrusted-extension-steer-', async (dir) => {
      const fixture = createFixture(dir, 'grok-interject');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-grok-steer', cwd: dir,
      }, { ...fixture.options, definition: buildGrokAcpRuntimeDefinition({}) }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({ inputIds: ['primary'], input: { text: 'primary' },
          delivery: { kind: 'newTurn', turnId: 'turn-primary' } });
        await waitForCondition(
          () => events.some((event) => event.kind === 'message-delta' && event.text === 'primary active'),
          { timeoutMs: 5_000, intervalMs: 10, label: 'primary Grok turn active' },
        );
        await expect(session.send({
          inputIds: ['untrusted'],
          input: { text: 'unsafe image', structuredInput: { v: 1, imageInputs: [{
            id: 'unsafe', kind: 'localImage', path: '/outside/image.png', mimeType: 'image/png',
            provenance: { kind: 'untrusted' },
          }] } },
          delivery: { kind: 'steer', turnId: 'turn-primary' },
        })).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'acp_image_input_untrusted' } });
        expect(events).not.toContainEqual(expect.objectContaining({ kind: 'input-accepted', inputIds: ['untrusted'] }));
        await expect(session.send({ inputIds: ['safe-text'], input: { text: 'change direction' },
          delivery: { kind: 'steer', turnId: 'turn-primary' } })).resolves.toMatchObject({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'interjected=change direction;id=safe-text' }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  describe('ordered history-fork extension methods', () => {
    const methods = ['x.ai/session/fork', '_x.ai/session/fork'] as const;
    const params = Object.freeze({
      sourceSessionId: 'provider-parent',
      newCwd: '/target-workspace',
    });

    it('tries the next method only after an exact ACP method-not-found response', async () => {
      const controller = new AbortController();
      const requestExtension = vi.fn(async (
        method: string,
        _params: JsonValue,
        _options: Readonly<{ signal: AbortSignal }>,
      ) => {
        if (method === methods[0]) throw RequestError.methodNotFound(method);
        return { newSessionId: 'provider-history-forked' };
      });

      await expect(requestAcpHistoryExtension({
        methods,
        params,
        options: { signal: controller.signal },
        requestExtension,
      })).resolves.toEqual({ newSessionId: 'provider-history-forked' });

      expect(requestExtension.mock.calls.map(([method]) => method)).toEqual(methods);
      for (const call of requestExtension.mock.calls) {
        expect(call[1]).toBe(params);
        expect(call[2]).toEqual({ signal: controller.signal });
      }
    });

    it.each([
      {
        label: 'a non-method ACP error',
        error: RequestError.invalidParams({ field: 'sourceSessionId' }),
      },
      {
        label: 'a plain object that mimics the method-not-found code',
        error: { code: -32601, message: '"Method not found": x.ai/session/fork' },
      },
      {
        label: 'an untyped method-not-found Error',
        error: new Error('"Method not found": x.ai/session/fork'),
      },
      {
        label: 'a spoofed RequestError name and method-not-found code',
        error: Object.assign(new Error('"Method not found": x.ai/session/fork'), {
          name: 'RequestError',
          code: -32601,
        }),
      },
    ])('stops after $label', async ({ error }) => {
      const requestExtension = vi.fn(async () => {
        throw error;
      });

      await expect(requestAcpHistoryExtension({
        methods,
        params,
        options: { signal: new AbortController().signal },
        requestExtension,
      })).rejects.toBe(error);
      expect(requestExtension).toHaveBeenCalledOnce();
    });

    it('honors cancellation before dispatching a fallback alias', async () => {
      const controller = new AbortController();
      const cancellation = new Error('history fork cancelled');
      const requestExtension = vi.fn(async (method: string) => {
        controller.abort(cancellation);
        throw RequestError.methodNotFound(method);
      });

      await expect(requestAcpHistoryExtension({
        methods,
        params,
        options: { signal: controller.signal },
        requestExtension,
      })).rejects.toBe(cancellation);
      expect(requestExtension).toHaveBeenCalledOnce();
    });

    it('returns the last exact method-not-found error after exhausting aliases', async () => {
      const errors = methods.map((method) => RequestError.methodNotFound(method));
      const requestExtension = vi.fn(async (_method: string) => {
        throw errors[requestExtension.mock.calls.length - 1]!;
      });

      await expect(requestAcpHistoryExtension({
        methods,
        params,
        options: { signal: new AbortController().signal },
        requestExtension,
      })).rejects.toBe(errors[1]);
      expect(requestExtension.mock.calls.map(([method]) => method)).toEqual(methods);
    });

    it('uses the complete declared history-method list until a method succeeds', async () => {
      const declaredMethods = Array.from({ length: 9 }, (_, index) => `x.test/fork-${index}`);
      const requestExtension = vi.fn(async (method: string) => {
        if (method !== declaredMethods.at(-1)) throw RequestError.methodNotFound(method);
        return { newSessionId: 'provider-history-forked' };
      });
      await expect(requestAcpHistoryExtension({ methods: declaredMethods, params, requestExtension }))
        .resolves.toEqual({ newSessionId: 'provider-history-forked' });
      expect(requestExtension.mock.calls.map(([method]) => method)).toEqual(declaredMethods);
    });

    it.each([
      { label: 'empty', methods: [] },
      {
        label: 'malformed',
        methods: ['x.ai/session/fork', 'not-namespaced'],
      },
    ])('rejects an $label method list before dispatch', async ({ methods: invalidMethods }) => {
      const requestExtension = vi.fn(async () => ({}));

      await expect(requestAcpHistoryExtension({
        methods: invalidMethods,
        params,
        options: { signal: new AbortController().signal },
        requestExtension,
      })).rejects.toThrow(/history extension methods/i);
      expect(requestExtension).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: 'resume',
      request: (dir: string): AgentSessionOpenRequest => ({
        kind: 'resume',
        sessionId: 'host-session',
        cwd: dir,
        providerSessionId: 'provider-resumed',
      }),
      providerSessionId: 'provider-resumed',
    },
    {
      name: 'fork',
      request: (dir: string): AgentSessionOpenRequest => ({
        kind: 'fork',
        sessionId: 'host-session',
        cwd: dir,
        source: { sessionId: 'host-parent', providerSessionId: 'provider-parent', cwd: dir },
      }),
      providerSessionId: 'provider-forked',
    },
  ])('maps $name to the mature ACP session operation', async ({ request, providerSessionId }) => {
    await withTempDir('happier-public-acp-open-', async (dir) => {
      const fixture = createFixture(dir, 'session-open-capabilities');
      const session = await createPublicAcpSession(request(dir), fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await collectUntil(events, 'provider-session-id');
        expect(events).toEqual([
          expect.objectContaining({ kind: 'provider-session-id', providerSessionId }),
        ]);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('reports Codex ACP skill delivery truthfully through the native selector and real composer', async () => {
    await withTempDir('happier-public-acp-codex-skills-', async dir => {
      const home = path.join(dir, 'home');
      for (const root of ['.claude', '.agents', '.codex', '.config/opencode', '.copilot', '.gemini', '.pi', '.qwen']) {
        await mkdir(path.join(home, root), { recursive: true });
        await writeFile(path.join(home, root, 'retained-native-config'), 'preserve native bytes');
      }
      await mkdir(path.join(dir, 'generated'), { recursive: true });
      const observer = createAgentLaunchObserver({ home });
      const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
      const skills = { pluginRoot: path.join(dir, 'private-plugin'), skillsRoot: path.join(dir, 'private-plugin', 'skills'),
        items: [{ name: 'contract-skill', skillId: 'contract:skill', digest: 'sha256:contract', directory: path.join(dir, 'private-plugin', 'skills', 'contract-skill') }],
        nativeDisables: [{ name: 'contract-native-blocked', path: path.join(home, '.codex', 'skills', 'blocked', 'SKILL.md') }] };
      let baseline: ReturnType<typeof observer.observeLaunch> | undefined;
      for (const withSkills of [false, true, false]) {
        boundaries.reset();
        const fixture = createFixture(dir, 'codex-skill-acp');
        // Only managed executable resolution is replaced; the selector, launch
        // composition, ACP client and subprocess protocol all execute unchanged.
        const dependencies: PublicAcpComposerDependencies = {
          ...fixture.dependencies, pluginId: 'codex', agentId: 'codex',
          managedDependencies: { async resolve(request) {
            expect(request.dependencyId).toBe('codex-acp');
            const resolved = await fixture.resolve();
            return { command: resolved.launch.executablePath, args: resolved.launch.args,
              env: resolved.launch.env, release() {} };
          } },
        };
        const context = {
          signal: dependencies.signal,
          protocols: { acp: { open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) =>
            createPublicAcpSession(request, options, dependencies) } },
        } as unknown as AgentSessionRuntimeContext;
        const factory = await createCodexAgentRuntime({ plugin: { id: 'codex', version: '0.0.0' },
          agent: { id: 'codex' }, signal: dependencies.signal });
        if (!factory.sessions) throw new Error('Codex Session factory missing');
        const session = await factory.sessions.open({ kind: 'create', sessionId: 'codex-acp-skills', cwd: dir,
          launchEnvironment: { values: { HOME: home, HAPPIER_CODEX_BACKEND_MODE: 'acp' }, unset: [] },
          ...(withSkills ? { skills } : {}) }, context);
        try {
          const captured = JSON.parse(readFileSync(path.join(dir, 'generated', 'generated.png'), 'utf8')) as {
            argv: string[]; env: Record<string, string>; acpSessionNew: unknown;
          };
          boundaries.recordLaunch(captured);
          boundaries.recordAcpSessionNew(captured.acpSessionNew);
          const observed = observer.observeLaunch();
          expect(observed.filesWritten, 'K5: unsupported ACP cannot mutate native HOME').toEqual([]);
          if (withSkills) {
            expect(session.skillsDelivered, 'K10: selectable ACP must expose unsupported delivery').toBe(false);
            expect(await session.refreshSkills?.({ skills })).toEqual({ kind: 'restart_required', reason: 'launch_path_unsupported' });
            expect(JSON.stringify(observed)).not.toContain(skills.pluginRoot);
            expect(JSON.stringify(observed)).not.toContain('contract-native-blocked');
          } else {
            expect(session.skillsDelivered).toBeUndefined();
            expect(session.refreshSkills).toBeUndefined();
          }
          if (baseline) expect(observed).toEqual(baseline);
          else baseline = observed;
        } finally { await session.dispose(); }
      }
    });
  });

  it('projects non-contiguous provider prompt indexes into ordered rollback boundaries and rewinds on the same ACP connection', async () => {
    await withTempDir('happier-public-acp-history-', async (dir) => {
      const fixture = createFixture(dir, 'history-prompts');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-history',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: createHistoryDefinition(),
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        for (const [turnId, inputId] of [['host-turn-7', 'input-7'], ['host-turn-42', 'input-42']] as const) {
          await session.send({
            inputIds: [inputId],
            input: { text: turnId },
            delivery: { kind: 'newTurn', turnId },
          });
          await waitForCondition(
            () => events.some((event) => event.kind === 'turn-complete' && event.turnId === turnId),
            { timeoutMs: 5_000, intervalMs: 10, label: `history turn ${turnId}` },
          );
        }

        expect(events.filter((event) => event.kind === 'turn-rollback-boundary')).toEqual([
          expect.objectContaining({
            turnId: 'host-turn-7',
            providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 7 },
          }),
          expect.objectContaining({
            turnId: 'host-turn-42',
            providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
          }),
        ]);
        for (const turnId of ['host-turn-7', 'host-turn-42']) {
          const boundaryIndex = events.findIndex((event) => (
            event.kind === 'turn-rollback-boundary' && event.turnId === turnId
          ));
          const completeIndex = events.findIndex((event) => (
            event.kind === 'turn-complete' && event.turnId === turnId
          ));
          expect(boundaryIndex).toBeGreaterThanOrEqual(0);
          expect(completeIndex).toBeGreaterThan(boundaryIndex);
        }

        await expect(session.conversationRollback?.rollback({
          operationId: 'rollback-host-turn-42',
          providerSessionId: 'provider-created',
          target: { kind: 'beforeTurn', turnId: 'host-turn-42' },
          affectedTurns: [{
            turnId: 'host-turn-42',
            providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
          }],
          runtimeIncarnationId: 'runtime-host-history',
        })).resolves.toEqual({ status: 'applied' });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('fails closed when one provider turn reports conflicting checkpoint coordinates', async () => {
    await withTempDir('happier-public-acp-history-ambiguous-', async (dir) => {
      const fixture = createFixture(dir, 'history-ambiguous');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-history-ambiguous',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: createHistoryDefinition(),
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-ambiguous'],
          input: { text: 'ambiguous' },
          delivery: { kind: 'newTurn', turnId: 'host-turn-ambiguous' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events.some((event) => event.kind === 'turn-rollback-boundary')).toBe(false);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('fails closed when a provider projects a checkpoint larger than the canonical bound', async () => {
    await withTempDir('happier-public-acp-history-oversized-', async (dir) => {
      const fixture = createFixture(dir, 'history-prompts');
      const historyDefinition = createHistoryDefinition();
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-history-oversized',
        cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          ...historyDefinition,
          history: {
            ...historyDefinition.history!,
            projectUserMessageProviderCheckpoint: () => ({
              payload: 'x'.repeat(AgentSessionProviderCheckpointMaxJsonBytesV1),
            }),
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-oversized'],
          input: { text: 'oversized' },
          delivery: { kind: 'newTurn', turnId: 'host-turn-oversized' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events.some((event) => event.kind === 'turn-rollback-boundary')).toBe(false);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each([
    { scenario: 'history-fork', target: undefined },
    { scenario: 'history-fork-legacy', target: undefined },
    {
      scenario: 'history-fork-exact',
      target: {
        turnId: 'host-turn-42',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
      },
    },
  ] as const)('opens $scenario through the extension fork and loads it on that same ACP connection', async ({
    scenario,
    target,
  }) => {
    await withTempDir('happier-public-acp-history-fork-', async (dir) => {
      const fixture = createFixture(dir, scenario);
      const session = await createPublicAcpSession({
        kind: 'fork',
        sessionId: 'host-history-child',
        cwd: dir,
        source: {
          sessionId: 'host-parent',
          providerSessionId: 'provider-parent',
          cwd: '/source-workspace',
          ...(target ? { target } : {}),
        },
      }, {
        ...fixture.options,
        definition: createHistoryDefinition(),
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await collectUntil(events, 'provider-session-id');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'provider-session-id',
          providerSessionId: 'provider-history-forked',
        }));
        await session.send({
          inputIds: ['history-fork-successor-input'],
          input: { text: 'continue from the fork' },
          delivery: {
            kind: 'newTurn',
            turnId: 'history-fork-successor-turn',
          },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          channel: 'assistant',
          text: 'history fork successor complete',
        }));
        expect(events).not.toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: 'history fork replay must stay provider-local',
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each([['Task', 'Task', 'child replay output'], ['SubAgent', 'SubAgent', 'child replay output'], ['empty', 'SubAgent', 'child fallback output'], ['permission', 'SubAgent', 'child replay output']])('imports %s child replay with sidechain provenance without affecting its parent', async (scenario, toolName, childOutput) => {
    await withTempDir('happier-public-acp-sidechain-', async (dir) => {
      const fixture = createFixture(dir, `sidechain-${scenario}`);
      const imported: Array<{ body: unknown; provenance: unknown }> = [];
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-parent', cwd: dir }, {
        ...fixture.options,
        transport: { ...fixture.options.transport, env: { ...fixture.options.transport.env, REPLAY_PERMISSION_EVIDENCE: dir } },
        definition: { mcp: { policy: 'drop' }, toolNameResolver: () => toolName },
      }, {
        ...fixture.dependencies,
        sidechainSession: {
          enqueueAgentMessageCommitted: async (_provider, body, options) => {
            if (scenario === 'permission') {
              await writeFile(path.join(dir, 'import-admitted'), 'admitted');
              await waitForCondition(() => existsSync(path.join(dir, 'permission-reply.json')), { timeoutMs: 5_000, intervalMs: 10, label: 'replay permission withdrawal' });
            }
            imported.push({ body, provenance: options?.provenance });
            return { persisted: true, delivered: false };
          },
        },
      });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
      try {
        const sent = await session.send({ inputIds: ['parent-input'], delivery: { kind: 'newTurn', turnId: 'parent-turn' }, input: { text: 'work' } });
        expect(sent.status).toBe('admitted');
        await collectUntil(events, 'turn-complete');
        await waitForCondition(() => imported.length > 0, { timeoutMs: 5_000, intervalMs: 10, label: 'ACP child replay import' });
        const firstSidechainId = createAcpToolIdentity({ sessionId: 'host-parent', turnId: 'parent-turn', sidechainId: null, toolCallId: 'child-launch' }).callLocalId;
        expect(imported).toEqual([{ body: { type: 'message', message: childOutput, sidechainId: firstSidechainId }, provenance: { kind: 'non_dependent', source: 'sidechain' } }]);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', toolCallId: 'child-launch', input: expect.objectContaining({ sidechainId: firstSidechainId }) }));
        expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId: 'parent-turn', text: 'parent output' }));
        expect(events).not.toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'child replay output' }));
        expect(events).not.toContainEqual(expect.objectContaining({ kind: 'transcript-message-committed', text: childOutput }));
        expect(session.getProviderSessionId()).toBe('provider-created');
        if (scenario === 'permission') {
          await session.drainPendingPublications();
          expect.soft(existsSync(path.join(dir, 'child-cancel.json'))).toBe(false);
          expect.soft(existsSync(path.join(dir, 'child-close.json'))).toBe(false);
          expect.soft(JSON.parse(readFileSync(path.join(dir, 'permission-reply.json'), 'utf8'))).toEqual({ outcome: { outcome: 'cancelled' } });
          return;
        }
        await session.send({ inputIds: ['second-input'], delivery: { kind: 'newTurn', turnId: 'second-turn' }, input: { text: 'again' } });
        await waitForCondition(() => imported.length === 2, { timeoutMs: 5_000, intervalMs: 10, label: 'reused ACP child launch id' });
        const secondSidechainId = createAcpToolIdentity({ sessionId: 'host-parent', turnId: 'second-turn', sidechainId: null, toolCallId: 'child-launch' }).callLocalId;
        expect(secondSidechainId).not.toBe(firstSidechainId);
        expect(imported[1]?.body).toMatchObject({ sidechainId: secondSidechainId });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('imports captured provider replay through the host transcript owner on fresh-session resume', async () => {
    await withTempDir('happier-public-acp-resume-replay-', async (dir) => {
      const fixture = createFixture(dir, 'resume-replay');
      const imported: Array<Readonly<{
        role: 'user' | 'agent';
        text: string;
        meta?: Readonly<Record<string, unknown>>;
      }>> = [];
      const session = await createPublicAcpSession({
        kind: 'resume',
        sessionId: 'host-resume-replay',
        cwd: dir,
        providerSessionId: 'provider-resume-replay',
      }, fixture.options, {
        ...fixture.dependencies,
        resumeHistorySession: {
          fetchRecentTranscriptTextItemsForAcpImport: async () => [],
          enqueueUserTextMessageCommitted: async (text, options) => {
            imported.push({ role: 'user', text, meta: options.meta });
            return { persisted: true, delivered: false };
          },
          enqueueAgentMessageCommitted: async (_provider, message, options) => {
            if (message.type !== 'message') throw new Error('expected replayed agent message');
            imported.push({ role: 'agent', text: message.message, meta: options?.meta });
            return { persisted: true, delivered: false };
          },
          updateMetadata: async () => undefined,
        },
      });
      try {
        expect(imported).toEqual([
          {
            role: 'user',
            text: 'replayed user message',
            meta: {
              importedFrom: 'acp-history',
              remoteSessionId: 'provider-resume-replay',
            },
          },
          {
            role: 'agent',
            text: 'replayed assistant message',
            meta: {
              importedFrom: 'acp-history',
              remoteSessionId: 'provider-resume-replay',
            },
          },
        ]);
      } finally {
        await session.dispose();
      }
    });
  });

  it.each([false, true])('settles an unknown prompt stop reason through the declared projector when available (%s)', async (withProjector) => {
    await withTempDir('happier-public-acp-unknown-stop-', async (dir) => {
      const fixture = createFixture(dir, 'unknown-stop-reason');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'unknown-stop', cwd: dir },
        {
          ...fixture.options,
          definition: {
            mcp: { policy: 'drop' },
            usage: {
              projectPromptUsage({ usage }) {
                if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
                return { ...usage, totalTokens: 24 };
              },
            },
            ...(withProjector ? { sessionUpdates: {
              project: () => null,
              projectStopReason: (stopReason: string) => stopReason === 'future_stop' ? 'max_tokens' as const : null,
            } } : {}),
          },
        }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['unknown-input'], input: { text: 'continue' },
          delivery: { kind: 'newTurn', turnId: 'unknown-turn' } });
        await waitForCondition(() => events.some(event => event.kind === 'turn-complete'
          || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'),
          { timeoutMs: 5000, intervalMs: 10, label: 'unknown stop terminal' });
        expect(events.filter(event => event.kind === 'turn-complete'
          || event.kind === 'turn-failed' || event.kind === 'turn-cancelled')).toEqual([
          expect.objectContaining(withProjector
            ? { kind: 'turn-complete', turnId: 'unknown-turn' }
            : { kind: 'turn-cancelled', turnId: 'unknown-turn', cause: 'unknown', diagnostic: {
              code: 'acp_unknown_stop_reason', severity: 'warning', details: { stopReason: 'future_stop' },
            } }),
        ]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'usage-observed', source: 'acp-prompt-usage',
          tokens: { total: 24, input: 17, output: 7, cacheRead: 5, cacheWrite: 2, reasoning: 3 },
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('maps official refusal to turn-failed and cancellation to one turn-cancelled terminal', async () => {
    await withTempDir('happier-public-acp-terminals-', async (dir) => {
      const refusedFixture = createFixture(dir, 'refused');
      const refused = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-refused', cwd: dir,
      }, refusedFixture.options, refusedFixture.dependencies);
      const refusedEvents: AgentSessionRuntimeEvent[] = [];
      const refusedSubscription = refused.watch((event) => { refusedEvents.push(event); });
      try {
        await refused.send({
          inputIds: ['input-refused'],
          input: { text: 'refuse' },
          delivery: { kind: 'newTurn', turnId: 'turn-refused' },
        });
        await collectUntil(refusedEvents, 'turn-failed');
        expect(refusedEvents.filter((event) => event.kind === 'turn-failed')).toEqual([
          expect.objectContaining({
            turnId: 'turn-refused',
            diagnostic: expect.objectContaining({ code: 'acp_turn_refused' }),
          }),
        ]);
      } finally {
        refusedSubscription.dispose();
        await refused.dispose();
      }

      const cancelFixture = createFixture(dir, 'hanging');
      const cancelled = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-cancelled', cwd: dir,
      }, cancelFixture.options, cancelFixture.dependencies);
      const cancelledEvents: AgentSessionRuntimeEvent[] = [];
      const cancelledSubscription = cancelled.watch((event) => { cancelledEvents.push(event); });
      try {
        await cancelled.send({
          inputIds: ['input-cancelled'],
          input: { text: 'wait' },
          delivery: { kind: 'newTurn', turnId: 'turn-cancelled' },
        });
        await expect(cancelled.cancel?.({ turnId: 'turn-cancelled', reason: 'user' }))
          .resolves.toEqual({ status: 'requested', turnId: 'turn-cancelled' });
        await collectUntil(cancelledEvents, 'turn-cancelled');
        expect(cancelledEvents.filter((event) => (
          event.kind === 'turn-complete'
          || event.kind === 'turn-failed'
          || event.kind === 'turn-cancelled'
        ))).toEqual([
          expect.objectContaining({ kind: 'turn-cancelled', turnId: 'turn-cancelled', cause: 'user' }),
        ]);
      } finally {
        cancelledSubscription.dispose();
        await cancelled.dispose();
      }
    });
  });

  it('fences a cancelled prompt response and completion evidence while a successor turn completes', async () => {
    await withTempDir('happier-public-acp-cancel-successor-', async (dir) => {
      const fixture = createFixture(dir, 'cancel-successor');
      const events: AgentSessionRuntimeEvent[] = [];
      let submitCancelledTurnEvidence: (() => boolean) | null = null;
      let staleEvidenceAccepted: boolean | null = null;
      let oldResponseObservedForTurn: string | null = null;
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-cancel-successor', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              if (!context.currentTurn) throw new Error('Expected the first turn to be active');
              const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
              submitCancelledTurnEvidence = () => context.currentTurn!.submitCompletionEvidence({
                ...evidence,
                outcome: { kind: 'completed' },
              });
              return { observed: true };
            },
            'acme/old_response_released': (_params, context) => {
              oldResponseObservedForTurn = context.currentTurn?.turnId ?? null;
              staleEvidenceAccepted = submitCancelledTurnEvidence?.() ?? null;
              return { observed: true };
            },
          },
        },
      }, fixture.dependencies);
      const subscription = session.watch((event) => { events.push(event); });
      try {
        const sending = session.send({
          inputIds: ['input-cancel-successor-first'],
          input: { text: 'cancel this turn' },
          delivery: { kind: 'newTurn', turnId: 'turn-cancel-successor-first' },
        });
        await waitForCondition(
          () => submitCancelledTurnEvidence !== null,
          { timeoutMs: 5_000, intervalMs: 10, label: 'cancelled turn completion evidence hook' },
        );

        await expect(session.cancel?.({
          turnId: 'turn-cancel-successor-first',
          reason: 'user',
        })).resolves.toEqual({
          status: 'requested',
          turnId: 'turn-cancel-successor-first',
        });
        await expect(sending).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-cancelled');

        await expect(session.send({
          inputIds: ['input-cancel-successor-second'],
          input: { text: 'complete the successor' },
          delivery: { kind: 'newTurn', turnId: 'turn-cancel-successor-second' },
        })).resolves.toEqual({ status: 'admitted' });
        await waitForCondition(
          () => oldResponseObservedForTurn !== null,
          { timeoutMs: 5_000, intervalMs: 10, label: 'stale prompt response release' },
        );

        expect(oldResponseObservedForTurn).toBe('turn-cancel-successor-second');
        expect(staleEvidenceAccepted).toBe(false);
        expect(events.some((event) => (
          event.kind === 'turn-complete'
          && event.turnId === 'turn-cancel-successor-second'
        ))).toBe(false);

        await collectUntil(events, 'turn-complete');
        expect(events.filter((event) => (
          event.kind === 'turn-complete'
          || event.kind === 'turn-failed'
          || event.kind === 'turn-cancelled'
        ))).toEqual([
          expect.objectContaining({
            kind: 'turn-cancelled',
            turnId: 'turn-cancel-successor-first',
            cause: 'user',
          }),
          expect.objectContaining({
            kind: 'turn-complete',
            turnId: 'turn-cancel-successor-second',
          }),
        ]);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('preserves exact custody/start/terminal ordering when cancelled before prompt acknowledgement', async () => {
    await withTempDir('happier-public-acp-pre-ack-cancel-', async (dir) => {
      const fixture = createFixture(dir, 'cancel-before-ack');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-pre-ack-cancel', cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        const sending = session.send({
          inputIds: ['input-pre-ack-cancel'],
          input: { text: 'wait' },
          delivery: { kind: 'newTurn', turnId: 'turn-pre-ack-cancel' },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(events.map(event => event.kind)).toEqual(['provider-session-id']);
        await expect(session.cancel?.({ turnId: 'turn-pre-ack-cancel', reason: 'user' }))
          .resolves.toEqual({ status: 'requested', turnId: 'turn-pre-ack-cancel' });
        await expect(sending).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-cancelled');
        expect(events.map(event => event.kind)).toEqual([
          'provider-session-id',
          'input-accepted',
          'turn-start',
          'turn-cancelled',
        ]);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each(['exit', 'exit-zero'])(
    'orders an unexpected %s process exit after the active failed turn and fences later sends',
    async (scenario) => {
    await withTempDir('happier-public-acp-exit-', async (dir) => {
      const fixture = createFixture(dir, scenario);
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-exit', cwd: dir,
      }, fixture.options, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-exit'],
          input: { text: 'exit' },
          delivery: { kind: 'newTurn', turnId: 'turn-exit' },
        });
        await collectUntil(events, 'runtime-ended');
        const terminalKinds = events.filter((event) => (
          event.kind === 'turn-failed' || event.kind === 'runtime-ended'
        )).map((event) => event.kind);
        expect(terminalKinds).toEqual(['turn-failed', 'runtime-ended']);
        await expect(session.send({
          inputIds: ['input-after-exit'],
          input: { text: 'later' },
          delivery: { kind: 'newTurn', turnId: 'turn-after-exit' },
        })).resolves.toMatchObject({ status: 'unavailable' });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
    },
  );

  it('fails closed for cross-plugin tools and stale generations before spawning', async () => {
    await withTempDir('happier-public-acp-fencing-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      await expect(createPublicAcpSession({
        kind: 'create', sessionId: 'host-cross-plugin', cwd: dir,
      }, {
        transport: {
          kind: 'stdio',
          executable: {
            kind: 'systemTool',
            id: { pluginId: 'other.plugin', localId: 'fixture-acp' },
          },
        },
      }, fixture.dependencies)).rejects.toThrow(/another plugin's system tool/i);
      expect(fixture.resolve).not.toHaveBeenCalled();

      await expect(createPublicAcpSession({
        kind: 'create', sessionId: 'host-stale', cwd: dir,
      }, fixture.options, { ...fixture.dependencies, isCurrent: () => false }))
        .rejects.toThrow(/no longer current/i);
      expect(fixture.resolve).not.toHaveBeenCalled();
    });
  });

  it('registers only bounded strict-JSON extension methods with the correlated method context', async () => {
    await withTempDir('happier-public-acp-extension-', async (dir) => {
      const fixture = createFixture(dir, 'extension');
      const contexts: Array<{ method: string; requestId?: string; signal: AbortSignal }> = [];
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-extension', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              contexts.push(context);
              return { echoed: params };
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-extension'],
          input: { text: 'extension' },
          delivery: { kind: 'newTurn', turnId: 'turn-extension' },
        });
        await collectUntil(events, 'turn-complete');
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toMatchObject({ method: 'acme/echo', requestId: 'extension-1' });
        expect(contexts[0]?.signal.aborted).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({ echoed: { value: 'hello extension' } }),
        }));
      } finally {
        subscription.dispose();
        await session.dispose();
      }

      const observedAliasSession = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-extension-observed-alias', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            '_x.ai/echo': () => ({ ok: true }),
          },
        },
      }, fixture.dependencies);
      await observedAliasSession.dispose();

      await expect(createPublicAcpSession({
        kind: 'create', sessionId: 'host-invalid-extension', cwd: dir,
      }, {
        ...fixture.options,
        extensions: { requests: { unnamespaced: () => ({ ok: true }) } },
      }, fixture.dependencies)).rejects.toThrow(/invalid namespaced ACP extension method/i);
    });
  });

  it('commits exact-session extension observations emitted during resume only after the open succeeds', async () => {
    await withTempDir('happier-public-acp-resume-extension-', async (dir) => {
      const createNotificationOptions = (
        fixture: ReturnType<typeof createFixture>,
        observedGoalIds: string[],
      ): AgentAcpRuntimeOptions => ({
        ...fixture.options,
        extensions: {
          notifications: {
            'x.ai/session/update': (params, context) => {
              if (!params || typeof params !== 'object' || Array.isArray(params)) return;
              const notification = params as Readonly<Record<string, unknown>>;
              const update = notification.update;
              if (
                notification.sessionId !== context.providerSessionId
                || !update
                || typeof update !== 'object'
                || Array.isArray(update)
              ) return;
              const goalId = (update as Readonly<Record<string, unknown>>).goal_id;
              if (typeof goalId === 'string') observedGoalIds.push(goalId);
            },
          },
        },
      });

      const successfulFixture = createFixture(dir, 'resume-extension-notification');
      const successfulObservations: string[] = [];
      const session = await createPublicAcpSession({
        kind: 'resume',
        sessionId: 'host-resume-extension',
        providerSessionId: 'provider-resumed',
        cwd: dir,
      }, createNotificationOptions(successfulFixture, successfulObservations), successfulFixture.dependencies);
      expect(successfulObservations).toEqual(['goal-1']);
      await session.dispose();

      const failedFixture = createFixture(dir, 'resume-extension-notification-failed');
      const failedObservations: string[] = [];
      await expect(createPublicAcpSession({
        kind: 'resume',
        sessionId: 'host-resume-extension-failed',
        providerSessionId: 'provider-resumed',
        cwd: dir,
      }, createNotificationOptions(failedFixture, failedObservations), failedFixture.dependencies))
        .rejects.toThrow('resume rejected');
      expect(failedObservations).toEqual([]);

      const abortedFixture = createFixture(dir, 'resume-extension-notification-delayed');
      const abortedObservations: string[] = [];
      const controller = new AbortController();
      const opening = createPublicAcpSession({
        kind: 'resume',
        sessionId: 'host-resume-extension-aborted',
        providerSessionId: 'provider-resumed',
        cwd: dir,
      }, createNotificationOptions(abortedFixture, abortedObservations), {
        ...abortedFixture.dependencies,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(opening).rejects.toThrow();
      expect(abortedObservations).toEqual([]);
    });
  });

  it('injects the canonical prompt id and accepts completion evidence only for the current provider session and turn', async () => {
    await withTempDir('happier-public-acp-completion-evidence-', async (dir) => {
      const fixture = createFixture(dir, 'extension-completion');
      const evidenceResults: boolean[] = [];
      let observedContext: Readonly<{ providerSessionId: string; turnId: string }> | null = null;
      let submitAfterSettlement: (() => boolean) | null = null;
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-completion-evidence', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              if (!context.currentTurn || !context.providerSessionId) {
                throw new Error('Expected a bound ACP session and active turn');
              }
              const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
              const completedEvidence = { ...evidence, outcome: { kind: 'completed' as const } };
              evidenceResults.push(
                context.currentTurn.submitCompletionEvidence({
                  providerSessionId: 'foreign-session',
                  promptId: evidence.promptId,
                  outcome: { kind: 'completed' },
                }),
                context.currentTurn.submitCompletionEvidence({
                  providerSessionId: evidence.providerSessionId,
                  promptId: 'stale-turn',
                  outcome: { kind: 'completed' },
                }),
                context.currentTurn.submitCompletionEvidence({
                  ...completedEvidence,
                  outcome: { kind: 'future' as never },
                }),
                context.currentTurn.submitCompletionEvidence(completedEvidence),
                context.currentTurn.submitCompletionEvidence(completedEvidence),
              );
              observedContext = {
                providerSessionId: context.providerSessionId,
                turnId: context.currentTurn.turnId,
              };
              submitAfterSettlement = () => context.currentTurn!.submitCompletionEvidence(completedEvidence);
              return { providerSessionId: context.providerSessionId, turnId: context.currentTurn.turnId };
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-completion-evidence'],
          input: { text: 'complete through evidence' },
          delivery: { kind: 'newTurn', turnId: 'turn-completion-evidence' },
        });
        await collectUntil(events, 'turn-complete');
        expect(evidenceResults).toEqual([false, false, false, true, false]);
        expect(submitAfterSettlement).not.toBeNull();
        expect((submitAfterSettlement as unknown as () => boolean)()).toBe(false);
        expect(observedContext).toEqual({
          providerSessionId: 'provider-created',
          turnId: 'turn-completion-evidence',
        });
        expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('releases prompt admission when correlated completion evidence arrives before a stranded prompt RPC', async () => {
    await withTempDir('happier-public-acp-stranded-prompt-evidence-', async (dir) => {
      const fixture = createFixture(dir, 'extension-completion-stranded');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-stranded-prompt-evidence', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              if (!context.currentTurn) throw new Error('Expected an active turn');
              const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
              return {
                accepted: context.currentTurn.submitCompletionEvidence({
                  ...evidence,
                  outcome: { kind: 'completed' },
                }),
              };
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        const result = await Promise.race([
          session.send({
            inputIds: ['input-stranded-prompt-evidence'],
            input: { text: 'complete despite stranded prompt RPC' },
            delivery: { kind: 'newTurn', turnId: 'turn-stranded-prompt-evidence' },
          }),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
        ]);
        expect(result).not.toBe('timed-out');
        await collectUntil(events, 'turn-complete');
        expect(events.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
        expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('replays a complete provider turn in order when it streams before the prompt response', async () => {
    await withTempDir('happier-public-acp-pre-response-turn-', async (dir) => {
      const fixture = createFixture(dir, 'extension-completion-delayed-stream');
      const evidenceResults: boolean[] = [];
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-pre-response-turn', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              if (!context.currentTurn) throw new Error('Expected an active turn');
              const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
              const accepted = context.currentTurn.submitCompletionEvidence({
                ...evidence,
                outcome: { kind: 'completed' },
              });
              evidenceResults.push(accepted);
              return {
                accepted,
              };
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-pre-response-turn'],
          input: { text: 'stream the complete turn before acknowledging' },
          delivery: { kind: 'newTurn', turnId: 'turn-pre-response-turn' },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');

        expect(evidenceResults).toEqual([true]);
        // Accumulator refinements retain the same durable tool identity.
        const seenToolCalls = new Set<string>();
        const lifecycleEvents = events.filter((event) => {
          if (event.kind !== 'tool-call') return true;
          const identity = `${event.turnId}:${event.toolCallId}`;
          if (seenToolCalls.has(identity)) return false;
          seenToolCalls.add(identity);
          return true;
        });
        const toolCalls = events.filter((event) => event.kind === 'tool-call');
        expect(new Set(toolCalls.map((event) => event.toolCallId))).toEqual(new Set(['pre-response-tool']));
        for (const event of toolCalls) {
          expect(event).toMatchObject({
            turnId: 'turn-pre-response-turn',
            toolName: 'read',
            input: expect.objectContaining({ path: '/workspace/README.md' }),
          });
          expect(event.sequence).toBeLessThan(events.find((candidate) => candidate.kind === 'tool-result')!.sequence);
        }
        expect(lifecycleEvents.map(event => event.kind)).toEqual([
          'provider-session-id',
          'input-accepted',
          'turn-start',
          'message-delta',
          'message-delta',
          'tool-call',
          'tool-result',
          'message-delta',
          'turn-complete',
        ]);
        expect(events.filter((event) => event.kind === 'message-delta' && event.channel === 'reasoning')).toEqual([
          expect.objectContaining({
            turnId: 'turn-pre-response-turn',
            text: 'checking',
          }),
        ]);
        expect(events.filter((event) => event.kind === 'message-delta' && event.channel === 'assistant')).toEqual([
          expect.objectContaining({
            turnId: 'turn-pre-response-turn',
            text: 'assistant before prompt response',
          }),
          expect.objectContaining({
            turnId: 'turn-pre-response-turn',
            text: 'assistant after tool',
          }),
        ]);
        expect(events.filter((event) => (
          event.kind === 'turn-complete'
          || event.kind === 'turn-failed'
          || event.kind === 'turn-cancelled'
        ))).toEqual([
          expect.objectContaining({
            kind: 'turn-complete',
            turnId: 'turn-pre-response-turn',
          }),
        ]);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it.each(['completion-retry', 'completion-error-retry', 'request-retry', 'request-reset'] as const)('retains ACP provider limit evidence through canonical Session issue classification (%s)', async failurePath => {
    await withTempDir('happier-public-acp-limit-evidence-', async dir => {
      const fixture = createFixture(dir, failurePath.startsWith('completion') ? 'extension-completion' : 'provider-limit-' + failurePath);
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-limit-evidence', cwd: dir }, {
        ...fixture.options,
        extensions: { requests: { 'acme/echo': (params, context) => {
          const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
          return { accepted: handleGrokPromptComplete({ sessionId: evidence.providerSessionId, promptId: evidence.promptId,
            stopReason: failurePath === 'completion-error-retry' ? 'error' : 'rate_limit',
            agentResult: { retryAfterMs: 120000, ...(failurePath === 'completion-error-retry' ? { status: 429 } : {}), token: 'private-provider-token' },
          }, { ...context, method: GROK_PROMPT_COMPLETE_METHOD }) };
        } } },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['limit-input'], input: { text: 'continue' }, delivery: { kind: 'newTurn', turnId: 'limit-turn' } });
        await waitForCondition(() => events.some(event => event.kind === 'turn-failed' || event.kind === 'input-rejected'),
          { timeoutMs: 5000, intervalMs: 10, label: 'provider limit failure' });
        const failure = events.find(event => event.kind === 'turn-failed' || event.kind === 'input-rejected');
        if (!failure || (failure.kind !== 'turn-failed' && failure.kind !== 'input-rejected')) throw new Error('Expected provider failure evidence');
        const issue = classifyPrimarySessionRuntimeIssue({ provider: 'grok', cause: 'session_error', error: failure.diagnostic });
        expect(issue).toMatchObject({ source: 'usage_limit', usageLimit: { limitCategory: 'rate_limit',
          ...(failurePath === 'request-reset' ? { resetAtMs: 1900000000000 } : { resetAtMs: null, retryAfterMs: 120000 }),
        } });
        expect(JSON.stringify(issue)).not.toContain('private-provider-token');
        expect(JSON.stringify(events)).not.toContain('private-provider-token');
        expect(events.some(event => event.kind === 'turn-complete')).toBe(false);
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it.each([false, true])('rejects arbitrary provider payloads and redacts accepted completion messages (diagnostic=%s)', async structured => {
    await withTempDir('happier-public-acp-completion-diagnostic-safety-', async dir => {
      const fixture = createFixture(dir, 'extension-completion');
      const admissions: boolean[] = [];
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-diagnostic-safety', cwd: dir }, {
        ...fixture.options,
        extensions: { requests: { 'acme/echo': (params, context) => {
          if (!context.currentTurn) throw new Error('Expected an active turn');
          const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
          const invalidDiagnostic = { code: 'provider_rate_limit', severity: 'error' as const,
            rawProviderPayload: { token: 'private-provider-token' } };
          admissions.push(context.currentTurn.submitCompletionEvidence({ ...evidence,
            outcome: { kind: 'failed', diagnostic: invalidDiagnostic },
          }));
          return { accepted: context.currentTurn.submitCompletionEvidence({ ...evidence, outcome: {
            kind: 'failed', message: JSON.stringify({ token: 'private-completion-token' }),
            ...(structured ? { diagnostic: { code: 'provider_rate_limit', severity: 'error' as const,
              message: JSON.stringify({ token: 'private-diagnostic-token' }), details: { requestErrorCode: -32000 } } } : {}),
          } }) };
        } } },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => { events.push(event); });
      try {
        await session.send({ inputIds: ['diagnostic-input'], input: { text: 'finish' }, delivery: { kind: 'newTurn', turnId: 'diagnostic-turn' } });
        await collectUntil(events, 'turn-failed');
        expect(admissions).toEqual([false]);
        expect(events.some(event => event.kind === 'turn-complete')).toBe(false);
        expect(JSON.stringify(events)).not.toContain('private-completion-token');
        expect(JSON.stringify(events)).not.toContain('private-diagnostic-token');
        if (structured) expect(events.find(event => event.kind === 'turn-failed')).toMatchObject({
          diagnostic: { code: 'provider_rate_limit', details: { requestErrorCode: -32000 } },
        });
        expect(JSON.stringify(events)).not.toContain('private-provider-token');
      } finally { subscription.dispose(); await session.dispose(); }
    });
  });

  it('projects correlated provider failure evidence as turn-failed rather than successful completion', async () => {
    await withTempDir('happier-public-acp-completion-failure-', async (dir) => {
      const fixture = createFixture(dir, 'extension-completion');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-completion-failure', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              if (!context.currentTurn) throw new Error('Expected an active turn');
              const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
              return {
                accepted: context.currentTurn.submitCompletionEvidence({
                  ...evidence,
                  outcome: { kind: 'failed', message: 'provider rate limit' },
                }),
              };
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-completion-failure'],
          input: { text: 'fail through evidence' },
          delivery: { kind: 'newTurn', turnId: 'turn-completion-failure' },
        });
        await collectUntil(events, 'turn-failed');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-failed',
          turnId: 'turn-completion-failure',
          diagnostic: expect.objectContaining({
            code: 'acp_turn_failed',
            message: 'provider rate limit',
          }),
        }));
        expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('projects only trusted bounded image inputs into declared ACP text-image and image-only prompts', async () => {
    await withTempDir('happier-public-acp-media-', async (dir) => {
      const uploadDir = path.join(dir, '.happier', 'uploads', 'messages', 'message-1');
      const uploadPath = path.join(uploadDir, 'image.png');
      const structuredUploadPath = '.happier/uploads/messages/message-1/image.png';
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await mkdir(uploadDir, { recursive: true });
      await writeFile(uploadPath, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const uploadedImage = {
        name: 'image.png',
        path: structuredUploadPath,
        mimeType: 'image/png',
        sha256,
        sizeBytes: bytes.length,
      };
      const endUserMessageMeta = {
        happier: {
          kind: 'attachments.v1',
          payload: { attachments: [uploadedImage] },
        },
        happierStructuredInputV1: {
          v: 1,
          imageInputs: [{
            ...uploadedImage,
            type: 'localImage',
            kind: 'image',
            localPath: structuredUploadPath,
            path: structuredUploadPath,
            provenance: { kind: 'sessionAttachmentUpload' },
          }],
        },
      };
      const structuredInput = readHappierStructuredInputV1FromMeta(endUserMessageMeta, {
        allowedLocalImagePaths: readAttachmentEnvelopeLocalImagePaths(endUserMessageMeta),
      });
      expect(structuredInput?.imageInputs).toHaveLength(1);
      const imageInput = structuredInput?.imageInputs?.[0];
      if (!imageInput) throw new Error('Expected the authorized upload to become a structured image input');
      const strictStructuredInput = AgentRuntimeJsonValueV1Schema.parse(structuredInput);
      const fixture = createFixture(dir, 'media');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-media', cwd: dir,
      }, fixture.options, fixture.dependencies);
      expect(session.runtimeCapabilities).toMatchObject({ backend: { session: { media: { acceptsImageInput: { supported: true } } } } });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await session.send({
          inputIds: ['input-media-text'],
          input: { text: 'look', structuredInput: strictStructuredInput },
          delivery: { kind: 'newTurn', turnId: 'turn-media-text' },
        });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            prompt: [
              { type: 'text', text: 'look' },
              { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
            ],
            promptId: 'turn-media-text',
          }),
        }));

        await session.send({
          inputIds: ['input-media-only'],
          input: { text: '', structuredInput: strictStructuredInput },
          delivery: { kind: 'newTurn', turnId: 'turn-media-only' },
        });
        await waitForCondition(
          () => events.some((event) => event.kind === 'turn-complete' && event.turnId === 'turn-media-only'),
          { timeoutMs: 5_000, intervalMs: 10, label: 'image-only ACP turn completion' },
        );
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-media-only',
          text: JSON.stringify({
            prompt: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
            promptId: 'turn-media-only',
          }),
        }));

        await expect(session.send({
          inputIds: ['input-media-untrusted'],
          input: {
            text: 'untrusted',
            structuredInput: { v: 1, imageInputs: [{ ...imageInput, provenance: { kind: 'untrusted' } }] },
          },
          delivery: { kind: 'newTurn', turnId: 'turn-media-untrusted' },
        })).resolves.toMatchObject({
          status: 'rejected',
          diagnostic: { code: 'acp_image_input_untrusted' },
        });
        await expect(session.send({
          inputIds: ['input-media-arbitrary-path'],
          input: {
            text: 'arbitrary path',
            structuredInput: { v: 1, imageInputs: [{ ...imageInput, path: uploadPath }] },
          },
          delivery: { kind: 'newTurn', turnId: 'turn-media-arbitrary-path' },
        })).resolves.toMatchObject({
          status: 'rejected',
          diagnostic: { code: 'acp_image_input_untrusted' },
        });
      } finally {
        subscription.dispose();
        await session.dispose();
      }

      const unsupportedFixture = createFixture(dir, 'completed');
      const unsupported = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-media-unsupported', cwd: dir,
      }, unsupportedFixture.options, unsupportedFixture.dependencies);
      expect(unsupported.runtimeCapabilities).toMatchObject({ backend: { session: { media: { acceptsImageInput: { supported: false } } } } });
      try {
        await expect(unsupported.send({
          inputIds: ['input-media-unsupported'],
          input: { text: 'look', structuredInput: strictStructuredInput },
          delivery: { kind: 'newTurn', turnId: 'turn-media-unsupported' },
        })).resolves.toMatchObject({
          status: 'unsupported',
          diagnostic: { code: 'acp_image_input_unsupported' },
        });
      } finally {
        await unsupported.dispose();
      }
    });
  });

  it('allows a provider-declared verified image-input override without weakening trusted media projection', async () => {
    await withTempDir('happier-public-acp-media-override-', async (dir) => {
      const uploadDir = path.join(dir, '.happier', 'uploads', 'messages', 'message-override');
      const uploadPath = path.join(uploadDir, 'image.png');
      const structuredUploadPath = '.happier/uploads/messages/message-override/image.png';
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await mkdir(uploadDir, { recursive: true });
      await writeFile(uploadPath, bytes);
      const imageInput = {
        id: 'image-override',
        kind: 'localImage' as const,
        path: structuredUploadPath,
        mimeType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        provenance: { kind: 'sessionAttachmentUpload' },
      };
      const fixture = createFixture(dir, 'media-override');
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-media-override', cwd: dir,
      }, {
        ...fixture.options,
        definition: {
          acceptsVerifiedImageInput: true,
          mcp: { policy: 'drop' },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        await expect(session.send({
          inputIds: ['input-media-override'],
          input: { text: 'look', structuredInput: { v: 1, imageInputs: [imageInput] } },
          delivery: { kind: 'newTurn', turnId: 'turn-media-override' },
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          text: JSON.stringify({
            prompt: [
              { type: 'text', text: 'look' },
              { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
            ],
            promptId: 'turn-media-override',
          }),
        }));

        await expect(session.send({
          inputIds: ['input-media-override-image-only'],
          input: { text: '', structuredInput: { v: 1, imageInputs: [imageInput] } },
          delivery: { kind: 'newTurn', turnId: 'turn-media-override-image-only' },
        })).resolves.toEqual({ status: 'admitted' });
        await waitForCondition(
          () => events.some((event) => (
            event.kind === 'turn-complete' && event.turnId === 'turn-media-override-image-only'
          )),
          { timeoutMs: 5_000, intervalMs: 10, label: 'overridden image-only ACP turn completion' },
        );
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-media-override-image-only',
          text: JSON.stringify({
            prompt: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
            promptId: 'turn-media-override-image-only',
          }),
        }));

        await expect(session.send({
          inputIds: ['input-media-override-untrusted'],
          input: {
            text: 'untrusted',
            structuredInput: { v: 1, imageInputs: [{ ...imageInput, provenance: { kind: 'untrusted' } }] },
          },
          delivery: { kind: 'newTurn', turnId: 'turn-media-override-untrusted' },
        })).resolves.toMatchObject({
          status: 'rejected', diagnostic: { code: 'acp_image_input_untrusted' },
        });
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('ignores otherwise matching proprietary completion evidence after cancellation', async () => {
    await withTempDir('happier-public-acp-completion-after-cancel-', async (dir) => {
      const fixture = createFixture(dir, 'extension-completion');
      let submitEvidence: (() => boolean) | null = null;
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-completion-after-cancel', cwd: dir,
      }, {
        ...fixture.options,
        extensions: {
          requests: {
            'acme/echo': (params, context) => {
              if (!context.currentTurn) throw new Error('Expected an active turn');
              const evidence = params as Readonly<{ providerSessionId: string; promptId: string }>;
              submitEvidence = () => context.currentTurn!.submitCompletionEvidence({
                ...evidence,
                outcome: { kind: 'completed' },
              });
              return { observed: true };
            },
          },
        },
      }, fixture.dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch((event) => { events.push(event); });
      try {
        const sending = session.send({
          inputIds: ['input-completion-after-cancel'],
          input: { text: 'cancel before evidence' },
          delivery: { kind: 'newTurn', turnId: 'turn-completion-after-cancel' },
        });
        await waitForCondition(
          () => submitEvidence !== null,
          { timeoutMs: 5_000, intervalMs: 10, label: 'completion evidence hook before cancellation' },
        );
        await expect(session.cancel?.({
          turnId: 'turn-completion-after-cancel',
          reason: 'user',
        })).resolves.toMatchObject({ status: 'requested' });
        await expect(sending).resolves.toEqual({ status: 'admitted' });
        expect(submitEvidence).not.toBeNull();
        expect((submitEvidence as unknown as () => boolean)()).toBe(false);
        await collectUntil(events, 'turn-cancelled');
        expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(0);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('disposes and fences the public session when its generation signal aborts', async () => {
    await withTempDir('happier-public-acp-abort-', async (dir) => {
      const fixture = createFixture(dir, 'hanging');
      const controller = new AbortController();
      const session = await createPublicAcpSession({
        kind: 'create', sessionId: 'host-abort', cwd: dir,
      }, fixture.options, { ...fixture.dependencies, signal: controller.signal });
      await session.send({
        inputIds: ['input-before-abort'],
        input: { text: 'wait' },
        delivery: { kind: 'newTurn', turnId: 'turn-before-abort' },
      });
      controller.abort();
      await waitForCondition(
        async () => (await session.send({
          inputIds: ['input-after-abort'],
          input: { text: 'later' },
          delivery: { kind: 'newTurn', turnId: 'turn-after-abort' },
        })).status === 'unavailable',
        { timeoutMs: 5_000, intervalMs: 10, label: 'aborted public ACP runtime fencing' },
      );
      await expect(session.cancel?.({ turnId: 'turn-before-abort', reason: 'user' }))
        .resolves.toMatchObject({ status: 'unavailable' });
      await session.dispose();
    });
  });

  it.each([
    {
      name: 'preserves a non-blank opaque id byte-exactly',
      forkedProviderSessionId: OPAQUE_HISTORY_FORK_PROVIDER_SESSION_ID,
      accepted: true,
    },
    {
      name: 'rejects a blank-only id',
      forkedProviderSessionId: ' \n\t ',
      accepted: false,
    },
  ] as const)('$name from an extension-backed ACP fork', async ({
    forkedProviderSessionId,
    accepted,
  }) => {
    await withTempDir('happier-public-acp-websocket-history-fork-', async (dir) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP WebSocket address');
      const loadedProviderSessionIds: string[] = [];
      server.on('connection', (socket) => {
        socket.on('message', (raw) => {
          const request = JSON.parse(raw.toString()) as Readonly<{
            id?: string | number;
            method?: string;
            params?: Readonly<{ sessionId?: string }>;
          }>;
          const send = (result: unknown) => socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result,
          }));
          if (request.method === 'initialize') {
            send({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [],
            });
          } else if (request.method === 'x.ai/session/fork') {
            send({ newSessionId: forkedProviderSessionId });
          } else if (request.method === 'session/load') {
            if (typeof request.params?.sessionId === 'string') {
              loadedProviderSessionIds.push(request.params.sessionId);
            }
            send({});
          } else if (request.id !== undefined) {
            send({});
          }
        });
      });

      const fixture = createFixture(dir, 'completed');
      let session: Awaited<ReturnType<typeof createPublicAcpSession>> | null = null;
      try {
        const opening = createPublicAcpSession({
          kind: 'fork',
          sessionId: 'host-websocket-history-child',
          cwd: dir,
          source: {
            sessionId: 'host-parent',
            providerSessionId: 'provider-parent',
            cwd: '/source-workspace',
          },
        }, {
          transport: {
            kind: 'webSocket',
            url: `ws://127.0.0.1:${address.port}/acp`,
            timeouts: { initializeMs: 2_000, idleMs: 20 },
          },
          definition: createHistoryDefinition(),
        }, fixture.dependencies);
        if (!accepted) {
          await expect(opening).rejects.toThrow(
            'ACP history fork response did not include a valid provider session id',
          );
          expect(loadedProviderSessionIds).toEqual([]);
          return;
        }

        session = await opening;
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = session.watch((event) => { events.push(event); });
        try {
          await collectUntil(events, 'provider-session-id');
          expect(loadedProviderSessionIds).toEqual([forkedProviderSessionId]);
          expect(loadedProviderSessionIds).not.toContain(forkedProviderSessionId.trim());
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'provider-session-id',
            providerSessionId: forkedProviderSessionId,
          }));
          expect(events).not.toContainEqual(expect.objectContaining({
            kind: 'provider-session-id',
            providerSessionId: forkedProviderSessionId.trim(),
          }));
        } finally {
          subscription.dispose();
        }
      } finally {
        await session?.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it('opens a declared WebSocket ACP endpoint and disposes its owned connection once', async () => {
    await withTempDir('happier-public-acp-websocket-', async (dir) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP WebSocket address');
      let closeCount = 0;
      server.on('connection', (socket) => {
        socket.on('close', () => { closeCount += 1; });
        socket.on('message', (raw) => {
          const request = JSON.parse(raw.toString()) as Readonly<{
            id?: string | number;
            method?: string;
            params?: Readonly<{ sessionId?: string }>;
          }>;
          const send = (value: unknown) => socket.send(JSON.stringify(value));
          if (request.method === 'initialize') {
            send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          } else if (request.method === 'session/new') {
            send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'websocket-provider-session' } });
          } else if (request.method === 'session/prompt') {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: request.params?.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'websocket response' },
                },
              },
            });
            send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
          } else if (request.id !== undefined) {
            send({ jsonrpc: '2.0', id: request.id, result: {} });
          }
        });
      });

      const fixture = createFixture(dir, 'completed');
      let session: Awaited<ReturnType<typeof createPublicAcpSession>> | null = null;
      try {
        session = await createPublicAcpSession({
          kind: 'create', sessionId: 'host-websocket', cwd: dir,
        }, {
          transport: {
            kind: 'webSocket',
            url: `ws://127.0.0.1:${address.port}/acp`,
            timeouts: { initializeMs: 2_000, idleMs: 20 },
          },
        }, fixture.dependencies);
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = session.watch((event) => { events.push(event); });
        try {
          await expect(session.send({
            inputIds: ['input-websocket'],
            input: { text: 'hello websocket' },
            delivery: { kind: 'newTurn', turnId: 'turn-websocket' },
          })).resolves.toEqual({ status: 'admitted' });
          await collectUntil(events, 'turn-complete');
          expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'message-delta', text: 'websocket response' }),
            expect.objectContaining({ kind: 'turn-complete', turnId: 'turn-websocket' }),
          ]));
        } finally {
          subscription.dispose();
        }
        await session.dispose();
        await session.dispose();
        await waitForCondition(
          () => closeCount === 1,
          { timeoutMs: 2_000, intervalMs: 10, label: 'one WebSocket close' },
        );
      } finally {
        await session?.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it('preserves unknown custody and ends the runtime when TCP is lost before provider effect', async () => {
    await withTempDir('happier-public-acp-tcp-loss-', async (dir) => {
      const server = createServer((socket) => {
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line) as Readonly<{
              id?: string | number;
              method?: string;
            }>;
            const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
            if (request.method === 'initialize') {
              send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
            } else if (request.method === 'session/new') {
              send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'tcp-provider-session' } });
            } else if (request.method === 'session/prompt') {
              socket.destroy();
            } else if (request.id !== undefined) {
              send({ jsonrpc: '2.0', id: request.id, result: {} });
            }
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');

      const fixture = createFixture(dir, 'completed');
      let session: Awaited<ReturnType<typeof createPublicAcpSession>> | null = null;
      try {
        session = await createPublicAcpSession({
          kind: 'create', sessionId: 'host-tcp', cwd: dir,
        }, {
          transport: {
            kind: 'tcp',
            host: '127.0.0.1',
            port: address.port,
            timeouts: { initializeMs: 2_000, idleMs: 20 },
          },
        }, fixture.dependencies);
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = session.watch((event) => { events.push(event); });
        try {
          await expect(session.send({
            inputIds: ['input-tcp-loss'],
            input: { text: 'disconnect now' },
            delivery: { kind: 'newTurn', turnId: 'turn-tcp-loss' },
          })).resolves.toEqual({ status: 'admitted' });
          await collectUntil(events, 'runtime-ended');
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'input-custody-unknown', inputIds: ['input-tcp-loss'],
          }));
          expect(events.some((event) => event.kind === 'input-accepted' || event.kind.startsWith('turn-'))).toBe(false);
          const invariant = createAgentSessionTurnInvariant({ sessionId: 'host-tcp' });
          expect(events.map((event) => invariant.observe(event).status)).toEqual(events.map(() => 'accepted'));
          expect(events.filter((event) => event.kind === 'runtime-ended')).toEqual([
            expect.objectContaining({
              kind: 'runtime-ended',
              cause: 'connectionLost',
              retryable: true,
              diagnostic: expect.objectContaining({ code: 'acp_connection_lost' }),
            }),
          ]);
          await expect(session.send({
            inputIds: ['input-after-tcp-loss'],
            input: { text: 'must not remain pending' },
            delivery: { kind: 'newTurn', turnId: 'turn-after-tcp-loss' },
          })).resolves.toMatchObject({ status: 'unavailable' });
        } finally {
          subscription.dispose();
        }
      } finally {
        await session?.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
