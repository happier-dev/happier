import { dirname, join } from 'node:path';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/protocol/agents/claude/connected-account-materialization';
import type {
  AgentLaunchEnvironment,
  AgentRuntimeContext,
  AgentSessionRuntime,
  AgentSessionOpenRequest,
  AgentExecutionRunOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { replacePiAuthConfig, replacePiNativeModelsConfig } from '../auth/services/authConfig.js';
import { PI_CONNECTED_ACCOUNT_MODEL_ENV, PI_DIRECT_AUTH_ENV_KEYS } from '../launchEnvironment.js';
import { parsePiModelId } from '../models/catalog.js';
import {
  PI_ANTHROPIC_API_KEY_PURPOSE_ID,
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES,
  PI_NATIVE_CONNECTED_ACCOUNT_PURPOSES,
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

const ANTHROPIC_API_KEY_ENV_KEY = 'ANTHROPIC_API_KEY';

type ConnectedAccounts = AgentRuntimeContext['services']['connectedAccounts'];
type ConnectedAccountBinding = Awaited<ReturnType<ConnectedAccounts['getBinding']>>;

export type PreparedPiQualifiedConnectedAccounts = Readonly<{
  launchEnvironment: AgentLaunchEnvironment;
  isInvalidated(): boolean;
  bind(runtime: AgentSessionRuntime): AgentSessionRuntime;
  bindExecutionRun<T extends Readonly<{ dispose(): void | Promise<void> }>>(runtime: T): T;
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
  request?: Pick<AgentSessionOpenRequest | AgentExecutionRunOpenRequest, 'kind' | 'configuration' | 'providerBinding'>;
  context: Readonly<{
    signal: AbortSignal;
    services: Readonly<{ connectedAccounts: Pick<ConnectedAccounts, 'getBinding' | 'materialize' | 'watch'> }>;
  }>;
}>): Promise<PreparedPiQualifiedConnectedAccounts> {
  // A Provider binding supplies the complete inference authority and native
  // configuration. Connected Accounts must not replace its admitted source.
  if (input.request?.providerBinding !== undefined) {
    return Object.freeze({
      launchEnvironment: input.launchEnvironment ?? Object.freeze({ values: Object.freeze({}), unset: Object.freeze([]) }),
      isInvalidated: () => input.context.signal.aborted,
      bind: (runtime) => runtime,
      bindExecutionRun: (runtime) => runtime,
      async dispose() {},
    });
  }
  const { connectedAccounts } = input.context.services;
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  const initialObservations: Promise<void>[] = [];
  let invalidated = false;
  let subscriptionsDisposed = false;

  const disposeSubscriptions = (): void => {
    if (subscriptionsDisposed) return;
    subscriptionsDisposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  const invalidate = async (): Promise<void> => {
    invalidated = true;
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
    // Native startup already passed admission; later observations govern the next open.
    return wrapped;
  };
  const bindExecutionRun = <T extends Readonly<{ dispose(): void | Promise<void> }>>(runtime: T): T => {
    // A finite run owns its admitted credential snapshot until explicit disposal.
    disposeSubscriptions();
    let disposed = false;
    const wrapped = {
      ...runtime,
      async dispose() {
        if (disposed) return;
        disposed = true;
        disposeSubscriptions();
        await runtime.dispose();
      },
    } as T;
    return wrapped;
  };

  try {
    for (const declaration of PI_NATIVE_CONNECTED_ACCOUNT_PURPOSES) {
      let resolveInitial!: () => void;
      initialObservations.push(new Promise<void>((resolve) => {
        resolveInitial = resolve;
      }));
      let initial = true;
      subscriptions.push(connectedAccounts.watch(declaration.purpose, (event) => {
        if (initial) {
          initial = false;
          resolveInitial();
          return;
        }
        if (!event.authorityChanged) return;
        return invalidate();
      }));
    }
    await waitForInitialPurposeObservations(
      initialObservations,
      input.context.signal,
    );
    const bindings = await Promise.all(
      PI_NATIVE_CONNECTED_ACCOUNT_PURPOSES.map(async (declaration) => {
        const binding = await connectedAccounts.getBinding(
          declaration.purpose,
          { signal: input.context.signal, observation: true },
        );
        assertExpectedBinding(binding, declaration);
        return { purpose: declaration.purpose, binding };
      }),
    );
    const bindingFor = (purpose: string) => bindings.find((entry) => entry.purpose === purpose)?.binding ?? null;
    const claudeSubscription = bindingFor(PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID);
    const openaiCodex = bindingFor(PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID);
    const anthropic = bindingFor(PI_ANTHROPIC_API_KEY_PURPOSE_ID);
    // Pi's authenticated registry advertises candidates, not ChatGPT account
    // entitlement. A fresh launch must not silently pick an arbitrary candidate.
    const selectedModel = input.request?.configuration?.model;
    if (openaiCodex && input.request && input.request.kind !== 'resume'
      && (!readNonBlank(selectedModel?.value) || selectedModel?.value === 'default')) {
      throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
        message: 'Choose an explicit model for the Pi ChatGPT Connected Account. Its native catalog does not establish account entitlement.',
        details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
          phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
    }
    if (claudeSubscription && anthropic) {
      throw new Error('Pi cannot bind Claude Subscription and direct Anthropic credentials simultaneously');
    }

    const anyBound = bindings.some(({ binding }) => binding !== null);
    const sourceLaunchEnvironment: AgentLaunchEnvironment = input.launchEnvironment ?? Object.freeze({
      values: Object.freeze({}),
      unset: Object.freeze([]),
    });
    if (!anyBound) {
      return Object.freeze({
        launchEnvironment: sourceLaunchEnvironment,
        isInvalidated: () => invalidated,
        bind,
        bindExecutionRun,
        async dispose() {
          disposeSubscriptions();
        },
      });
    }

    const agentDir = readNonBlank(sourceLaunchEnvironment.values.PI_CODING_AGENT_DIR);
    if (!agentDir) {
      const message = 'Pi qualified Connected Account launch requires the pre-materialized agent dir';
      throw new PluginError({ code: 'agent_startup_invalid_state', retryable: false, message,
        details: { failureCause: { code: 'agent_startup_invalid_state', phase: 'client_start',
          failureReason: 'unclassified_provider_error', providerErrorMessage: message } },
      });
    }

    const directEnvironment: Record<string, string> = {};
    const directAuth: Record<string, Readonly<{ type: 'api_key'; key: string }>
      | Readonly<{ type: 'oauth'; refresh: string; access: string; expires: number }>> = {};
    const nativeProviders = new Set<string>();
    const nativeModels: Record<string, Parameters<typeof replacePiNativeModelsConfig>[0]['providers'][string]> = {};
    let requiresExplicitModel = false;
    const requestAuthPurposes: {
      -readonly [K in keyof PiRequestAuthPurposeMap]?: NonNullable<PiRequestAuthPurposeMap[K]>;
    } = {};

    if (claudeSubscription) {
      try {
        const materialized = await connectedAccounts.materialize(
          PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
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
    for (const declaration of PI_NATIVE_CONNECTED_ACCOUNT_PURPOSES) {
      const binding = bindingFor(declaration.purpose);
      if (!binding) continue;
      const native = declaration.native;
      nativeProviders.add(native.providerId);
      if (!('environmentKeys' in native)) continue;
      requiresExplicitModel ||= !('startupModel' in native);
      const materialized = await connectedAccounts.materialize(declaration.purpose,
        { kind: 'environment', keys: [...native.environmentKeys] },
        { signal: input.context.signal, expectedAccount: binding.account });
      if (materialized.kind !== 'environment') throw new Error(`Pi purpose ${declaration.purpose} expected environment materialization`);
      // The service owns credential mode and decoding; the receiver only serializes native destinations.
      const apiKey = readNonBlank(materialized.env[native.apiKeyEnvironmentKey]);
      if ('serviceAccount' in native && !apiKey) {
        const serviceAccount = native.serviceAccount;
        const files = await connectedAccounts.materialize(declaration.purpose,
          { kind: 'files', fileIds: [serviceAccount.fileId] },
          { signal: input.context.signal, expectedAccount: binding.account });
        const bytes = files.kind === 'files' ? files.files[serviceAccount.fileId] : undefined;
        if (!bytes || !readNonBlank(materialized.env.GOOGLE_CLOUD_PROJECT)
          || !readNonBlank(materialized.env.GOOGLE_CLOUD_LOCATION)) throw new Error('Pi Vertex credentials are unavailable');
        const path = join(agentDir, serviceAccount.fileId);
        await writeAtomicFile({ path, contents: bytes, mode: 0o600 });
        Object.assign(directEnvironment, materialized.env, { [serviceAccount.environmentKey]: path });
        nativeProviders.delete(native.providerId);
        nativeProviders.add(serviceAccount.providerId);
      } else {
        if (!apiKey) throw new Error(`Pi purpose ${declaration.purpose} did not materialize its native credential`);
        if ('oauthExchange' in native) {
          // Pi owns the GitHub-to-Copilot exchange and account model catalog.
          // Never send the GitHub grant as an inference bearer via its API-key slot.
          directAuth[native.providerId] = { type: 'oauth', refresh: apiKey, access: '', expires: 0 };
        } else {
          Object.assign(directEnvironment, materialized.env);
          directAuth[native.providerId] = { type: 'api_key', key: apiKey };
        }
      }
      if ('baseUrlEnvironmentKey' in native) {
        const baseUrl = readNonBlank(materialized.env[native.baseUrlEnvironmentKey]);
        if (!baseUrl) throw new Error('Pi native provider base URL is unavailable');
        nativeModels[native.providerId] = { ...nativeModels[native.providerId], baseUrl };
      }
    }
    if (requiresExplicitModel && input.request) {
      const model = readNonBlank(selectedModel?.value);
      const selection = model ? parsePiModelId(model) : null;
      if ((!selection || !selection.provider || !selection.modelId
        || !nativeProviders.has(selection.provider))
        && !(input.request.kind === 'resume' && (!model || model === 'default'))) {
        throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
          message: 'Choose an explicit model from a selected Pi Connected Account provider.',
          details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
            phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
      }
      if (model && model !== 'default') directEnvironment[PI_CONNECTED_ACCOUNT_MODEL_ENV] = model;
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
    if (Object.keys(nativeModels).length > 0) await replacePiNativeModelsConfig({ agentDir, providers: nativeModels });

    const launchEnvironment = mergeQualifiedLaunchEnvironment({
      source: sourceLaunchEnvironment,
      direct: directEnvironment,
      remove: [
        ...PI_DIRECT_AUTH_ENV_KEYS,
        PI_CONNECTED_ACCOUNT_MODEL_ENV,
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
      bindExecutionRun,
      async dispose() {
        disposeSubscriptions();
      },
    });
  } catch (error) {
    disposeSubscriptions();
    throw error;
  }
}
