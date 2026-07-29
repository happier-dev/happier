import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createConnectedAccountRequestAuthService,
  type ConnectedAccountRequestAuthResolvedBinding,
  type ConnectedAccountRequestAuthSubject,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService.ts';
import {
  applyConnectedAccountRequestAuthRecovery,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthRecovery.ts';
import { PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS } from './purposes.js';
import { buildPiRequestAuthExtensionSource } from './source.js';

type PiVersion = '0.81.0' | '0.81.1' | '0.82.0' | '0.82.1';
type ProviderId = 'anthropic' | 'openai-codex';

type Scenario = Readonly<{
  id: string;
  providerId: ProviderId;
  retryEnabled: boolean;
  responses: readonly ((model: Readonly<{ id: string }>) => Response)[];
  expected: Readonly<{
    attempts: number;
    lookups: number;
    reports: number;
    agentSessionRetries: number;
    accounts: readonly string[];
    lookupAccounts?: readonly string[];
    evidence: readonly Readonly<Record<string, unknown>>[];
    promptBoundaries?: readonly Readonly<Record<string, number>>[];
    finalDiagnosticIncludes?: string;
    finalDiagnosticExcludes?: string;
  }>;
  abortDuringReport?: boolean;
  independentSecondPrompt?: boolean;
  reportStatus?: string;
  switchAccountOnReport?: boolean;
  denyReplayLookupAfterReport?: boolean;
  corruptReplayCodexHeader?: boolean;
}>;

type ExactPiModules = Readonly<{
  coding: typeof import('pi-coding-agent-0821');
  providers: typeof import('pi-ai-0821/providers/all');
  codingAlias: string;
  providerAlias: string;
}>;

type ComposedState = {
  lookup: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>;
  reportAuth: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>;
  reportQuota: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>;
};

declare global {
  // Test-only system-boundary hooks consumed by the generated extension.
  // eslint-disable-next-line no-var
  var __happierPiComposedMatrix: ComposedState | undefined;
}

const REQUEST_AUTH_CLIENT_SOURCE = `
async function lookupConnectedAccountRequestAuth(input) {
  return globalThis.__happierPiComposedMatrix.lookup(input);
}
async function reportConnectedAccountAuthFailure(input) {
  return globalThis.__happierPiComposedMatrix.reportAuth(input);
}
async function reportConnectedAccountQuotaFailure(input) {
  return globalThis.__happierPiComposedMatrix.reportQuota(input);
}
`;

const PURPOSES = Object.freeze({
  anthropic: {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: 'anthropic-upstream',
  },
  'openai-codex': {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: 'openai-codex-upstream',
  },
});

const PACKAGE_DIRECTORY = fileURLToPath(new URL('../../../../../', import.meta.url));
const COMPOSED_TEST_WORKSPACE_PARENT = join(
  PACKAGE_DIRECTORY,
  'node_modules',
  '.cache',
  'happier-tests',
  'pi-request-auth',
);
const require = createRequire(import.meta.url);

async function createComposedTestWorkspace(): Promise<string> {
  await mkdir(COMPOSED_TEST_WORKSPACE_PARENT, { recursive: true });
  return await mkdtemp(join(COMPOSED_TEST_WORKSPACE_PARENT, 'composed-'));
}

// Adding a supported Pi version requires an exact coding-agent alias, an exact pi-ai alias,
// retained terminal signatures, and this complete matrix passing before Level B is enabled.
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

async function findAliasedPackageRoot(alias: string): Promise<string> {
  for (const searchRoot of require.resolve.paths(alias) ?? []) {
    try {
      await readFile(join(searchRoot, alias, 'package.json'), 'utf8');
      return join(searchRoot, alias);
    } catch {
      // Keep searching Node's ordinary package roots.
    }
  }
  throw new Error(`Unable to resolve exact Pi alias package: ${alias}`);
}

async function readAliasedVersion(alias: string): Promise<string> {
  const packageRoot = await findAliasedPackageRoot(alias);
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  return String(packageJson.version ?? '');
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

function codexUsageLimitError(input: Readonly<{
  planType?: string;
  resetMinutes?: number;
}> = {}): Response {
  return new Response(JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'provider detail intentionally replaced by Pi friendly output',
      ...(input.planType ? { plan_type: input.planType } : {}),
      ...(input.resetMinutes === undefined
        ? {}
        : { resets_at: Math.floor(Date.now() / 1_000) + input.resetMinutes * 60 }),
    },
  }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'request-id': 'request-codex-usage-limit',
    },
  });
}

function anthropicSse(events: readonly Readonly<Record<string, unknown>>[]): Response {
  const body = events.flatMap((event) => [
    `event: ${String(event.type)}`,
    `data: ${JSON.stringify(event)}`,
    '',
  ]).concat('').join('\n');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicSuccess(modelId: string, text = 'ok'): Response {
  return anthropicSse([
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
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
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
      error: { type: 'overloaded_error', message: 'Overloaded after tool call' },
    },
  ]);
}

function tokenFor(providerId: ProviderId, accountId: string): string {
  if (providerId === 'anthropic') return `sk-ant-oat-${accountId}`;
  const encoded = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  }), 'utf8').toString('base64url');
  return `header.${encoded}.signature`;
}

function pinned(
  version: PiVersion,
  provider: ProviderId,
  signatureId: string,
): Readonly<Record<string, unknown>> {
  return {
    kind: 'pinnedProviderTerminal',
    producer: 'pi',
    producerVersion: version,
    provider,
    signatureId,
  };
}

function scenarios(version: PiVersion): readonly Scenario[] {
  return [
    {
      id: 'terminal-rate-enabled',
      providerId: 'anthropic',
      retryEnabled: true,
      switchAccountOnReport: false,
      reportStatus: 'current_unchanged',
      responses: [
        () => jsonError(429, 'rate_limit_error', 'rate limit exceeded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 429,
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-429-rate-limit-v1'),
        }],
      },
    },
    {
      id: 'terminal-rate-disabled-next-independent',
      providerId: 'anthropic',
      retryEnabled: false,
      independentSecondPrompt: true,
      switchAccountOnReport: false,
      reportStatus: 'current_unchanged',
      responses: [
        () => jsonError(429, 'rate_limit_error', 'rate limit exceeded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 429,
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-429-rate-limit-v1'),
        }],
        promptBoundaries: [
          { attempts: 1, lookups: 1, reports: 1 },
          { attempts: 2, lookups: 2, reports: 1 },
        ],
      },
    },
    {
      id: 'terminal-rate-cancelled-during-report',
      providerId: 'anthropic',
      retryEnabled: true,
      abortDuringReport: true,
      switchAccountOnReport: false,
      reportStatus: 'current_unchanged',
      responses: [
        () => jsonError(429, 'rate_limit_error', 'rate limit exceeded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [{
          httpStatus: 429,
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-429-rate-limit-v1'),
        }],
        finalDiagnosticIncludes: 'rate limit exceeded',
      },
    },
    {
      id: 'terminal-retry-final-different',
      providerId: 'anthropic',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
        () => jsonError(400, 'invalid_request_error', 'final diagnostic after retry'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 529,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-529-overloaded-v1'),
        }],
        finalDiagnosticIncludes: 'final diagnostic after retry',
        finalDiagnosticExcludes: 'Overloaded',
      },
    },
    {
      id: 'terminal-retry-exhausted-with-distinct-pi-owned-terminal',
      providerId: 'anthropic',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
        () => jsonError(429, 'rate_limit_error', 'rate limit exceeded'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [
          {
            httpStatus: 529,
            limitCategory: 'capacity',
            quotaScope: 'unknown',
            evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-529-overloaded-v1'),
          },
          {
            httpStatus: 429,
            limitCategory: 'rate_limit',
            quotaScope: 'unknown',
            evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-429-rate-limit-v1'),
          },
        ],
        finalDiagnosticIncludes: 'rate limit exceeded',
        finalDiagnosticExcludes: 'Overloaded',
      },
    },
    {
      id: 'terminal-usage-limit-leaf',
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
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-b'],
        evidence: [{
          httpStatus: 429,
          limitCategory: 'usage_limit',
          quotaScope: 'account',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-429-account-exhaustion-v1'),
        }],
      },
    },
    {
      id: 'terminal-auth-leaf',
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
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-b'],
        evidence: [{
          httpStatus: 401,
          limitCategory: 'auth_invalid',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-401-authentication-v1'),
        }],
      },
    },
    {
      id: 'terminal-provider-capacity',
      providerId: 'anthropic',
      retryEnabled: true,
      switchAccountOnReport: false,
      reportStatus: 'current_unchanged',
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 529,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-529-overloaded-v1'),
        }],
      },
    },
    {
      id: 'terminal-provider-capacity-disabled',
      providerId: 'anthropic',
      retryEnabled: false,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [{
          httpStatus: 529,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: pinned(version, 'anthropic', 'anthropic-sdk-529-overloaded-v1'),
        }],
        finalDiagnosticIncludes: 'Overloaded',
      },
    },
    {
      id: 'anthropic-http-503-transient',
      providerId: 'anthropic',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(503, 'api_error', 'service unavailable'),
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 503,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: pinned(
            version,
            'anthropic',
            'anthropic-sdk-503-api-error-v1',
          ),
        }],
      },
    },
    {
      id: 'anthropic-network-transient',
      providerId: 'anthropic',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => {
          throw new TypeError('fetch failed');
        },
        (model) => anthropicSuccess(model.id),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 0,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [],
      },
    },
    {
      id: 'anthropic-http-503-transient-disabled',
      providerId: 'anthropic',
      retryEnabled: false,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(503, 'api_error', 'service unavailable'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 1,
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [{
          httpStatus: 503,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: pinned(
            version,
            'anthropic',
            'anthropic-sdk-503-api-error-v1',
          ),
        }],
        finalDiagnosticIncludes: 'service unavailable',
      },
    },
    {
      id: 'ambiguous-provider-error-text',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        () => jsonError(400, 'invalid_request_error', 'rate limit maybe; contact support'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [],
      },
    },
    {
      id: 'assistant-content-mimics-error',
      providerId: 'anthropic',
      retryEnabled: true,
      responses: [
        (model) => anthropicSuccess(model.id, '429 rate limit invalid api key'),
      ],
      expected: {
        attempts: 1,
        lookups: 1,
        reports: 0,
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [],
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
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [],
        finalDiagnosticIncludes: 'Overloaded',
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
        agentSessionRetries: 0,
        accounts: ['account-a'],
        evidence: [],
        finalDiagnosticIncludes: 'Overloaded after tool call',
      },
    },
    {
      id: 'structured-codex-auth',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(401, 'invalid_api_key', 'invalid bearer token'),
        () => jsonError(400, 'invalid_request_error', 'terminal after leaf replay'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-b'],
        evidence: [
          {
            httpStatus: 401,
            limitCategory: 'auth_invalid',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
          {
            httpStatus: 400,
            limitCategory: 'validation_failed',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
        ],
        finalDiagnosticIncludes: 'terminal after leaf replay',
      },
    },
    {
      id: 'structured-codex-usage-limit',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => jsonError(429, 'rate_limit_error', 'rate limit exceeded'),
        () => jsonError(400, 'invalid_request_error', 'terminal after leaf replay'),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-b'],
        evidence: [
          {
            httpStatus: 429,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            evidenceSource: pinned(
              version,
              'openai-codex',
              'openai-codex-chatgpt-usage-limit-v1',
            ),
          },
          {
            httpStatus: 400,
            limitCategory: 'validation_failed',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
        ],
        finalDiagnosticIncludes: 'terminal after leaf replay',
      },
    },
    {
      id: 'structured-codex-usage-limit-leaf-exhausted',
      providerId: 'openai-codex',
      retryEnabled: true,
      responses: [
        () => codexUsageLimitError(),
        () => codexUsageLimitError(),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 2,
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-b'],
        evidence: [
          {
            httpStatus: 429,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            evidenceSource: pinned(
              version,
              'openai-codex',
              'openai-codex-chatgpt-usage-limit-v1',
            ),
          },
          {
            httpStatus: 429,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            evidenceSource: pinned(
              version,
              'openai-codex',
              'openai-codex-chatgpt-usage-limit-v1',
            ),
          },
        ],
        finalDiagnosticIncludes: 'You have hit your ChatGPT usage limit.',
      },
    },
    ...([
      ['lookup-denied', { denyReplayLookupAfterReport: true }],
      ['header-mismatch', { corruptReplayCodexHeader: true }],
    ] as const).map(([variant, replayFailure]) => ({
      id: `structured-codex-usage-limit-replay-${variant}`,
      providerId: 'openai-codex' as const,
      retryEnabled: true,
      ...replayFailure,
      responses: [
        () => codexUsageLimitError(),
      ],
      expected: {
        attempts: 1,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 0,
        accounts: ['account-a'],
        ...(variant === 'header-mismatch'
          ? { lookupAccounts: ['account-a', 'account-b'] }
          : {}),
        evidence: [{
          httpStatus: 429,
          limitCategory: 'usage_limit',
          quotaScope: 'account',
          evidenceSource: pinned(
            version,
            'openai-codex',
            'openai-codex-chatgpt-usage-limit-v1',
          ),
        }],
        finalDiagnosticIncludes: 'You have hit your ChatGPT usage limit.',
      },
    })),
    ...([
      ['plan', { planType: 'PLUS' }],
      ['reset', { resetMinutes: 12 }],
      ['plan-reset', { planType: 'TEAM', resetMinutes: 0 }],
    ] as const).map(([variant, usageInput]) => ({
      id: `structured-codex-usage-limit-${variant}`,
      providerId: 'openai-codex' as const,
      retryEnabled: true,
      responses: [
        () => codexUsageLimitError(usageInput),
        () => codexSuccess(),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 0,
        accounts: ['account-a', 'account-b'],
        evidence: [{
          httpStatus: 429,
          limitCategory: 'usage_limit',
          quotaScope: 'account',
          evidenceSource: pinned(
            version,
            'openai-codex',
            'openai-codex-chatgpt-usage-limit-v1',
          ),
        }],
      },
    })),
    {
      id: 'codex-http-524-transient',
      providerId: 'openai-codex',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(524, 'api_error', 'service unavailable'),
        () => codexSuccess(),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 524,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        }],
      },
    },
    {
      id: 'codex-http-529-provider-capacity',
      providerId: 'openai-codex',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => jsonError(529, 'overloaded_error', 'Overloaded'),
        () => codexSuccess(),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 1,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [{
          httpStatus: 529,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        }],
      },
    },
    {
      id: 'codex-network-transient',
      providerId: 'openai-codex',
      retryEnabled: true,
      switchAccountOnReport: false,
      responses: [
        () => {
          throw new TypeError('fetch failed');
        },
        () => codexSuccess(),
      ],
      expected: {
        attempts: 2,
        lookups: 2,
        reports: 0,
        agentSessionRetries: 1,
        accounts: ['account-a', 'account-a'],
        evidence: [],
      },
    },
  ];
}

function selectedHeaders(request: Request): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) {
    if (
      name === 'authorization'
      || name === 'x-api-key'
      || name === 'chatgpt-account-id'
    ) {
      selected[name] = value;
    }
  }
  return selected;
}

async function runScenario(
  version: PiVersion,
  modules: ExactPiModules,
  scenario: Scenario,
): Promise<void> {
  const root = await createComposedTestWorkspace();
  const extensionPath = join(root, 'request-auth.mjs');
  const generated = buildPiRequestAuthExtensionSource({
    purposes: { [scenario.providerId]: PURPOSES[scenario.providerId] },
    requestAuthClientSource: REQUEST_AUTH_CLIENT_SOURCE,
  })
    .replaceAll(
      '@earendil-works/pi-ai/providers/all',
      `${modules.providerAlias}/providers/all`,
    )
    .replaceAll('@earendil-works/pi-ai', modules.providerAlias);
  await writeFile(extensionPath, generated, 'utf8');

  const settings = modules.coding.SettingsManager.inMemory({
    retry: {
      enabled: scenario.retryEnabled,
      maxRetries: 1,
      baseDelayMs: 0,
      provider: { maxRetries: 0 },
    },
  }, { projectTrusted: true });
  const settingsBefore = JSON.stringify(settings.getGlobalSettings());
  let settingsMutationCount = 0;
  const originalSetRetryEnabled = settings.setRetryEnabled.bind(settings);
  settings.setRetryEnabled = (enabled: boolean) => {
    settingsMutationCount += 1;
    return originalSetRetryEnabled(enabled);
  };

  const state = {
    attempts: [] as Array<Readonly<{ accountId: string; headers: Readonly<Record<string, string>> }>>,
    lookups: [] as Array<Readonly<{
      accountId: string;
      credentialContext: Readonly<Record<string, unknown>>;
    }>>,
    lookupInvocations: 0,
    reports: [] as Array<Readonly<Record<string, unknown>>>,
    events: [] as Array<Readonly<Record<string, unknown>>>,
    recoveryEffects: [] as string[],
    refreshEffects: 0,
    switchEffects: 0,
    temporaryRetryEffects: 0,
  };
  let currentAccountId = 'account-a';
  let markReportStarted!: () => void;
  const reportStarted = new Promise<void>((resolve) => {
    markReportStarted = resolve;
  });
  let releaseReport!: () => void;
  const reportRelease = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  const requestAuthBinding = {
    purpose: PURPOSES[scenario.providerId],
    target: {
      kind: 'group',
      service: scenario.providerId === 'anthropic'
        ? { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }
        : { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      groupId: 'group-composed',
    },
  } as const;
  const resolveCurrentBinding = (): ConnectedAccountRequestAuthResolvedBinding | null => (
    scenario.denyReplayLookupAfterReport && state.recoveryEffects.length > 0
      ? null
      : ({
    account: {
      service: requestAuthBinding.target.service,
      accountId: currentAccountId,
    },
    group: {
      groupId: requestAuthBinding.target.groupId,
      generation: currentAccountId === 'account-a' ? 1 : 2,
    },
    credentialRevision: currentAccountId === 'account-a'
      ? 'csr_aaaaaaaaaaaaaaaaaaaaaa'
      : 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      })
  );
  const requestAuthUse = {
    purpose: requestAuthBinding.purpose,
    materialization: PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS[scenario.providerId],
  };
  const subject: ConnectedAccountRequestAuthSubject = {
    subjectId: `pi-composed:${scenario.id}`,
    isCurrent: () => true,
    registerRedaction: () => undefined,
    resolvePurposeUse: (requestedPurpose) => (
      JSON.stringify(requestedPurpose) === JSON.stringify(requestAuthBinding.purpose)
        ? { binding: requestAuthBinding, use: requestAuthUse }
        : null
    ),
    listPurposeUses: () => [{
      binding: requestAuthBinding,
      use: requestAuthUse,
    }],
  };
  const applyRealRecovery = async (
    resolved: ConnectedAccountRequestAuthResolvedBinding,
    failure: Parameters<typeof applyConnectedAccountRequestAuthRecovery>[0]['failure'],
  ) => {
    const beforeAccountId = currentAccountId;
    const recovery = await applyConnectedAccountRequestAuthRecovery({
      resolved,
      failure,
      refreshCredential: async ({ expectedCredentialRevision }) => {
        state.refreshEffects += 1;
        expect(expectedCredentialRevision).toBe(resolved.credentialRevision);
        if (scenario.switchAccountOnReport !== false) currentAccountId = 'account-b';
        return scenario.switchAccountOnReport !== false;
      },
      switchAfterClassifiedFailure: async () => {
        state.switchEffects += 1;
        if (scenario.switchAccountOnReport !== false) currentAccountId = 'account-b';
        return { status: 'switched' };
      },
      recordTemporaryRetry: async () => {
        state.temporaryRetryEffects += 1;
        return { status: 'recorded' };
      },
    });
    state.recoveryEffects.push(recovery.effect);
    return {
      status: currentAccountId === beforeAccountId
        ? 'current_unchanged' as const
        : 'current_changed' as const,
    };
  };
  const requestAuthOwner = createConnectedAccountRequestAuthService({
    resolveCurrentBinding,
    materializeBearer: async ({ resolved }) => ({
      accessToken: tokenFor(scenario.providerId, resolved.account.accountId),
      ...(scenario.providerId === 'openai-codex'
        ? {
          requiredHeaders: {
            'ChatGPT-Account-ID':
              scenario.corruptReplayCodexHeader && state.recoveryEffects.length > 0
                ? 'different-account'
                : resolved.account.accountId,
          },
        }
        : {}),
    }),
    refreshAfterAuthFailure: async ({ resolved, failure }) => (
      await applyRealRecovery(resolved, failure)
    ),
    reportQuotaFailure: async ({ resolved, failure }) => (
      await applyRealRecovery(resolved, failure)
    ),
  });
  const report = async (
    kind: 'auth' | 'quota',
    input: Readonly<Record<string, unknown>>,
  ) => {
    const failedLookup = state.lookups.at(-1);
    expect(input.credentialContext, `${scenario.id}: exact failed credential context`)
      .toEqual(failedLookup?.credentialContext);
    state.reports.push(input);
    if (scenario.abortDuringReport) {
      markReportStarted();
      await reportRelease;
    }
    const request = {
      credentialContext: input.credentialContext,
      normalizedFailure: input.normalizedFailure,
    };
    return kind === 'auth'
      ? await requestAuthOwner.refreshAfterAuthFailure({
        subject,
        request: request as never,
      })
      : await requestAuthOwner.reportQuotaFailure({
        subject,
        request: request as never,
      });
  };
  globalThis.__happierPiComposedMatrix = {
    lookup: async () => {
      state.lookupInvocations += 1;
      const lease = await requestAuthOwner.lookupRequestAuth({
        subject,
        purpose: requestAuthBinding.purpose,
      });
      const accountId = lease.credentialContext.account.accountId;
      const credentialContext = lease.credentialContext;
      state.lookups.push({ accountId, credentialContext });
      return lease;
    },
    reportAuth: async (input) => await report('auth', input),
    reportQuota: async (input) => await report('quota', input),
  };

  const resourceLoader = new modules.coding.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const originalFetch = globalThis.fetch;
  let session: Awaited<ReturnType<typeof modules.coding.createAgentSession>>['session'] | undefined;
  let disposeSubscription: (() => void) | undefined;
  const promptBoundaries: Array<Readonly<Record<string, number>>> = [];
  try {
    await resourceLoader.reload();
    const provider = modules.providers.builtinProviders()
      .find((candidate) => candidate.id === scenario.providerId);
    expect(provider, `${version}/${scenario.id}: exact provider exists`).toBeDefined();
    const model = provider?.getModels()[0];
    expect(model, `${version}/${scenario.id}: exact provider has a model`).toBeDefined();
    if (!model) return;

    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const attemptIndex = state.attempts.length;
      state.attempts.push({
        accountId: currentAccountId,
        headers: selectedHeaders(request),
      });
      const responseFactory = scenario.responses[
        Math.min(attemptIndex, scenario.responses.length - 1)
      ];
      return responseFactory(model);
    };

    const created = await modules.coding.createAgentSession({
      cwd: root,
      agentDir: root,
      model,
      thinkingLevel: 'off',
      tools: [],
      resourceLoader,
      sessionManager: modules.coding.SessionManager.inMemory(root),
      settingsManager: settings,
    });
    session = created.session;
    expect(
      created.extensionsResult.diagnostics ?? [],
      `${version}/${scenario.id}: extension diagnostics`,
    ).toEqual([]);
    disposeSubscription = session.subscribe((event) => {
      if (event.type === 'auto_retry_start' || event.type === 'agent_end') {
        state.events.push(event as unknown as Readonly<Record<string, unknown>>);
      }
    });

    if (scenario.abortDuringReport) {
      const prompt = session.prompt('first request');
      await reportStarted;
      const abort = session.abort();
      releaseReport();
      await Promise.all([prompt, abort]);
    } else {
      await session.prompt('first request');
    }
    promptBoundaries.push({
      attempts: state.attempts.length,
      lookups: state.lookupInvocations,
      reports: state.reports.length,
    });
    if (scenario.independentSecondPrompt) {
      await session.prompt('independent second request');
      promptBoundaries.push({
        attempts: state.attempts.length,
        lookups: state.lookupInvocations,
        reports: state.reports.length,
      });
    }

    const retryCount = state.events.filter((event) => event.type === 'auto_retry_start').length;
    expect(state.attempts.length, `${version}/${scenario.id}: total upstream attempts`)
      .toBe(scenario.expected.attempts);
    expect(state.lookupInvocations, `${version}/${scenario.id}: fresh request-auth lookups`)
      .toBe(scenario.expected.lookups);
    expect(state.reports.length, `${version}/${scenario.id}: request-auth leaf reports`)
      .toBe(scenario.expected.reports);
    expect(state.recoveryEffects.length, `${version}/${scenario.id}: real recovery-policy effects`)
      .toBe(scenario.expected.reports);
    expect(retryCount, `${version}/${scenario.id}: AgentSession whole-turn retries`)
      .toBe(scenario.expected.agentSessionRetries);
    expect(
      state.lookups.map((lookup) => lookup.accountId),
      `${version}/${scenario.id}: lookup account sequence`,
    ).toEqual(scenario.expected.lookupAccounts ?? scenario.expected.accounts);
    expect(
      state.attempts.map((attempt) => attempt.accountId),
      `${version}/${scenario.id}: upstream account sequence`,
    ).toEqual(scenario.expected.accounts);
    expect(state.reports.map((item) => (
      item.normalizedFailure as Readonly<Record<string, unknown>>
    ).evidence)).toEqual(scenario.expected.evidence);
    expect(state.lookupInvocations, `${version}/${scenario.id}: every upstream attempt has a fresh lookup`)
      .toBeGreaterThanOrEqual(state.attempts.length);
    if (scenario.expected.promptBoundaries) {
      expect(promptBoundaries).toEqual(scenario.expected.promptBoundaries);
    }
    for (const [index, attempt] of state.attempts.entries()) {
      const accountId = scenario.expected.accounts[index];
      if (scenario.providerId === 'anthropic') {
        expect(attempt.headers.authorization).toBe(
          `Bearer ${tokenFor('anthropic', accountId)}`,
        );
        expect(attempt.headers).not.toHaveProperty('x-api-key');
      } else {
        expect(attempt.headers.authorization).toBe(`Bearer ${tokenFor('openai-codex', accountId)}`);
        expect(attempt.headers['chatgpt-account-id']).toBe(accountId);
      }
    }
    expect(settingsMutationCount, `${version}/${scenario.id}: saved retry setting mutation`).toBe(0);
    expect(JSON.stringify(settings.getGlobalSettings()), `${version}/${scenario.id}: settings bytes`)
      .toBe(settingsBefore);
    if (
      scenario.expected.finalDiagnosticIncludes
      || scenario.expected.finalDiagnosticExcludes
    ) {
      const finalAssistant = [...session.messages].reverse().find((message) => (
        message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
      )) as Readonly<Record<string, unknown>> | undefined;
      const finalDiagnostic = String(
        finalAssistant?.happierRequestAuthProviderDiagnostic
          ?? finalAssistant?.errorMessage
          ?? '',
      );
      if (scenario.expected.finalDiagnosticIncludes) {
        expect(
          finalDiagnostic,
          `${version}/${scenario.id}: exact final Provider diagnostic`,
        ).toContain(scenario.expected.finalDiagnosticIncludes);
      }
      if (scenario.expected.finalDiagnosticExcludes) {
        expect(
          finalDiagnostic,
          `${version}/${scenario.id}: stale retry diagnostic excluded`,
        ).not.toContain(scenario.expected.finalDiagnosticExcludes);
      }
    }
  } finally {
    disposeSubscription?.();
    await session?.dispose();
    globalThis.fetch = originalFetch;
    delete globalThis.__happierPiComposedMatrix;
    await rm(root, { recursive: true, force: true });
  }
}

describe('Pi request-auth composed test workspace', () => {
  it('keeps generated extensions outside source while preserving package module resolution', async () => {
    const root = await createComposedTestWorkspace();
    try {
      expect(root.startsWith(`${join(PACKAGE_DIRECTORY, 'node_modules')}${sep}`)).toBe(true);
      const resolutionProbePath = join(root, 'resolution-probe.mjs');
      await writeFile(
        resolutionProbePath,
        "import 'pi-ai-0821/providers/all';\nexport default true;\n",
        'utf8',
      );
      await expect(import(pathToFileURL(resolutionProbePath).href)).resolves.toMatchObject({
        default: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Pi request-auth exact-version AgentSession composed matrix', () => {
  it.each<PiVersion>(['0.81.0', '0.81.1', '0.82.0', '0.82.1'])(
    'pins producer %s across AgentSession and request-auth recovery policy',
    async (version) => {
      const modules = await loadExactPiModules(version);
      expect(await readAliasedVersion(modules.codingAlias)).toBe(version);
      expect(await readAliasedVersion(modules.providerAlias)).toBe(version);

      const previousVersion = process.env.HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION;
      process.env.HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION = version;
      try {
        for (const scenario of scenarios(version)) {
          await runScenario(version, modules, scenario);
        }
      } finally {
        if (previousVersion === undefined) {
          delete process.env.HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION;
        } else {
          process.env.HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION = previousVersion;
        }
      }
    },
    120_000,
  );
});
