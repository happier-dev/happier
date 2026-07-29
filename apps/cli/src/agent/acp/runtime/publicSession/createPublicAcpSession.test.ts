import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';

const psListState = vi.hoisted(() => ({
  actual: null as null | (() => Promise<unknown[]>),
  mock: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  psListState.actual = actual.default;
  psListState.mock.mockImplementation(actual.default);
  return { default: psListState.mock };
});

import type {
  AgentAcpModel,
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  AgentRuntimeJsonValueV1Schema,
  AgentSessionProviderCheckpointMaxJsonBytesV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
} from '@happier-dev/protocol/runtime';
import type {
  HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
  HostSessionApprovalRequest as PluginSessionApprovalRequest,
  HostSessionApprovalResult as PluginSessionApprovalResult,
  HostSessionConfirmationRequest as PluginSessionConfirmationRequest,
  HostSessionConfirmationResult as PluginSessionConfirmationResult,
  HostSessionInteractionRequest as PluginSessionInteractionRequest,
  HostSessionInteractionResult as PluginSessionInteractionResult,
  HostSessionQuestionsRequest as PluginSessionQuestionsRequest,
  HostSessionQuestionsResult as PluginSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { requestAcpHistoryExtension } from '@/agent/acp/history/acpHistoryExtensionMethods';
import { withTempDir } from '@/testkit/fs/tempDir';
import { waitForCondition } from '@/testkit/async/waitFor';

import {
  createPublicAcpSession,
  createPublicAcpSessionFromAwaitableAdapter,
  type PublicAcpComposerDependencies,
} from './createPublicAcpSession';

afterEach(() => {
  if (psListState.actual) psListState.mock.mockImplementation(psListState.actual);
});

type ApprovalRequester = (
  request: PluginSessionApprovalRequest,
  options?: { signal?: AbortSignal },
) => Promise<PluginSessionApprovalResult>;

class TestInteractions implements PluginCurrentSessionInteractionsService {
  constructor(private readonly requestApproval: ApprovalRequester) {}

  request(request: PluginSessionApprovalRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionApprovalResult>;
  request(request: PluginSessionQuestionsRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionQuestionsResult>;
  request(request: PluginSessionConfirmationRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionConfirmationResult>;
  async request(
    request: PluginSessionInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PluginSessionInteractionResult> {
    if (request.kind !== 'approval') throw new Error(`Unexpected ${request.kind} interaction`);
    return await this.requestApproval(request, options);
  }
}

function createApprovalRequestMock() {
  return vi.fn<ApprovalRequester>(async () => ({
    kind: 'approval',
    status: 'approved',
  }));
}

function writePublicComposerAgent(dir: string): string {
  return writeAcpTestAgentScript({
    dir,
    fileName: 'public-composer-agent.mjs',
    source: `
      const decoder = new TextDecoder();
      let buffer = '';
      const scenario = process.env.PUBLIC_ACP_SCENARIO || 'completed';
      let extensionPrompt = null;
      let extensionSession = null;
      let permissionPrompt = null;
      let permissionSession = null;
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
      let historyForkedOnThisConnection = false;
      let historyLoadedOnThisConnection = false;
      const lifecycleMethods = [];
      const selectedOptions = {};
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
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
            lifecycleMethods.push('initialize');
            initializeMetadata = request.params.clientCapabilities?._meta ?? null;
            ok(request.id, {
              protocolVersion: 1,
              agentCapabilities: scenario === 'media'
                ? { promptCapabilities: { image: true } }
                : {},
              _meta: scenario === 'auth-dynamic'
                ? { defaultAuthMethodId: 'cursor_login', providerOnly: 'bounded' }
                : scenario === 'auth-dynamic-large'
                  ? { payload: 'x'.repeat(17_000) }
                  : undefined,
              authMethods: scenario === 'auth-missing'
                ? [{ id: 'different_login', name: 'Different login' }]
                : scenario === 'auth' || scenario === 'auth-missing' || scenario === 'auth-dynamic' || scenario === 'auth-dynamic-large'
                  ? [{ id: 'cursor_login', name: 'Cursor login' }]
                  : [],
            });
          } else if (request.method === 'authenticate') {
            lifecycleMethods.push('authenticate');
            authenticated = request.params.methodId === 'cursor_login';
            if (scenario === 'auth-dynamic') {
              initializeMetadata = {
                client: initializeMetadata,
                authenticate: request.params._meta ?? null,
              };
            }
            ok(request.id, {});
          } else if (request.method === 'session/new') {
            lifecycleMethods.push('session/new');
            newSessionMetadata = request.params._meta ?? null;
            if (scenario === 'auth' && !authenticated) {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'auth required' } });
              continue;
            }
            openedMcpServers = request.params.mcpServers;
            ok(request.id, scenario === 'provider-models'
              ? {
                  sessionId: 'provider-created',
                  models: {
                    currentModelId: 'provider-current',
                    availableModels: [
                      {
                        modelId: 'provider-current',
                        name: 'Provider current',
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
            selectedOptions[request.params.configId] = request.params.value;
            if (request.params.configId === 'model') selectedModel = request.params.value;
            ok(request.id, { configOptions: [] });
          } else if (request.method === 'session/set_mode') {
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
            if (scenario === 'resume-replay') {
              userUpdate(request.params.sessionId, 'replayed user message');
              update(request.params.sessionId, 'replayed assistant message');
            }
            ok(request.id, {});
          } else if (request.method === 'session/fork') {
            ok(request.id, { sessionId: 'provider-forked' });
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
            if (scenario === 'completed') {
              update(sessionId, 'hello from ACP');
              ok(request.id, { stopReason: 'end_turn' });
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
            } else if (scenario === 'prompt-rejected-before-effect') {
              send({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32602, message: 'prompt rejected before effect' },
              });
            } else if (scenario === 'prompt-rejected-after-update') {
              update(sessionId, 'provider output before rejected response');
              send({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: 'prompt response lost after output' },
              });
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
                    kind: 'investigation',
                    rawInput: { locations: ['/workspace'] },
                  },
                },
              });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'configuration-update' || scenario === 'configuration-update-concurrent') {
              update(sessionId, JSON.stringify({ selectedMode, selectedModel, selectedOptions }));
              ok(request.id, { stopReason: 'end_turn' });
            } else if (scenario === 'auth' || scenario === 'auth-dynamic') {
              update(sessionId, JSON.stringify({ lifecycleMethods, initializeMetadata, newSessionMetadata }));
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
    readModels: () => publishedModels,
    readModelPublications: () => modelPublications,
    dependencies: {
      pluginId: 'acme.plugin',
      agentId: 'acme-agent',
      signal: new AbortController().signal,
      isCurrent: () => current,
      systemTools: { resolve },
      interactions: new TestInteractions(requestInteraction),
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
        timeouts: { initializeMs: 2_000, idleMs: 20, toolCallMs: 2_000 },
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
  it('settles real non-detached ACP disposal when descendant discovery stalls', async () => {
    await withTempDir('happier-public-acp-stalled-process-census-', async (dir) => {
      const fixture = createFixture(dir, 'completed');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-stalled-process-census',
        cwd: dir,
      }, fixture.options, fixture.dependencies);
      psListState.mock.mockImplementation(() => new Promise<unknown[]>(() => {}));

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

  it('projects one terminal provider output through the existing session media service exactly once', async () => {
    await withTempDir('happier-public-acp-generated-media-', async (dir) => {
      const fixture = createFixture(dir, 'generated-media');
      const mediaPath = path.join(dir, 'generated', 'generated.png');
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
              return [{ rootPath: path.dirname(mediaPath), path: mediaPath }];
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
          () => fixture.publishGeneratedMedia.mock.calls.length === 1,
          { timeoutMs: 2_000, intervalMs: 10, label: 'generated media publication' },
        );

        expect(fixture.registerMediaSourceRoot).toHaveBeenCalledOnce();
        expect(fixture.registerMediaSourceRoot).toHaveBeenCalledWith({
          rootPath: path.dirname(mediaPath),
        });
        expect(fixture.publishGeneratedMedia).toHaveBeenCalledOnce();
        expect(fixture.publishGeneratedMedia).toHaveBeenCalledWith(expect.objectContaining({
          path: mediaPath,
          toolCallId: 'generated-image-1',
        }));
        expect(fixture.disposeMediaSourceRoot).toHaveBeenCalledOnce();
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

  it('publishes provider-authoritative models and model-scoped options instead of stale host selection', async () => {
    await withTempDir('happier-public-acp-models-', async (dir) => {
      const fixture = createFixture(dir, 'provider-models');
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-provider-models',
        cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'stale-host', updatedAtMs: 1 },
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
          model: { value: 'stale-host', updatedAtMs: 1 },
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

        await expect(session.updateConfiguration?.({
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'provider-current', updatedAtMs: 2 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'low', updatedAtMs: 3 } },
        })).resolves.toMatchObject({ status: 'rejected' });
        expect(fixture.readModels()).toEqual(afterApplied);
      } finally {
        await session.dispose();
      }
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
            toolCallMs: 2_000,
            investigationToolCallMs: 4_000,
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
        mcpServers: {
          happier: { command: 'happier-mcp', args: ['serve'] },
        },
      };
      const session = await createPublicAcpSession({
        kind: 'create',
        sessionId: 'host-vb4',
        cwd: dir,
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

  it('applies newer native configuration fields through the canonical ACP session controls', async () => {
    await withTempDir('happier-public-acp-configuration-update-', async (dir) => {
      const fixture = createFixture(dir, 'configuration-update');
      const options = {
        ...fixture.options,
        definition: {
          modelConfigOptionId: 'model',
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
        })).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-complete');

        expect(fixture.requestInteraction).toHaveBeenCalledTimes(1);
        expect(fixture.requestInteraction).toHaveBeenCalledWith({
          kind: 'approval',
          requestId: 'acp:["turn-permission","tool-call-1"]',
          title: 'Allow execute?',
          subject: {
            kind: 'tool',
            name: 'execute',
            input: { command: 'pwd' },
          },
          allowedPersistenceScopes: ['session'],
        }, { signal: expect.any(AbortSignal) });
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-permission',
          text: JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
        }));
        expect(events.filter((event) => (
          event.kind === 'tool-call' && event.toolCallId === 'tool-call-1'
        ))).toHaveLength(1);
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('scopes reused ACP tool-call ids to their public turns for SVC10 custody', async () => {
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
        });
        await collectUntil(events, 'turn-complete');

        await session.send({
          inputIds: ['input-permission-second'],
          input: { text: 'run pwd second' },
          delivery: { kind: 'newTurn', turnId: 'turn-permission-second' },
        });
        await waitForCondition(
          () => events.filter((event) => event.kind === 'turn-complete').length === 2,
          { timeoutMs: 5_000, intervalMs: 10, label: 'second correlated ACP permission turn' },
        );

        const requestIds = fixture.requestInteraction.mock.calls.map(([interaction]) => interaction.requestId);
        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).not.toBe(requestIds[1]);
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

        expect(events.map((event) => event.kind)).toEqual([
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
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
          }),
          expect.objectContaining({
            kind: 'message-delta',
            turnId: 'turn-1',
            text: 'hello from ACP',
          }),
        ]));
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('maps a request-scoped prompt rejection before provider effect to input-rejected', async () => {
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
      } finally {
        subscription.dispose();
        await session.dispose();
      }
    });
  });

  it('maps a rejected prompt response after provider output to unknown custody and releases buffered output', async () => {
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

        expect(events.map((event) => event.kind)).toEqual([
          'provider-session-id',
          'input-custody-unknown',
          'turn-start',
          'message-delta',
          'turn-failed',
        ]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-prompt-ambiguous',
          text: 'provider output before rejected response',
        }));
        expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
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

      const hangingFixture = createFixture(dir, 'hanging');
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
        });
        await hanging.send({
          inputIds: ['input-steer'],
          input: { text: 'steer' },
          delivery: { kind: 'steer', turnId: 'turn-primary' },
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
        expect(hangingEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
        await hanging.cancel?.({ turnId: 'turn-primary', reason: 'user' });
        await collectUntil(hangingEvents, 'turn-cancelled');
      } finally {
        hangingSubscription.dispose();
        await hanging.dispose();
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

    it.each([
      { label: 'empty', methods: [] },
      {
        label: 'oversized',
        methods: Array.from({ length: 9 }, (_, index) => `x.test/fork-${index}`),
      },
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
      const fixture = createFixture(dir, 'completed');
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
          sendUserTextMessageCommitted: async (text, options) => {
            imported.push({ role: 'user', text, meta: options.meta });
          },
          sendAgentMessageCommitted: async (_provider, message, options) => {
            if (message.type !== 'message') throw new Error('expected replayed agent message');
            imported.push({ role: 'agent', text: message.message, meta: options?.meta });
          },
          updateMetadata: async () => undefined,
        },
      });
      try {
        expect(imported).toEqual([
          {
            role: 'user',
            text: 'replayed user message',
            meta: { importedFrom: 'acp-history' },
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
        expect(events.map((event) => event.kind)).toEqual(['provider-session-id']);
        await expect(session.cancel?.({ turnId: 'turn-pre-ack-cancel', reason: 'user' }))
          .resolves.toEqual({ status: 'requested', turnId: 'turn-pre-ack-cancel' });
        await expect(sending).resolves.toEqual({ status: 'admitted' });
        await collectUntil(events, 'turn-cancelled');
        expect(events.map((event) => event.kind)).toEqual([
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
        expect(events.map((event) => event.kind)).toEqual([
          'provider-session-id',
          'input-accepted',
          'turn-start',
          'message-delta',
          'tool-call',
          'tool-result',
          'message-delta',
          'turn-complete',
        ]);
        expect(events.filter((event) => event.kind === 'message-delta')).toEqual([
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
});
