import { isPluginError } from '@happier-dev/plugin-sdk';
import {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildOpenCodeQualifiedAuthContent } from './materialize/index.js';
import {
  OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS,
  OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  type OpenCodeConnectedAccountPurposeId,
} from './purposes.js';

type Binding = Awaited<ReturnType<
  AgentRuntimeContext['services']['connectedAccounts']['getBinding']
>>;

type ExpectedService = Readonly<{ pluginId: string; localId: string }>;

const EXPECTED_SERVICES = Object.freeze({
  [OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.agent.claude',
    localId: 'claude-subscription',
  }),
  [OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.agent.codex',
    localId: 'openai-codex',
  }),
  [OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.voice.openai',
    localId: 'openai',
  }),
  [OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.agent.claude',
    localId: 'anthropic',
  }),
} satisfies Readonly<Record<OpenCodeConnectedAccountPurposeId, ExpectedService>>);

const OPEN_CODE_NATIVE_AUTH_ENV_KEYS = Object.freeze([
  'OPENCODE_AUTH_CONTENT',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
] as const);

export type PreparedOpenCodeQualifiedConnectedAccounts = Readonly<{
  request: AgentSessionOpenRequest;
  isInvalidated(): boolean;
  bind(session: AgentSessionRuntime): AgentSessionRuntime;
  dispose(): Promise<void>;
}>;

function assertExpectedBinding(
  purpose: OpenCodeConnectedAccountPurposeId,
  binding: Binding,
): binding is NonNullable<Binding> {
  if (!binding) return false;
  const expected = EXPECTED_SERVICES[purpose];
  if (
    binding.purpose !== purpose
    || binding.service.pluginId !== expected.pluginId
    || binding.service.localId !== expected.localId
  ) {
    throw new Error(`OpenCode connected-account purpose ${purpose} resolved an unexpected binding`);
  }
  return true;
}

function readExactEnvironmentValue(
  purpose: OpenCodeConnectedAccountPurposeId,
  materialized: Awaited<ReturnType<
    AgentRuntimeContext['services']['connectedAccounts']['materialize']
  >>,
  key: string,
): string {
  if (materialized.kind !== 'environment') {
    throw new Error(`OpenCode ${purpose} returned an invalid environment materialization`);
  }
  const keys = Object.keys(materialized.env);
  if (keys.some((candidate) => candidate !== key)) {
    throw new Error(`OpenCode ${purpose} returned an unrequested environment materialization`);
  }
  const value = materialized.env[key] ?? '';
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`OpenCode ${purpose} did not materialize ${key}`);
  }
  return value;
}

function mergeQualifiedLaunchEnvironment(input: Readonly<{
  request: AgentSessionOpenRequest;
  authContent: string;
}>): AgentSessionOpenRequest {
  const values = { ...(input.request.launchEnvironment?.values ?? {}) };
  for (const key of OPEN_CODE_NATIVE_AUTH_ENV_KEYS) delete values[key];
  Object.assign(values, {
    OPENCODE_AUTH_CONTENT: input.authContent,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  });
  const valueKeys = new Set(Object.keys(values));
  const unset = new Set(
    (input.request.launchEnvironment?.unset ?? []).filter((key) => !valueKeys.has(key)),
  );
  unset.add(CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey);
  return Object.freeze({
    ...input.request,
    launchEnvironment: Object.freeze({
      values: Object.freeze(values),
      unset: Object.freeze([...unset]),
    }),
  });
}

async function waitForInitialPurposeObservations(
  observations: Iterable<Promise<void>>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await Promise.all(observations);
    return;
  }
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new Error('OpenCode qualified Connected Account preparation was aborted.');
  if (signal.aborted) throw abortError();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([Promise.all(observations), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function prepareOpenCodeQualifiedConnectedAccounts(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<PreparedOpenCodeQualifiedConnectedAccounts> {
  // A Provider binding is the complete model credential authority. Selected
  // native OpenCode accounts must not be consulted or merged into that launch.
  if (request.providerBinding !== undefined) {
    return Object.freeze({
      request,
      isInvalidated: () => context.signal?.aborted === true,
      bind: (session) => session,
      async dispose() {},
    });
  }
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  let invalidated = false;
  let invalidationHandler: (() => Promise<void>) | null = null;
  let disposed = false;
  const initialObservations = new Map<OpenCodeConnectedAccountPurposeId, Promise<void>>();
  const resolveInitial = new Map<OpenCodeConnectedAccountPurposeId, () => void>();

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  const invalidate = async (): Promise<void> => {
    invalidated = true;
    await invalidationHandler?.();
  };

  try {
    for (const purpose of OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS) {
      initialObservations.set(purpose, new Promise<void>((resolve) => {
        resolveInitial.set(purpose, resolve);
      }));
      let initial = true;
      subscriptions.push(context.services.connectedAccounts.watch(purpose, () => {
        if (initial) {
          initial = false;
          resolveInitial.get(purpose)?.();
          resolveInitial.delete(purpose);
          return;
        }
        return invalidate();
      }));
    }
    await waitForInitialPurposeObservations(initialObservations.values(), context.signal);

    const bindingEntries = await Promise.all(
      OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS.map(async (purpose) => [
        purpose,
        await context.services.connectedAccounts.getBinding(
          purpose,
          { signal: context.signal },
        ),
      ] as const),
    );
    const bindings = Object.fromEntries(bindingEntries) as Record<
      OpenCodeConnectedAccountPurposeId,
      Binding
    >;
    for (const purpose of OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS) {
      assertExpectedBinding(purpose, bindings[purpose]);
    }
    const openAiCodexBinding = bindings[OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID];
    const openAiBinding = bindings[OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID];
    const anthropicRequestAuthBinding = bindings[OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID];
    const anthropicBinding = bindings[OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID];

    const directApiKeys: Partial<Record<'openai' | 'anthropic', string>> = {};
    const requiredRequestAuthProviders: Array<'openai' | 'anthropic'> = [];
    let usedBinding = false;

    if (openAiCodexBinding) {
      usedBinding = true;
      requiredRequestAuthProviders.push('openai');
    } else if (openAiBinding) {
      usedBinding = true;
      const materialized = await context.services.connectedAccounts.materialize(
        OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        { signal: context.signal, expectedAccount: openAiBinding.account },
      );
      directApiKeys.openai = readExactEnvironmentValue(
        OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
        materialized,
        'OPENAI_API_KEY',
      );
    }

    if (anthropicRequestAuthBinding) {
      usedBinding = true;
      try {
        const materialized = await context.services.connectedAccounts.materialize(
          OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
          {
            signal: context.signal,
            expectedAccount: anthropicRequestAuthBinding.account,
          },
        );
        const setupToken = readExactEnvironmentValue(
          OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          materialized,
          CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
        );
        directApiKeys.anthropic = setupToken;
      } catch (error) {
        if (
          !isPluginError(error)
          || error.code
            !== CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth
              .requestAuthRequiredErrorCode
        ) {
          throw error;
        }
        requiredRequestAuthProviders.push('anthropic');
      }
    } else if (anthropicBinding) {
      usedBinding = true;
      const materialized = await context.services.connectedAccounts.materialize(
        OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
        { signal: context.signal, expectedAccount: anthropicBinding.account },
      );
      directApiKeys.anthropic = readExactEnvironmentValue(
        OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
        materialized,
        'ANTHROPIC_API_KEY',
      );
    }

    const preparedRequest = usedBinding
      ? mergeQualifiedLaunchEnvironment({
          request,
          authContent: buildOpenCodeQualifiedAuthContent({
            baseAuthContent: request.launchEnvironment?.values.OPENCODE_AUTH_CONTENT,
            directApiKeys,
            requiredRequestAuthProviders,
          }),
        })
      : request;

    return Object.freeze({
      request: preparedRequest,
      isInvalidated: () => invalidated || context.signal?.aborted === true,
      bind(session) {
        let sessionDisposed = false;
        const preparedSession: AgentSessionRuntime = {
          ...session,
          async dispose(reason) {
            if (sessionDisposed) return;
            sessionDisposed = true;
            await dispose();
            await session.dispose(reason);
          },
        };
        invalidationHandler = async () => await preparedSession.dispose('runtime_recovery');
        if (invalidated) void invalidationHandler();
        return preparedSession;
      },
      dispose,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
}
