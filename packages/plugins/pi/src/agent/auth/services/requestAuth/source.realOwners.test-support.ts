import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
  ConnectedAccountAuthFailureRequestV1Schema,
  ConnectedAccountQuotaFailureRequestV1Schema,
  PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  SPAWN_SESSION_ERROR_CODES,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';
import type {
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
  JsonValue,
  ManagedExecutableRef,
  PluginProtocolClientHandle,
  PluginProtocolClientSpec,
} from '@happier-dev/plugin-sdk/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from '../../../../../../../../apps/cli/src/daemon/controlServer.js';
import {
  createConnectedServiceContinuationMessageDispatcher,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher.js';
import {
  ConnectedServiceRefreshCoordinator,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator.js';
import {
  ConnectedServiceQuotasCoordinator,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/quotas/ConnectedServiceQuotasCoordinator.js';
import {
  applyConnectedAccountRequestAuthRecovery,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthRecovery.js';
import {
  createConnectedAccountRequestAuthService,
  type ConnectedAccountRequestAuthResolvedBinding,
  type ConnectedAccountRequestAuthSubject,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService.js';
import {
  createConnectedAccountRequestAuthSubjectRegistry,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry.js';
import {
  createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator.js';
import {
  createConnectedServiceRuntimeAuthDispatcher,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/createConnectedServiceRuntimeAuthDispatcher.js';
import {
  createRuntimeAuthRecoverySchedulerForDaemon,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon.js';
import {
  handleConnectedServiceRuntimeAuthFailureForSession,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession.js';
import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate.js';
import {
  buildPiRequestAuthExtensionAssetSource,
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_DECLARED_PURPOSES,
  resolvePiRequestAuthExtensionPath,
} from './index.js';
import {
  createPiConnectedServiceRuntimeAuthAdapter,
} from '../../../connectedServices/runtimeAuthAdapter.js';
import { createPiRuntimeOperations } from '../../../runtime/rpc/operations.js';
import {
  PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS,
} from './purposes.js';

type PiVersion = '0.81.0' | '0.81.1' | '0.82.0' | '0.82.1';
type ProviderId = 'anthropic' | 'openai-codex';

type ExactPiModules = Readonly<{
  coding: typeof import('pi-coding-agent-0821');
  providers: typeof import('pi-ai-0821/providers/all');
  codingAlias: string;
  providerAlias: string;
}>;

type ProviderResponseFactory = (
  model: Readonly<{ id: string }>,
) => Response | Promise<Response>;

type Scenario = Readonly<{
  id: string;
  providerId: ProviderId;
  retryEnabled: boolean;
  cancelOnBackoff?: boolean;
  corruptFirstReportResponseAfterEffect?: boolean;
  independentSecondPrompt?: boolean;
  staleCredentialBeforeFirstReport?: boolean;
  responses: readonly ProviderResponseFactory[];
  expected: Readonly<{
    attempts: number;
    lookups: number;
    reports: number;
    accountIds: readonly string[];
    materializedAccountIds?: readonly string[];
    switchCalls?: number;
    switchEffects: number;
    refreshReads: number;
    quotaBackoffs: number;
    agentSessionRetries: number;
    terminalKind: 'turn-complete' | 'turn-failed' | 'turn-cancelled';
    exactTerminalDiagnostic?: string;
    absentDiagnostic?: string;
    visibleText?: string;
    rawAgentSessionText?: string;
    firstPrompt?: Readonly<{
      attempts: number;
      terminalKind: 'turn-complete' | 'turn-failed' | 'turn-cancelled';
      exactTerminalDiagnostic?: string;
    }>;
  }>;
}>;

type RpcBridge = Readonly<{
  handle: PluginProtocolClientHandle<'jsonStream'>;
  written: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

type RealOwnerState = {
  currentAccountId: 'primary' | 'backup';
  currentGroup: QualifiedConnectedAccountGroupV4;
  accountRevisions: Record<'primary' | 'backup', string>;
  controlRouteLookups: number;
  controlRouteLookupStatuses: number[];
  controlRouteReports: number;
  upstreamAttempts: Array<Readonly<{
    accountId: 'primary' | 'backup';
    url: string;
    headers: Readonly<Record<string, string>>;
  }>>;
  lookupAccounts: Array<'primary' | 'backup'>;
  materializedAccounts: Array<'primary' | 'backup'>;
  reportBodies: Array<Readonly<Record<string, unknown>>>;
  applyGenerationInputs: Array<Readonly<Record<string, unknown>>>;
};

type ExpectedReportFailure = Readonly<{
  class: 'authentication' | 'quota';
  evidence: Readonly<{
    httpStatus?: number;
    providerCode?: string;
    limitCategory: string;
    quotaScope: string;
    evidenceSource: Readonly<Record<string, string>>;
  }>;
}>;

const VERSIONS = ['0.81.0', '0.81.1', '0.82.0', '0.82.1'] as const;
const CREDENTIALS = {
  token: 'server-token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
  },
};
const PRIMARY_REVISION = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const BACKUP_REVISION = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
const STALE_PRIMARY_REVISION = 'csr_cccccccccccccccccccccc';
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));

const temporaryRoots = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of [...temporaryRoots]) {
    temporaryRoots.delete(root);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  }
});

function serviceFor(providerId: ProviderId): QualifiedConnectedAccountServiceRef {
  return providerId === 'anthropic'
    ? {
      pluginId: 'happier.agent.claude',
      localId: 'claude-subscription',
    }
    : {
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
    };
}

function firstPartyServiceId(
  providerId: ProviderId,
): 'claude-subscription' | 'openai-codex' {
  return providerId === 'anthropic'
    ? 'claude-subscription'
    : 'openai-codex';
}

function makeGroup(
  service: QualifiedConnectedAccountServiceRef,
  input: Readonly<{
    activeConnectedAccountId: 'primary' | 'backup';
    generation: number;
    runtimeStateRevision: number;
  }>,
): QualifiedConnectedAccountGroupV4 {
  return QualifiedConnectedAccountGroupV4Schema.parse({
    v: 1,
    ref: { service, groupId: 'fallbacks' },
    displayName: 'Fallbacks',
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
    },
    activeConnectedAccountId: input.activeConnectedAccountId,
    generation: input.generation,
    runtimeStateRevision: input.runtimeStateRevision,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [
      {
        v: 1,
        connectedAccountId: 'primary',
        priority: 10,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1,
        connectedAccountId: 'backup',
        priority: 20,
        enabled: true,
        state: {},
        createdAt: 2,
        updatedAt: 2,
      },
    ],
  });
}

function accountList(
  service: QualifiedConnectedAccountServiceRef,
  revisions: Readonly<Record<'primary' | 'backup', string>>,
) {
  return QualifiedConnectedAccountListResponseV4Schema.parse({
    service,
    accounts: [
      {
        ref: { service, accountId: 'primary' },
        status: 'connected',
        authenticationModeId: 'oauth',
        credentialRevision: revisions.primary,
        configurationReady: true,
        configurationRevision: 'configuration-primary',
        scopes: [],
      },
      {
        ref: { service, accountId: 'backup' },
        status: 'connected',
        authenticationModeId: 'oauth',
        credentialRevision: revisions.backup,
        configurationReady: true,
        configurationRevision: 'configuration-backup',
        scopes: [],
      },
    ],
  });
}

async function loadExactPiModules(version: PiVersion): Promise<ExactPiModules> {
  switch (version) {
    case '0.81.0': {
      const [coding, providers] = await Promise.all([
        import('pi-coding-agent-0810'),
        import('pi-ai-0810/providers/all'),
      ]);
      return {
        coding: coding as typeof import('pi-coding-agent-0821'),
        providers: providers as typeof import('pi-ai-0821/providers/all'),
        codingAlias: 'pi-coding-agent-0810',
        providerAlias: 'pi-ai-0810',
      };
    }
    case '0.81.1': {
      const [coding, providers] = await Promise.all([
        import('pi-coding-agent-0811'),
        import('pi-ai-0811/providers/all'),
      ]);
      return {
        coding: coding as typeof import('pi-coding-agent-0821'),
        providers: providers as typeof import('pi-ai-0821/providers/all'),
        codingAlias: 'pi-coding-agent-0811',
        providerAlias: 'pi-ai-0811',
      };
    }
    case '0.82.0': {
      const [coding, providers] = await Promise.all([
        import('pi-coding-agent-0820'),
        import('pi-ai-0820/providers/all'),
      ]);
      return {
        coding,
        providers,
        codingAlias: 'pi-coding-agent-0820',
        providerAlias: 'pi-ai-0820',
      };
    }
    case '0.82.1': {
      const [coding, providers] = await Promise.all([
        import('pi-coding-agent-0821'),
        import('pi-ai-0821/providers/all'),
      ]);
      return {
        coding,
        providers,
        codingAlias: 'pi-coding-agent-0821',
        providerAlias: 'pi-ai-0821',
      };
    }
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function createSerializedAgentSessionRpcBridge(
  session: Awaited<
    ReturnType<typeof import('pi-coding-agent-0821').createAgentSession>
  >['session'],
): RpcBridge {
  const listeners = new Set<(record: JsonValue) => void | Promise<void>>();
  const written: Array<Readonly<Record<string, unknown>>> = [];
  let delivery = Promise.resolve();
  let disposed = false;
  let resolveExit!: (
    result: Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>,
  ) => void;
  const exit = new Promise<
    Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>
  >((resolve) => {
    resolveExit = resolve;
  });
  const publish = (record: unknown): Promise<void> => {
    const serialized = cloneJson(record) as JsonValue;
    delivery = delivery.then(async () => {
      for (const listener of [...listeners]) {
        await listener(serialized);
      }
    });
    return delivery;
  };
  const unsubscribe = session.subscribe((event) => {
    void publish(event);
  });

  const client = {
    subscribe(listener: (record: JsonValue) => void | Promise<void>) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    async write(value: JsonValue) {
      const command = cloneJson(value);
      const record = asRecord(command);
      if (!record || typeof record.type !== 'string' || typeof record.id !== 'string') {
        throw new Error('invalid_pi_rpc_command');
      }
      written.push(record);
      const success = async (data?: unknown) => await publish({
        type: 'response',
        id: record.id,
        command: record.type,
        success: true,
        ...(data === undefined ? {} : { data }),
      });
      switch (record.type) {
        case 'get_state':
          await success({ sessionId: session.sessionId });
          return;
        case 'prompt': {
          let preflightSucceeded = false;
          void session.prompt(String(record.message ?? ''), {
            streamingBehavior: record.streamingBehavior === 'followUp'
              ? 'followUp'
              : undefined,
            source: 'rpc',
            preflightResult: (didSucceed: boolean) => {
              if (!didSucceed || preflightSucceeded) return;
              preflightSucceeded = true;
              void success();
            },
          }).catch(async (error: unknown) => {
            if (preflightSucceeded) return;
            await publish({
              type: 'response',
              id: record.id,
              command: record.type,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        case 'abort':
          await session.abort();
          await success();
          return;
        default:
          await publish({
            type: 'response',
            id: record.id,
            command: record.type,
            success: false,
            error: `unsupported_real_owner_test_command:${record.type}`,
          });
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };

  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client,
    process: {
      pid: 41_446,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => exit,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
    wait: () => exit,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
      resolveExit({
        termination: {
          observed: { kind: 'exit', exitCode: 0 },
          requestedBy: { kind: 'dispose' },
        },
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  };
  return { handle, written };
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({
    type: 'error',
    error: { type, message },
  }), {
    status,
    headers: {
      'content-type': 'application/json',
      'request-id': `request-${status}-${type}`,
    },
  });
}

function anthropicSuccess(modelId: string, text = 'ok'): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'message-success',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    events.flatMap((event) => [
      `event: ${String(event.type)}`,
      `data: ${JSON.stringify(event)}`,
      '',
    ]).concat('').join('\n'),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function anthropicSse(
  events: readonly Readonly<Record<string, unknown>>[],
): Response {
  return new Response(
    events.flatMap((event) => [
      `event: ${String(event.type)}`,
      `data: ${JSON.stringify(event)}`,
      '',
    ]).concat('').join('\n'),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function anthropicLateCapacity(modelId: string): Response {
  return anthropicSse([
    {
      type: 'message_start',
      message: {
        id: 'message-late-error',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial output' },
    },
    {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    },
  ]);
}

function anthropicToolCallThenCapacity(modelId: string): Response {
  return anthropicSse([
    {
      type: 'message_start',
      message: {
        id: 'message-tool-before-error',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tool-before-error',
        name: 'write_file',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"path":"must-not-replay.txt"}',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'Overloaded after tool call',
      },
    },
  ]);
}

function codexSuccess(text = 'ok'): Response {
  const item = {
    id: 'message-codex-success',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const events = [
    {
      type: 'response.created',
      response: { id: 'response-codex-success', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item,
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    },
    {
      type: 'response.completed',
      response: {
        id: 'response-codex-success',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function tokenFor(
  providerId: ProviderId,
  accountId: string,
  credentialRevision: string,
): string {
  if (providerId === 'anthropic') {
    return `sk-ant-oat-${accountId}-${credentialRevision}`;
  }
  const encoded = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      credential_revision: credentialRevision,
    },
  }), 'utf8').toString('base64url');
  return `header.${encoded}.signature`;
}

function selectedHeaders(request: Request): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...request.headers.entries()].filter(([name]) => (
      name === 'authorization'
      || name === 'x-api-key'
      || name === 'chatgpt-account-id'
    )),
  );
}

function terminalEvent(
  events: readonly AgentSessionRuntimeEvent[],
): AgentSessionRuntimeEvent | undefined {
  return [...events].reverse().find((event) => (
    event.kind === 'turn-complete'
    || event.kind === 'turn-failed'
    || event.kind === 'turn-cancelled'
  ));
}

async function waitForScenarioTerminal(
  events: readonly AgentSessionRuntimeEvent[],
  state: RealOwnerState,
  expected: Readonly<{
    attempts: number;
    terminalKind: 'turn-complete' | 'turn-failed' | 'turn-cancelled';
    exactTerminalDiagnostic?: string;
  }>,
): Promise<AgentSessionRuntimeEvent> {
  try {
    await vi.waitFor(() => {
      expect(state.upstreamAttempts).toHaveLength(expected.attempts);
      expect(state.lookupAccounts).toHaveLength(expected.attempts);
      expect(state.controlRouteLookupStatuses).toHaveLength(expected.attempts);
      const terminal = terminalEvent(events);
      expect(terminal?.kind).toBe(expected.terminalKind);
      if (expected.exactTerminalDiagnostic) {
        expect(terminal).toMatchObject({
          diagnostic: {
            message: expected.exactTerminalDiagnostic,
          },
        });
      }
    }, { timeout: 10_000, interval: 5 });
  } catch (error) {
    throw new Error(
      `Pi real-owner scenario did not reach its expected terminal state: ${JSON.stringify({
        upstreamAttempts: state.upstreamAttempts.length,
        lookupAccounts: state.lookupAccounts.length,
        lookupStatuses: state.controlRouteLookupStatuses,
        events,
      })}`,
      { cause: error },
    );
  }
  const event = terminalEvent(events);
  if (!event) throw new Error('missing_terminal_runtime_event');
  return event;
}

function expectedReportFailure(
  version: PiVersion,
  scenario: Scenario,
  reportIndex = 0,
): ExpectedReportFailure | null {
  if (
    reportIndex === 1
    && (
      scenario.id === 'codex-structured-auth'
      || scenario.id === 'codex-usage-limit-switch'
    )
  ) {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 400,
        limitCategory: 'validation_failed',
        quotaScope: 'unknown',
        evidenceSource: { kind: 'structured' },
      },
    };
  }
  if (scenario.id === 'codex-structured-auth') {
    return {
      class: 'authentication',
      evidence: {
        httpStatus: 401,
        limitCategory: 'auth_invalid',
        quotaScope: 'unknown',
        evidenceSource: { kind: 'structured' },
      },
    };
  }
  if (scenario.id === 'codex-structured-validation') {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 400,
        limitCategory: 'validation_failed',
        quotaScope: 'unknown',
        evidenceSource: { kind: 'structured' },
      },
    };
  }
  if (scenario.id === 'codex-structured-plan') {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 402,
        limitCategory: 'plan_invalid',
        quotaScope: 'unknown',
        evidenceSource: { kind: 'structured' },
      },
    };
  }
  if (scenario.id === 'codex-structured-transient') {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 503,
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: { kind: 'structured' },
      },
    };
  }
  if (
    scenario.id.includes('usage-limit')
    || scenario.id.includes('account-exhaustion')
    || scenario.id === 'ambiguous-report-settlement-next-independent'
  ) {
    const provider = scenario.providerId;
    return {
      class: 'quota',
      evidence: {
        httpStatus: 429,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: version,
          provider,
          signatureId: provider === 'anthropic'
            ? PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
              .anthropicAccountExhaustion
            : PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
              .openAiCodexChatgptUsageLimit,
        },
      },
    };
  }
  if (scenario.id.includes('auth-')) {
    return {
      class: 'authentication',
      evidence: {
        httpStatus: 401,
        limitCategory: 'auth_invalid',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: version,
          provider: 'anthropic',
          signatureId:
            PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
              .anthropicAuthentication,
        },
      },
    };
  }
  if (
    scenario.id.includes('capacity')
    || scenario.id.includes('backoff')
    || scenario.id === 'retry-final-different'
  ) {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 529,
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: version,
          provider: 'anthropic',
          signatureId:
            PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
              .anthropicOverloaded,
        },
      },
    };
  }
  if (scenario.id.includes('transient')) {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 503,
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: version,
          provider: 'anthropic',
          signatureId:
            PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
              .anthropicApiError503,
        },
      },
    };
  }
  if (scenario.id.includes('rate')) {
    return {
      class: 'quota',
      evidence: {
        httpStatus: 429,
        limitCategory: 'rate_limit',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: version,
          provider: 'anthropic',
          signatureId:
            PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
              .anthropicRateLimit,
        },
      },
    };
  }
  return null;
}

async function runRealOwnerScenario(
  version: PiVersion,
  scenario: Scenario,
): Promise<void> {
  const modules = await loadExactPiModules(version);
  const root = await mkdtemp(join(TEST_DIRECTORY, '.real-owners-'));
  temporaryRoots.add(root);
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { recursive: true });
  const service = serviceFor(scenario.providerId);
  const purpose = PI_REQUEST_AUTH_DECLARED_PURPOSES[scenario.providerId];
  const state: RealOwnerState = {
    currentAccountId: 'primary',
    currentGroup: makeGroup(service, {
      activeConnectedAccountId: 'primary',
      generation: 7,
      runtimeStateRevision: 3,
    }),
    accountRevisions: {
      primary: PRIMARY_REVISION,
      backup: BACKUP_REVISION,
    },
    controlRouteLookups: 0,
    controlRouteLookupStatuses: [],
    controlRouteReports: 0,
    upstreamAttempts: [],
    lookupAccounts: [],
    materializedAccounts: [],
    reportBodies: [],
    applyGenerationInputs: [],
  };

  const refreshApi = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(async () => null),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
  };
  const refreshCoordinator = new ConnectedServiceRefreshCoordinator({
    api: refreshApi as never,
    credentials: CREDENTIALS,
    machineIdProvider: () => 'machine-real-owner',
    activeServerDir: join(root, 'active'),
    baseDir: join(root, 'materialized'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: () => 1_000,
  });
  const refreshSpy = vi.spyOn(
    refreshCoordinator,
    'refreshConnectedServiceCredentialForQuota',
  );

  const quotaCoordinator = new ConnectedServiceQuotasCoordinator({
    api: {} as never,
    credentials: CREDENTIALS,
    quotaFetchers: [],
    now: () => 1_000,
    randomBytes: (length) => new Uint8Array(length).fill(3),
    discoveryEnabled: false,
  });
  const quotaBackoffSpy = vi.spyOn(
    quotaCoordinator,
    'recordRequestAuthProviderBackoff',
  );

  const groupApi = {
    readGroup: vi.fn(async () => state.currentGroup),
    listAccounts: vi.fn(async () => accountList(service, state.accountRevisions)),
    updateRuntimeState: vi.fn(async (input: Readonly<{
      patch: Readonly<{
        expectedRuntimeStateRevision: number;
        runtimeState: Readonly<{
          memberStates: ReadonlyArray<Readonly<{
            connectedAccountId: string;
            state: Readonly<Record<string, unknown>>;
          }>>;
        }>;
      }>;
    }>) => {
      state.currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
        ...state.currentGroup,
        runtimeStateRevision: input.patch.expectedRuntimeStateRevision + 1,
        members: state.currentGroup.members.map((member) => {
          const replacement = input.patch.runtimeState.memberStates.find(
            (candidate) => candidate.connectedAccountId === member.connectedAccountId,
          );
          return replacement
            ? { ...member, state: replacement.state }
            : member;
        }),
      });
      return state.currentGroup;
    }),
    setActiveAccount: vi.fn(async (input: Readonly<{
      mutation: Readonly<{
        connectedAccountId: 'primary' | 'backup';
        expectedGeneration: number;
      }>;
    }>) => {
      state.currentAccountId = input.mutation.connectedAccountId;
      state.currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
        ...state.currentGroup,
        activeConnectedAccountId: input.mutation.connectedAccountId,
        generation: input.mutation.expectedGeneration + 1,
        runtimeStateRevision: state.currentGroup.runtimeStateRevision + 1,
      });
      return state.currentGroup;
    }),
  };
  const groupSwitchCoordinator =
    createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
      token: CREDENTIALS.token,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      api: groupApi,
      applyGeneration: async (input) => {
        state.applyGenerationInputs.push(
          input as unknown as Readonly<Record<string, unknown>>,
        );
        return {
          ok: true,
          mode: 'spawn_next_turn',
        };
      },
    });
  const groupSwitchSpy = vi.spyOn(
    groupSwitchCoordinator,
    'switchAfterClassifiedFailure',
  );

  const continuationSendBoundary = vi.fn(async (
    input: Readonly<{ localId?: string }>,
  ) => ({
    ok: true as const,
    sessionId: 'session-real-owner',
    localId: input.localId ?? 'unexpected',
    waited: false,
  }));
  const continuationDispatcher =
    createConnectedServiceContinuationMessageDispatcher({
      credentials: CREDENTIALS,
      sendMessage: continuationSendBoundary as never,
    });
  const recoverBoundary = vi.fn(async (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: Parameters<
      typeof handleConnectedServiceRuntimeAuthFailureForSession
    >[0]['classification'];
  }>) => (
    await handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [],
      switchCoordinator: groupSwitchCoordinator as never,
      temporaryThrottleRecovery: null,
      continueAfterRuntimeAuthSwitch: async (continuation) => {
        await continuationDispatcher.enqueueInterruptedOriginContinuation({
          sessionId: continuation.sessionId,
          attemptId: 'scheduler-recovery',
          interruptedOriginId: 'scheduler-origin',
          interruption: 'provider_failed_turn',
          resumePromptMode: 'standard',
        });
      },
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      recoveryInvocationSource: 'scheduler_retry',
      classification: input.classification,
    })
  ));
  const recoveryScheduler =
    createRuntimeAuthRecoverySchedulerForDaemon({
      activeServerDir: join(root, 'active'),
      nowMs: () => 1_000,
      recover: recoverBoundary as never,
    });
  const genericRuntimeAdapterInputs: unknown[] = [];
  const runtimeAuthDispatcher = createConnectedServiceRuntimeAuthDispatcher({
    resolveAdapter: () => createPiConnectedServiceRuntimeAuthAdapter(),
  });

  const requestAuthBinding = {
    purpose,
    target: {
      kind: 'group' as const,
      service,
      groupId: 'fallbacks',
    },
  };
  const resolveCurrentBinding =
    (): ConnectedAccountRequestAuthResolvedBinding => ({
      account: {
        service,
        accountId: state.currentAccountId,
      },
      group: {
        groupId: 'fallbacks',
        generation: state.currentGroup.generation,
      },
      credentialRevision: state.accountRevisions[state.currentAccountId],
    });
  const requestAuthUse = {
    purpose,
    materialization:
      PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS[scenario.providerId],
  };
  const subject: ConnectedAccountRequestAuthSubject = {
    subjectId: `pi-real-owner:${version}:${scenario.id}`,
    isCurrent: () => true,
    registerRedaction: () => undefined,
    resolvePurposeUse: (candidate) => (
      JSON.stringify(candidate) === JSON.stringify(purpose)
        ? { binding: requestAuthBinding, use: requestAuthUse }
        : null
    ),
    listPurposeUses: () => [{
      binding: requestAuthBinding,
      use: requestAuthUse,
    }],
  };

  const applyRecovery = async (
    resolved: ConnectedAccountRequestAuthResolvedBinding,
    failure: Parameters<
      typeof applyConnectedAccountRequestAuthRecovery
    >[0]['failure'],
  ) => {
    const before = JSON.stringify([
      resolved.account.accountId,
      resolved.credentialRevision,
      resolved.group?.generation,
    ]);
    const recovery = await applyConnectedAccountRequestAuthRecovery({
      resolved,
      failure,
      refreshCredential: async (input) => Boolean(
        await refreshCoordinator.refreshConnectedServiceCredentialForQuota({
          serviceId: firstPartyServiceId(scenario.providerId),
          profileId: input.account.accountId,
          force: true,
          expectedCredentialRevision: input.expectedCredentialRevision,
        }),
      ),
      switchAfterClassifiedFailure: async (input) => (
        await groupSwitchCoordinator.switchAfterClassifiedFailure(input)
      ),
      recordTemporaryRetry: async (input) => {
        quotaCoordinator.recordRequestAuthProviderBackoff({
          serviceId: firstPartyServiceId(scenario.providerId),
          profileId: input.accountId,
          groupId: input.groupId,
          groupGeneration: input.groupGeneration,
          limitCategory: input.limitCategory,
          quotaScope: input.quotaScope,
          retryAfterMs: input.retryAfterMs,
          resetAtMs: input.resetAtMs,
          providerCode: input.providerCode,
        });
        return { status: 'recorded' as const };
      },
    });
    if (recovery.effect === 'stale_context') {
      return { status: 'stale_context' as const };
    }
    if (recovery.effect === 'temporary_retry_unavailable') {
      return { status: 'denied' as const };
    }
    const current = resolveCurrentBinding();
    const after = JSON.stringify([
      current.account.accountId,
      current.credentialRevision,
      current.group?.generation,
    ]);
    return {
      status: before === after
        ? 'current_unchanged' as const
        : 'current_changed' as const,
    };
  };

  const requestAuthService = createConnectedAccountRequestAuthService({
    resolveCurrentBinding,
    materializeBearer: async ({ resolved }) => {
      state.materializedAccounts.push(
        resolved.account.accountId as 'primary' | 'backup',
      );
      return {
        accessToken: tokenFor(
          scenario.providerId,
          resolved.account.accountId,
          resolved.credentialRevision,
        ),
        ...(scenario.providerId === 'openai-codex'
          ? {
            requiredHeaders: {
              'ChatGPT-Account-ID': resolved.account.accountId,
            },
          }
          : {}),
      };
    },
    refreshAfterAuthFailure: async ({ resolved, failure }) => (
      await applyRecovery(resolved, failure)
    ),
    reportQuotaFailure: async ({ resolved, failure }) => (
      await applyRecovery(resolved, failure)
    ),
  });
  const registry = createConnectedAccountRequestAuthSubjectRegistry();

  const app = createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine-real-owner',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'unused',
    }),
    requestShutdown: () => undefined,
    onHappySessionWebhook: () => undefined,
    controlToken: 'master-token',
    connectedAccountRequestAuth: {
      authenticate: registry.authenticate,
      lookupRequestAuth: async (input) => {
        const lease = await requestAuthService.lookupRequestAuth(input);
        state.lookupAccounts.push(
          lease.credentialContext.account.accountId as 'primary' | 'backup',
        );
        return lease;
      },
      refreshAfterAuthFailure: async (input) => {
        state.controlRouteReports += 1;
        state.reportBodies.push(
          input.request as unknown as Readonly<Record<string, unknown>>,
        );
        return await requestAuthService.refreshAfterAuthFailure(input);
      },
      reportQuotaFailure: async (input) => {
        state.controlRouteReports += 1;
        state.reportBodies.push(
          input.request as unknown as Readonly<Record<string, unknown>>,
        );
        return await requestAuthService.reportQuotaFailure(input);
      },
    },
    runtimeAuthRecoveryScheduler:
      recoveryScheduler,
    handleConnectedServiceRuntimeAuthFailure: async (input) => {
      genericRuntimeAdapterInputs.push(input);
      return await handleConnectedServiceRuntimeAuthFailureForSession({
        getChildren: () => [],
        switchCoordinator: groupSwitchCoordinator as never,
        temporaryThrottleRecovery: null,
        continueAfterRuntimeAuthSwitch: async (continuation) => {
          await continuationDispatcher.enqueueInterruptedOriginContinuation({
            sessionId: continuation.sessionId,
            attemptId: 'generic-runtime-adapter',
            interruptedOriginId: 'generic-runtime-origin',
            interruption: 'provider_failed_turn',
            resumePromptMode: 'standard',
          });
        },
        sessionId: input.sessionId,
        switchesThisTurn: input.switchesThisTurn,
        classification: input.classification,
      });
    },
  });
  app.addHook('onRequest', async (request) => {
    if (request.url === CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH) {
      state.controlRouteLookups += 1;
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url === CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH) {
      state.controlRouteLookupStatuses.push(reply.statusCode);
    }
  });
  const address = await app.listen({
    host: '127.0.0.1',
    port: 0,
  });
  const capability = await registry.activate({
    subject,
    materializedRootDir: root,
    materializationId: `pi-${version.replaceAll('.', '-')}-${scenario.id}`,
    httpPort: Number(new URL(address).port),
  });

  const extensionPath = resolvePiRequestAuthExtensionPath(agentDir);
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  const generated = buildPiRequestAuthExtensionAssetSource({
    [scenario.providerId]: purpose,
  })
    .replaceAll(
      '@earendil-works/pi-ai/providers/all',
      `${modules.providerAlias}/providers/all`,
    )
    .replaceAll('@earendil-works/pi-ai', modules.providerAlias);
  await writeFile(extensionPath, generated, 'utf8');
  const previousRequestAuthEnv = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    capabilityPath:
      process.env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV],
    producerVersion:
      process.env.HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV] = capability.path;
  process.env.HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION = version;

  const settings = modules.coding.SettingsManager.inMemory({
    retry: {
      enabled: scenario.retryEnabled,
      maxRetries: 1,
      baseDelayMs: scenario.cancelOnBackoff ? 10_000 : 0,
      provider: { maxRetries: 0 },
    },
  }, { projectTrusted: true });
  const settingsBefore = JSON.stringify(settings.getGlobalSettings());
  const resourceLoader = new modules.coding.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  const originalFetch = globalThis.fetch;
  let agentSession:
    Awaited<ReturnType<typeof modules.coding.createAgentSession>>['session']
    | null = null;
  let runtime: AgentSessionRuntime | null = null;
  let rawSessionSubscription: (() => void) | null = null;
  let corruptReportResponse = Boolean(
    scenario.corruptFirstReportResponseAfterEffect,
  );
  try {
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    expect(
      resourceLoader.getExtensions().runtime
        .pendingNativeProviderRegistrations
        .map((registration) => registration.provider.id),
    ).toContain(scenario.providerId);
    const provider = modules.providers.builtinProviders().find(
      (candidate) => candidate.id === scenario.providerId,
    );
    const model = provider?.getModels()[0];
    if (!model) throw new Error(`missing_exact_model:${version}:${scenario.providerId}`);

    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
        ? input
        : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === '127.0.0.1' || url.hostname === '::1') {
        const response = await originalFetch(input, init);
        const isReport = (
          url.pathname === CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH
          || url.pathname === CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH
        );
        if (corruptReportResponse && isReport) {
          corruptReportResponse = false;
          return new Response('{malformed-after-real-owner-effect', {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return response;
      }
      const expectedProviderHost = scenario.providerId === 'anthropic'
        ? 'api.anthropic.com'
        : 'chatgpt.com';
      if (url.hostname !== expectedProviderHost) {
        throw new Error(`unexpected_non_provider_fetch:${request.url}`);
      }
      const attemptIndex = state.upstreamAttempts.length;
      state.upstreamAttempts.push({
        accountId: state.currentAccountId,
        url: request.url,
        headers: selectedHeaders(request),
      });
      const responseFactory = scenario.responses[
        Math.min(attemptIndex, scenario.responses.length - 1)
      ];
      if (!responseFactory) throw new Error('missing_provider_response');
      const response = await responseFactory(model);
      if (
        scenario.staleCredentialBeforeFirstReport
        && attemptIndex === 0
      ) {
        state.accountRevisions.primary = STALE_PRIMARY_REVISION;
      }
      return response;
    };

    const created = await modules.coding.createAgentSession({
      cwd: root,
      agentDir,
      model,
      thinkingLevel: 'off',
      tools: [],
      resourceLoader,
      sessionManager: modules.coding.SessionManager.inMemory(root),
      settingsManager: settings,
    });
    agentSession = created.session;
    expect(created.extensionsResult.diagnostics ?? []).toEqual([]);
    let resolveRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      resolveRetryStarted = resolve;
    });
    let agentSessionRetries = 0;
    const rawAgentSessionEvents: unknown[] = [];
    rawSessionSubscription = agentSession.subscribe((event) => {
      rawAgentSessionEvents.push(cloneJson(event));
      if (event.type === 'auto_retry_start') {
        agentSessionRetries += 1;
        resolveRetryStarted();
      }
    });

    const bridge = createSerializedAgentSessionRpcBridge(agentSession);
    let spawnedSpec:
      Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>
      | null = null;
    const executable: ManagedExecutableRef = {
      kind: 'systemTool',
      id: 'pi-cli',
    };
    runtime = await createPiRuntimeOperations({
      services: {
        exec: {
          systemTools: {
            resolve: async () => ({
              executable,
              executablePath: `/exact/pi/${version}`,
            }),
          },
          run: async () => ({
            termination: {
              observed: { kind: 'exit', exitCode: 0 },
              requestedBy: { kind: 'none' },
            },
            stdout: new TextEncoder().encode(version),
            stderr: new Uint8Array(),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
          clients: {
            spawn: async (spec) => {
              spawnedSpec = spec;
              return bridge.handle;
            },
          },
        } as never,
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      cwd: root,
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capability.path,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          serviceId: firstPartyServiceId(scenario.providerId),
        }]),
      },
      sessionId: 'happier-session-real-owner',
      initialSessionId: agentSession.sessionId,
    });
    const events: AgentSessionRuntimeEvent[] = [];
    const watch = runtime.watch((event) => {
      events.push(event);
    });

    const admission = await runtime.send({
      inputIds: [`input-${scenario.id}`],
      input: { text: 'first request' },
      delivery: {
        kind: 'newTurn',
        turnId: `turn-${scenario.id}`,
      },
    });
    expect(admission).toEqual({ status: 'admitted' });
    if (scenario.cancelOnBackoff) {
      await Promise.race([
        retryStarted,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('missing_real_agent_session_retry_backoff'));
          }, 10_000);
          timer.unref?.();
        }),
      ]);
      await expect(runtime.cancel({
        turnId: `turn-${scenario.id}`,
        reason: 'user',
      })).resolves.toMatchObject({ status: 'requested' });
    }
    const firstExpected = scenario.expected.firstPrompt ?? {
      attempts: scenario.expected.attempts,
      terminalKind: scenario.expected.terminalKind,
      exactTerminalDiagnostic: scenario.expected.exactTerminalDiagnostic,
    };
    const firstTerminal = await waitForScenarioTerminal(
      events,
      state,
      firstExpected,
    );
    if (scenario.independentSecondPrompt) {
      const secondAdmission = await runtime.send({
        inputIds: [`input-${scenario.id}-independent`],
        input: { text: 'independent second request' },
        delivery: {
          kind: 'newTurn',
          turnId: `turn-${scenario.id}-independent`,
        },
      });
      expect(secondAdmission).toEqual({ status: 'admitted' });
    }
    const terminal = scenario.independentSecondPrompt
      ? await waitForScenarioTerminal(events, state, scenario.expected)
      : firstTerminal;
    watch.dispose();

    expect(spawnedSpec).toMatchObject({
      kind: 'jsonStream',
      launch: {
        env: {
          HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION: version,
        },
      },
    });
    expect(
      bridge.written.filter((record) => record.type === 'prompt'),
    ).toHaveLength(scenario.independentSecondPrompt ? 2 : 1);
    expect(JSON.stringify(bridge.written)).not.toContain('"scope":"session"');
    expect(
      state.controlRouteLookups,
      JSON.stringify(events),
    ).toBe(scenario.expected.lookups);
    expect(state.controlRouteLookupStatuses).toEqual(
      Array.from({ length: scenario.expected.lookups }, () => 200),
    );
    expect(state.controlRouteReports).toBe(scenario.expected.reports);
    const reportFailures = Array.from(
      { length: scenario.expected.reports },
      (_, index) => expectedReportFailure(version, scenario, index),
    );
    if (reportFailures.some((failure) => failure === null)) {
      throw new Error(`missing_expected_report_failure:${scenario.id}`);
    }
    expect(state.reportBodies).toHaveLength(scenario.expected.reports);
    for (const [index, body] of state.reportBodies.entries()) {
      const failure = reportFailures[index];
      if (!failure) throw new Error('missing_expected_report_failure');
      const parsed = failure.class === 'authentication'
        ? ConnectedAccountAuthFailureRequestV1Schema.parse(body)
        : ConnectedAccountQuotaFailureRequestV1Schema.parse(body);
      const accountId = state.upstreamAttempts[index]?.accountId;
      expect(parsed.credentialContext).toMatchObject({
        account: {
          service,
          accountId,
        },
        group: {
          groupId: 'fallbacks',
          generation: 7 + index,
        },
        credentialRevision: accountId === 'backup'
          ? BACKUP_REVISION
          : PRIMARY_REVISION,
      });
      expect(parsed.normalizedFailure).toEqual(failure);
    }
    const serializedReports = JSON.stringify(state.reportBodies);
    expect(serializedReports).not.toContain(
      'happierRequestAuthProviderDiagnostic',
    );
    expect(serializedReports).not.toContain('errorMessage');
    for (const providerDiagnostic of [
      scenario.expected.exactTerminalDiagnostic,
      scenario.expected.firstPrompt?.exactTerminalDiagnostic,
      scenario.expected.absentDiagnostic,
    ]) {
      if (providerDiagnostic) {
        expect(serializedReports).not.toContain(providerDiagnostic);
      }
    }
    expect(state.lookupAccounts).toEqual(scenario.expected.accountIds);
    expect(state.materializedAccounts).toEqual(
      scenario.expected.materializedAccountIds
        ?? [...new Set(scenario.expected.accountIds)],
    );
    expect(
      state.upstreamAttempts.map((attempt) => attempt.accountId),
    ).toEqual(scenario.expected.accountIds);
    expect(state.upstreamAttempts).toHaveLength(scenario.expected.attempts);
    expect(state.upstreamAttempts.every(({ url }) => (
      new URL(url).hostname === (
        scenario.providerId === 'anthropic'
          ? 'api.anthropic.com'
          : 'chatgpt.com'
      )
    ))).toBe(true);
    expect(requestAuthUse.materialization.headerNames).toEqual(
      scenario.providerId === 'anthropic'
        ? ['authorization']
        : ['authorization', 'chatgpt-account-id'],
    );
    expect(groupSwitchSpy).toHaveBeenCalledTimes(
      scenario.expected.switchCalls ?? scenario.expected.switchEffects,
    );
    expect(refreshApi.getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(
      scenario.expected.refreshReads,
    );
    expect(refreshSpy).toHaveBeenCalledTimes(scenario.expected.refreshReads);
    if (scenario.expected.refreshReads > 0) {
      expect(refreshSpy).toHaveBeenCalledWith(expect.objectContaining({
        serviceId: firstPartyServiceId(scenario.providerId),
        profileId: 'primary',
        force: true,
        expectedCredentialRevision: PRIMARY_REVISION,
      }));
    }
    expect(quotaBackoffSpy).toHaveBeenCalledTimes(
      scenario.expected.quotaBackoffs,
    );
    expect(agentSessionRetries).toBe(scenario.expected.agentSessionRetries);
    expect(terminal.kind).toBe(scenario.expected.terminalKind);

    for (const attempt of state.upstreamAttempts) {
      const attemptIndex = state.upstreamAttempts.indexOf(attempt);
      const credentialRevision = scenario.staleCredentialBeforeFirstReport
        && attemptIndex > 0
        ? STALE_PRIMARY_REVISION
        : attempt.accountId === 'backup'
          ? BACKUP_REVISION
          : PRIMARY_REVISION;
      const token = tokenFor(
        scenario.providerId,
        attempt.accountId,
        credentialRevision,
      );
      if (scenario.providerId === 'anthropic') {
        expect(attempt.headers.authorization).toBe(`Bearer ${token}`);
        expect(attempt.headers).not.toHaveProperty('x-api-key');
      } else {
        expect(attempt.headers.authorization).toBe(`Bearer ${token}`);
        expect(attempt.headers['chatgpt-account-id']).toBe(attempt.accountId);
      }
    }

    const serializedEvents = JSON.stringify(events);
    if (scenario.expected.visibleText) {
      expect(serializedEvents).toContain(scenario.expected.visibleText);
    }
    if (scenario.expected.rawAgentSessionText) {
      expect(JSON.stringify(rawAgentSessionEvents)).toContain(
        scenario.expected.rawAgentSessionText,
      );
    }
    if (scenario.expected.absentDiagnostic) {
      expect(serializedEvents).not.toContain(
        scenario.expected.absentDiagnostic,
      );
    }
    if (scenario.expected.exactTerminalDiagnostic) {
      expect(terminal).toMatchObject({
        diagnostic: {
          message: scenario.expected.exactTerminalDiagnostic,
        },
      });
    }
    if (scenario.expected.firstPrompt?.exactTerminalDiagnostic) {
      expect(firstTerminal).toMatchObject({
        diagnostic: {
          message: scenario.expected.firstPrompt.exactTerminalDiagnostic,
        },
      });
    }

    const lastAssistantMessage = [...agentSession.messages].reverse().find(
      (message) => (
        message !== null
        && typeof message === 'object'
        && 'role' in message
        && message.role === 'assistant'
      ),
    );
    expect(runtimeAuthDispatcher.classifyRuntimeAuthFailure({
      target: { agentId: 'pi' },
      error: lastAssistantMessage,
      selection: {
        serviceId: scenario.providerId === 'anthropic'
          ? 'claude-subscription'
          : 'openai-codex',
        activeProfileId: state.currentAccountId,
        groupId: 'fallbacks',
      },
    })).toBeNull();
    expect(
      recoveryScheduler.readForSession(
        'happier-session-real-owner',
      ),
    ).toEqual([]);
    expect(recoverBoundary).not.toHaveBeenCalled();
    expect(genericRuntimeAdapterInputs).toEqual([]);
    expect(continuationSendBoundary).not.toHaveBeenCalled();
    expect(JSON.stringify(settings.getGlobalSettings())).toBe(settingsBefore);
    expect(state.applyGenerationInputs).toHaveLength(
      scenario.expected.switchEffects,
    );
  } finally {
    recoveryScheduler.dispose();
    rawSessionSubscription?.();
    await runtime?.dispose();
    await agentSession?.dispose();
    await registry.retire(capability);
    await app.close();
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['PI_CODING_AGENT_DIR', previousRequestAuthEnv.agentDir],
      [
        PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
        previousRequestAuthEnv.capabilityPath,
      ],
      [
        'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION',
        previousRequestAuthEnv.producerVersion,
      ],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function recoveredScenarios(): readonly Scenario[] {
  return [
    {
      id: 'usage-limit-switch',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(429, 'insufficient_quota', 'quota exceeded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'quota exceeded',
      },
    },
    {
      id: 'auth-refresh-then-switch',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(401, 'authentication_error', 'invalid x-api-key'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 1,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'invalid x-api-key',
      },
    },
    {
      id: 'provider-capacity-agent-retry',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 1,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'Overloaded',
      },
    },
    {
      id: 'provider-rate-agent-retry',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(429, 'rate_limit_error', 'rate limit exceeded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 1,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'rate limit exceeded',
      },
    },
    {
      id: 'provider-transient-agent-retry',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(503, 'api_error', 'service unavailable'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 1,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'service unavailable',
      },
    },
    {
      id: 'disabled-provider-rate-next-independent',
      providerId: 'anthropic',
      retryEnabled: false,
      independentSecondPrompt: true,
      responses: [
        () => jsonError(
          429,
          'rate_limit_error',
          'rate limit exceeded',
        ),
        (model) => anthropicSuccess(model.id, 'independent rate success'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'independent rate success',
        firstPrompt: {
          attempts: 1,
          terminalKind: 'turn-failed',
          exactTerminalDiagnostic:
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
        },
      },
    },
    {
      id: 'disabled-provider-capacity',
      providerId: 'anthropic',
      retryEnabled: false,
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      },
    },
    {
      id: 'disabled-provider-transient',
      providerId: 'anthropic',
      retryEnabled: false,
      responses: [
        () => jsonError(503, 'api_error', 'service unavailable'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic:
          '503 {"type":"error","error":{"type":"api_error","message":"service unavailable"}}',
      },
    },
    {
      id: 'uncertain-http-408-non-rejection',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(
          408,
          'request_timeout',
          'request outcome uncertain',
        ),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic:
          '408 {"type":"error","error":{"type":"request_timeout","message":"request outcome uncertain"}}',
      },
    },
    {
      id: 'output-bearing-late-capacity',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        (model) => anthropicLateCapacity(model.id),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'Overloaded',
        visibleText: 'partial output',
      },
    },
    {
      id: 'tool-call-bearing-late-capacity',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        (model) => anthropicToolCallThenCapacity(model.id),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'Overloaded after tool call',
        rawAgentSessionText: 'must-not-replay.txt',
      },
    },
    {
      id: 'ambiguous-report-settlement-next-independent',
      providerId: 'anthropic',
      retryEnabled: false,
      corruptFirstReportResponseAfterEffect: true,
      independentSecondPrompt: true,
      responses: [
        () => jsonError(429, 'insufficient_quota', 'quota exceeded'),
        (model) => anthropicSuccess(model.id, 'independent success'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'independent success',
        firstPrompt: {
          attempts: 1,
          terminalKind: 'turn-failed',
          exactTerminalDiagnostic:
            '429 {"type":"error","error":{"type":"insufficient_quota","message":"quota exceeded"}}',
        },
      },
    },
    {
      id: 'disabled-auth-leaf-replay',
      providerId: 'anthropic',
      retryEnabled: false,
      responses: [
        () => jsonError(401, 'authentication_error', 'invalid x-api-key'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 1,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'invalid x-api-key',
      },
    },
    {
      id: 'disabled-account-exhaustion-leaf-replay',
      providerId: 'anthropic',
      retryEnabled: false,
      responses: [
        () => jsonError(429, 'insufficient_quota', 'quota exceeded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'ok',
        absentDiagnostic: 'quota exceeded',
      },
    },
    {
      id: 'account-exhaustion-leaf-exhausted',
      providerId: 'anthropic',
      retryEnabled: false,
      responses: [
        () => jsonError(429, 'insufficient_quota', 'quota exceeded'),
        () => jsonError(429, 'insufficient_quota', 'quota exceeded'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        accountIds: ['primary', 'backup'],
        switchCalls: 2,
        switchEffects: 2,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic:
          '429 {"type":"error","error":{"type":"insufficient_quota","message":"quota exceeded"}}',
      },
    },
    {
      id: 'stale-account-exhaustion-reacquires',
      providerId: 'anthropic',
      retryEnabled: false,
      staleCredentialBeforeFirstReport: true,
      responses: [
        () => jsonError(429, 'insufficient_quota', 'quota exceeded'),
        (model) => anthropicSuccess(model.id, 'fresh revision success'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'primary'],
        materializedAccountIds: ['primary', 'primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: 'fresh revision success',
        absentDiagnostic: 'quota exceeded',
      },
    },
    {
      id: 'codex-usage-limit-switch',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(429, 'usage_limit_reached', 'usage limit reached'),
        () => jsonError(
          400,
          'invalid_request_error',
          'final validation failure',
        ),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'final validation failure',
        absentDiagnostic: 'usage limit reached',
      },
    },
    {
      id: 'codex-structured-auth',
      providerId: 'openai-codex',
      retryEnabled: false,
      responses: [
        () => jsonError(401, 'invalid_api_key', 'invalid bearer token'),
        () => jsonError(
          400,
          'invalid_request_error',
          'final validation failure',
        ),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        accountIds: ['primary', 'backup'],
        switchEffects: 1,
        refreshReads: 1,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'final validation failure',
        absentDiagnostic: 'invalid bearer token',
      },
    },
    {
      id: 'codex-structured-validation',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(
          400,
          'invalid_request_error',
          'invalid request payload',
        ),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'invalid request payload',
      },
    },
    {
      id: 'codex-structured-plan',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(402, 'billing_error', 'payment required'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'payment required',
      },
    },
    {
      id: 'codex-unexposed-disabled-code',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(403, 'account_disabled', 'account disabled'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic: 'account disabled',
      },
    },
    {
      id: 'codex-structured-transient',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(503, 'api_error', 'service unavailable'),
        () => codexSuccess('codex transient recovered'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        accountIds: ['primary', 'primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 1,
        agentSessionRetries: 1,
        terminalKind: 'turn-complete',
        visibleText: 'codex transient recovered',
        absentDiagnostic: 'service unavailable',
      },
    },
    {
      id: 'unretained-terminal-prose',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(
          418,
          'mystery_error',
          '429 rate limit maybe; contact support',
        ),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-failed',
        exactTerminalDiagnostic:
          '418 {"type":"error","error":{"type":"mystery_error","message":"429 rate limit maybe; contact support"}}',
      },
    },
    {
      id: 'assistant-content-mimics-error',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        (model) => anthropicSuccess(
          model.id,
          '429 rate limit invalid api key',
        ),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        accountIds: ['primary'],
        switchEffects: 0,
        refreshReads: 0,
        quotaBackoffs: 0,
        agentSessionRetries: 0,
        terminalKind: 'turn-complete',
        visibleText: '429 rate limit invalid api key',
      },
    },
  ];
}

describe('Pi request-auth real-owner composition', () => {
  for (const version of VERSIONS) {
    for (const scenario of recoveredScenarios()) {
      it(
        `${version}/${scenario.id} crosses real transport, recovery, AgentSession, and RPC output owners`,
        async () => {
          await runRealOwnerScenario(version, scenario);
        },
        30_000,
      );
    }
  }

  it(
    '0.82.1 preserves the exact generated Provider terminal when cancelled during real AgentSession backoff',
    async () => {
      await runRealOwnerScenario('0.82.1', {
        id: 'cancel-during-real-backoff',
        providerId: 'anthropic',
        retryEnabled: true,
        cancelOnBackoff: true,
        responses: [
          () => jsonError(529, 'overloaded_error', 'Overloaded'),
        ],
        expected: {
          attempts: 1,
          lookups: 1,
          reports: 1,
          accountIds: ['primary'],
          switchEffects: 0,
          refreshReads: 0,
          quotaBackoffs: 1,
          agentSessionRetries: 1,
          terminalKind: 'turn-cancelled',
          exactTerminalDiagnostic:
            '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        },
      });
    },
    30_000,
  );

  it(
    '0.82.1 exposes the exact final Provider diagnostic after an exhausted AgentSession retry',
    async () => {
      const first = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
      const final = '400 {"type":"error","error":{"type":"invalid_request_error","message":"final diagnostic after retry"}}';
      await runRealOwnerScenario('0.82.1', {
        id: 'retry-final-different',
        providerId: 'anthropic',
        retryEnabled: true,
        responses: [
          () => jsonError(529, 'overloaded_error', 'Overloaded'),
          () => jsonError(
            400,
            'invalid_request_error',
            'final diagnostic after retry',
          ),
        ],
        expected: {
          attempts: 2,
          lookups: 2,
          reports: 1,
          accountIds: ['primary', 'primary'],
          switchEffects: 0,
          refreshReads: 0,
          quotaBackoffs: 1,
          agentSessionRetries: 1,
          terminalKind: 'turn-failed',
          exactTerminalDiagnostic: final,
          absentDiagnostic: first,
        },
      });
    },
    30_000,
  );
});
