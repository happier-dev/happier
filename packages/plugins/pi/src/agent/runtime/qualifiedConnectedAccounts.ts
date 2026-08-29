import { dirname } from 'node:path';

import { isPluginError } from '@happier-dev/plugin-sdk';
import {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import type {
  AgentLaunchEnvironment,
  AgentRuntimeContext,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { replacePiAuthConfig } from '../auth/services/authConfig.js';
import { PI_DIRECT_AUTH_ENV_KEYS } from '../launchEnvironment.js';
import {
  PI_ANTHROPIC_API_KEY_PURPOSE_ID,
  PI_OPENAI_API_KEY_PURPOSE_ID,
  PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES,
} from '../auth/services/qualifiedPurposes.js';
import {
  ensurePiRequestAuthExtensionAsset,
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
  retireLegacyPiRequestAuthAssets,
} from '../auth/services/requestAuth/index.js';
import {
  PI_REQUEST_AUTH_DECLARED_PURPOSES,
} from '../auth/services/requestAuth/purposes.js';
import type { PiRequestAuthPurposeMap } from '../auth/services/requestAuth/source.js';

const OPENAI_API_KEY_ENV_KEY = 'OPENAI_API_KEY';
const ANTHROPIC_API_KEY_ENV_KEY = 'ANTHROPIC_API_KEY';

type ConnectedAccounts = AgentRuntimeContext['services']['connectedAccounts'];
type ConnectedAccountBinding = Awaited<ReturnType<ConnectedAccounts['getBinding']>>;

export type PreparedPiQualifiedConnectedAccounts = Readonly<{
  launchEnvironment: AgentLaunchEnvironment;
  isInvalidated(): boolean;
  bind(runtime: AgentSessionRuntime): AgentSessionRuntime;
  dispose(): Promise<void>;
}>;

function readNonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function assertExpectedBinding(
  binding: ConnectedAccountBinding,
  expected: (typeof PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES)[number],
): void {
  if (!binding) return;
  if (
    binding.service.pluginId !== expected.service.pluginId
    || binding.service.localId !== expected.service.localId
  ) {
    throw new Error(`Pi purpose ${expected.purpose} resolved an unexpected Connected Account service`);
  }
}

function readExactEnvironmentValue(input: Readonly<{
  materialized: Awaited<ReturnType<ConnectedAccounts['materialize']>>;
  key: string;
}>): string {
  if (input.materialized.kind !== 'environment') {
    throw new Error(`Pi purpose expected an environment materialization for ${input.key}`);
  }
  const keys = Object.keys(input.materialized.env);
  if (keys.some((key) => key !== input.key)) {
    throw new Error(`Pi purpose returned an unexpected environment key while materializing ${input.key}`);
  }
  const value = readNonBlank(input.materialized.env[input.key]);
  if (!value) {
    throw new Error(`Pi purpose did not materialize ${input.key}`);
  }
  return value;
}

async function waitForInitialPurposeObservations(
  observations: Iterable<Promise<void>>,
  signal: AbortSignal,
): Promise<void> {
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new Error('Pi qualified Connected Account preparation was aborted');
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

function mergeQualifiedLaunchEnvironment(input: Readonly<{
  source?: AgentLaunchEnvironment;
  direct: Readonly<Record<string, string>>;
  remove: readonly string[];
}>): AgentLaunchEnvironment {
  const removed = new Set(input.remove);
  const values = Object.freeze({
    ...Object.fromEntries(
      Object.entries(input.source?.values ?? {}).filter(([key]) => !removed.has(key)),
    ),
    ...input.direct,
  });
  const materialized = new Set(Object.keys(input.direct));
  return Object.freeze({
    values,
    unset: Object.freeze(Array.from(new Set([
      ...(input.source?.unset ?? []).filter((key) => !materialized.has(key)),
      ...input.remove.filter((key) => !materialized.has(key)),
    ]))),
  });
}

export async function preparePiQualifiedConnectedAccounts(input: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
  context: Pick<AgentRuntimeContext, 'services' | 'signal'>;
}>): Promise<PreparedPiQualifiedConnectedAccounts> {
  const { connectedAccounts } = input.context.services;
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  const initialObservations: Promise<void>[] = [];
  let invalidated = false;
  let boundRuntime: AgentSessionRuntime | null = null;
  let subscriptionsDisposed = false;

  const disposeSubscriptions = (): void => {
    if (subscriptionsDisposed) return;
    subscriptionsDisposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  const invalidate = async (): Promise<void> => {
    invalidated = true;
    await boundRuntime?.dispose('runtime_recovery');
  };
  const bind = (runtime: AgentSessionRuntime): AgentSessionRuntime => {
    let disposed = false;
    const wrapped: AgentSessionRuntime = {
      ...runtime,
      async dispose(reason) {
        if (disposed) return;
        disposed = true;
        disposeSubscriptions();
        await runtime.dispose(reason);
      },
    };
    boundRuntime = wrapped;
    if (invalidated) void wrapped.dispose('runtime_recovery');
    return wrapped;
  };

  try {
    for (const declaration of PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES) {
      let resolveInitial!: () => void;
      initialObservations.push(new Promise<void>((resolve) => {
        resolveInitial = resolve;
      }));
      let initial = true;
      subscriptions.push(connectedAccounts.watch(declaration.purpose, () => {
        if (initial) {
          initial = false;
          resolveInitial();
          return;
        }
        return invalidate();
      }));
    }
    await waitForInitialPurposeObservations(
      initialObservations,
      input.context.signal,
    );
    const bindings = await Promise.all(
      PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.map(async (declaration) => {
        const binding = await connectedAccounts.getBinding(
          declaration.purpose,
          { signal: input.context.signal },
        );
        assertExpectedBinding(binding, declaration);
        return binding;
      }),
    );
    const [claudeSubscription, openaiCodex, openai, anthropic] = bindings;
    if (claudeSubscription && anthropic) {
      throw new Error('Pi cannot bind Claude Subscription and direct Anthropic credentials simultaneously');
    }

    const anyBound = bindings.some((binding) => binding !== null);
    const sourceLaunchEnvironment: AgentLaunchEnvironment = input.launchEnvironment ?? Object.freeze({
      values: Object.freeze({}),
      unset: Object.freeze([]),
    });
    if (!anyBound) {
      return Object.freeze({
        launchEnvironment: sourceLaunchEnvironment,
        isInvalidated: () => invalidated,
        bind,
        async dispose() {
          disposeSubscriptions();
        },
      });
    }

    const agentDir = readNonBlank(sourceLaunchEnvironment.values.PI_CODING_AGENT_DIR);
    if (!agentDir) {
      throw new Error('Pi qualified Connected Account launch requires the pre-materialized agent dir');
    }

    const directEnvironment: Record<string, string> = {};
    const directAuth: Partial<Record<'openai' | 'anthropic', Readonly<{
      type: 'api_key';
      key: string;
    }>>> = {};
    const requestAuthPurposes: {
      -readonly [K in keyof PiRequestAuthPurposeMap]?: NonNullable<PiRequestAuthPurposeMap[K]>;
    } = {};

    if (claudeSubscription) {
      try {
        const materialized = await connectedAccounts.materialize(
          PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES[0].purpose,
          CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
          { signal: input.context.signal, expectedAccount: claudeSubscription.account },
        );
        const setupToken = readExactEnvironmentValue({
          materialized,
          key: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
        });
        directEnvironment[ANTHROPIC_API_KEY_ENV_KEY] = setupToken;
        directAuth.anthropic = { type: 'api_key', key: setupToken };
      } catch (error) {
        if (
          !isPluginError(error)
          || error.code
            !== CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth
              .requestAuthRequiredErrorCode
        ) {
          throw error;
        }
        requestAuthPurposes.anthropic = PI_REQUEST_AUTH_DECLARED_PURPOSES.anthropic;
      }
    }
    if (openaiCodex) {
      requestAuthPurposes['openai-codex'] =
        PI_REQUEST_AUTH_DECLARED_PURPOSES['openai-codex'];
    }
    if (openai) {
      const materialized = await connectedAccounts.materialize(
        PI_OPENAI_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: [OPENAI_API_KEY_ENV_KEY] },
        { signal: input.context.signal, expectedAccount: openai.account },
      );
      const apiKey = readExactEnvironmentValue({
        materialized,
        key: OPENAI_API_KEY_ENV_KEY,
      });
      directEnvironment[OPENAI_API_KEY_ENV_KEY] = apiKey;
      directAuth.openai = { type: 'api_key', key: apiKey };
    }
    if (anthropic) {
      const materialized = await connectedAccounts.materialize(
        PI_ANTHROPIC_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: [ANTHROPIC_API_KEY_ENV_KEY] },
        { signal: input.context.signal, expectedAccount: anthropic.account },
      );
      const apiKey = readExactEnvironmentValue({
        materialized,
        key: ANTHROPIC_API_KEY_ENV_KEY,
      });
      directEnvironment[ANTHROPIC_API_KEY_ENV_KEY] = apiKey;
      directAuth.anthropic = { type: 'api_key', key: apiKey };
    }

    const requestAuthEnabled = Object.keys(requestAuthPurposes).length > 0;
    if (
      requestAuthEnabled
      && !readNonBlank(sourceLaunchEnvironment.values[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV])
    ) {
      throw new Error('Pi qualified request auth requires the pre-materialized child capability');
    }
    await retireLegacyPiRequestAuthAssets({
      rootDir: dirname(agentDir),
      agentDir,
      retainCurrent: requestAuthEnabled,
    });
    if (requestAuthEnabled) {
      await ensurePiRequestAuthExtensionAsset(agentDir, requestAuthPurposes);
    }
    // A qualified launch owns the exact Pi auth surface. Replacing even with
    // an empty object prevents stale native/provider credentials from
    // satisfying a request-auth-only binding.
    await replacePiAuthConfig({ agentDir, entries: directAuth });

    const launchEnvironment = mergeQualifiedLaunchEnvironment({
      source: sourceLaunchEnvironment,
      direct: directEnvironment,
      remove: [
        ...PI_DIRECT_AUTH_ENV_KEYS,
        ...(requestAuthEnabled
          ? []
          : [
            PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
            PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
          ]),
      ],
    });
    return Object.freeze({
      launchEnvironment,
      isInvalidated: () => invalidated,
      bind,
      async dispose() {
        disposeSubscriptions();
      },
    });
  } catch (error) {
    disposeSubscriptions();
    throw error;
  }
}
