import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPluginError, isRecord, PluginError, projectPluginFailureText, type LoggerService } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, type SecureTempDirectory } from '@happier-dev/plugin-sdk/fs';
import {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/protocol/agents/claude/connected-account-materialization';
import type {
  AgentExecutionRunRuntime,
  AgentExecutionRunEvent,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
  AgentSessionModelsSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildOpenCodeQualifiedAuthContent, materializeOpenCodeAuthEnvironment, type OpenCodeNativeAccountCredential } from './materialize/index.js';
import type { OpenCodeConfigPart } from '../../runtime/server/opencodeConfigContent.js';
import { OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV } from './requestAuth/env.js';
import { OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES } from './requestAuth/purposes.js';
import { buildOpenCodeConfigLaunchEnvironment } from '../../runtime/server/spawnSpec.js';
import { normalizeOpenCodePromptConfigUpdate } from '../../runtime/server/promptConfig.js';
import {
  OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_PURPOSE_IDS,
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS,
  OPEN_CODE_NATIVE_AUTH_ENV_KEYS,
  OPEN_CODE_NATIVE_ACCOUNT_DESCRIPTORS,
  openCodeAccountProviders,
  isOpenCodeNativeProvider,
  OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  type OpenCodeConnectedAccountPurposeId,
  type OpenCodeNativeConnectedAccountPurposeId,
  type OpenCodeRequestAuthProvider,
  type OpenCodeNativeProvider,
} from './purposes.js';

type Binding = Awaited<ReturnType<
  AgentRuntimeContext['services']['connectedAccounts']['getBinding']
>>;

type OpenCodeAccountLaunchRequest = Pick<AgentSessionOpenRequest, 'launchEnvironment' | 'providerBinding' | 'configuration'>;
type OpenCodeAccountLaunchContext = Readonly<{
  signal?: AbortSignal;
  catalogObservation?: true;
  services: Readonly<{ connectedAccounts: Pick<AgentRuntimeContext['services']['connectedAccounts'], 'getBinding' | 'materialize' | 'watch'>;
    logger?: Pick<LoggerService, 'warn'> }>;
}>;

export type PreparedOpenCodeQualifiedConnectedAccounts<
  Request extends OpenCodeAccountLaunchRequest,
> = Readonly<{
  request: Request;
  catalogConfidence?: AgentSessionModelsSnapshot['catalogConfidence'];
  isInvalidated(): boolean;
  bindSession(session: AgentSessionRuntime): AgentSessionRuntime;
  bindExecutionRun(runtime: AgentExecutionRunRuntime): AgentExecutionRunRuntime;
  dispose(): Promise<void>;
  disposeAfterFailure(): Promise<void>;
}>;

function assertExpectedBinding(
  purpose: OpenCodeConnectedAccountPurposeId,
  binding: Binding,
): binding is NonNullable<Binding> {
  if (!binding) return false;
  const expected = OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.find(
    ({ declaration }) => declaration.purpose === purpose,
  )!.declaration.service;
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

function mergeQualifiedLaunchEnvironment<Request extends OpenCodeAccountLaunchRequest>(input: Readonly<{
  request: Request;
  authContent: string;
  requestAuthEnvironment?: Awaited<ReturnType<typeof materializeOpenCodeAuthEnvironment>>;
  nativeEnvironment: Readonly<Record<string, string>>;
  nativeConfig?: OpenCodeConfigPart;
}>): Request {
  const launchValues = {
    ...(input.request.launchEnvironment?.values ?? {}),
    ...input.requestAuthEnvironment?.env,
  };
  const configParts = [
    ...(input.requestAuthEnvironment?.configPart ? [input.requestAuthEnvironment.configPart] : []),
    ...(input.nativeConfig ? [input.nativeConfig] : []),
  ];
  const values = { ...(configParts.length > 0
    ? buildOpenCodeConfigLaunchEnvironment(launchValues, configParts)
    : launchValues) };
  for (const key of OPEN_CODE_NATIVE_AUTH_ENV_KEYS) delete values[key];
  Object.assign(values, {
    OPENCODE_AUTH_CONTENT: input.authContent,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ...input.nativeEnvironment,
  });
  const valueKeys = new Set(Object.keys(values));
  const unset = new Set(
    (input.request.launchEnvironment?.unset ?? []).filter((key) => !valueKeys.has(key)),
  );
  for (const key of OPEN_CODE_NATIVE_AUTH_ENV_KEYS) if (!valueKeys.has(key)) unset.add(key);
  return Object.freeze({
    ...input.request,
    launchEnvironment: Object.freeze({
      values: Object.freeze(values),
      unset: Object.freeze([...unset]),
    }),
  });
}

function modelSelectionRequired(): PluginError {
  return new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Choose a model for the selected OpenCode Connected Account provider.',
    details: { failureCause: { code: 'opencode_connected_account_model_required',
      phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
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

export async function prepareOpenCodeQualifiedConnectedAccounts<Request extends OpenCodeAccountLaunchRequest>(
  request: Request,
  context: OpenCodeAccountLaunchContext,
): Promise<PreparedOpenCodeQualifiedConnectedAccounts<Request>> {
  // A Provider binding is the complete model credential authority. Selected
  // native OpenCode accounts must not be consulted or merged into that launch.
  if (request.providerBinding !== undefined) {
    return Object.freeze({
      request,
      isInvalidated: () => context.signal?.aborted === true,
      bindSession: (session) => session,
      bindExecutionRun: (runtime) => runtime,
      async dispose() {},
      async disposeAfterFailure() {},
    });
  }
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  let invalidated = false;
  let disposed = false;
  let requestAuthAssets: SecureTempDirectory | undefined;
  const initialObservations = new Map<OpenCodeConnectedAccountPurposeId, Promise<void>>();
  const resolveInitial = new Map<OpenCodeConnectedAccountPurposeId, () => void>();

  const retirePurposeObservations = (): void => {
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
  };
  const dispose = async (): Promise<void> => {
    disposed = true;
    retirePurposeObservations();
    const assets = requestAuthAssets;
    requestAuthAssets = undefined;
    assets?.cleanup();
  };
  const disposeAfterFailure = async (): Promise<void> => {
    try {
      await dispose();
    } catch (error) {
      // Catalog preflight has no diagnostic sink. Runtime cleanup uses the
      // existing host logger without replacing the primary launch failure.
      try {
        context.services.logger?.warn('OpenCode account cleanup failed after a primary failure', {
          error: projectPluginFailureText(error),
        });
      } catch { /* Diagnostic delivery cannot replace the primary failure. */ }
    }
  };
  const invalidate = async (): Promise<void> => {
    invalidated = true;
  };

  try {
    for (const purpose of OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_PURPOSE_IDS) {
      initialObservations.set(purpose, new Promise<void>((resolve) => {
        resolveInitial.set(purpose, resolve);
      }));
      let initial = true;
      subscriptions.push(context.services.connectedAccounts.watch(purpose, (event) => {
        if (initial) {
          initial = false;
          resolveInitial.get(purpose)?.();
          resolveInitial.delete(purpose);
          return;
        }
        if (!event.authorityChanged) return;
        return invalidate();
      }));
    }
    await waitForInitialPurposeObservations(initialObservations.values(), context.signal);

    const bindingEntries = await Promise.all(
      OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_PURPOSE_IDS.map(async (purpose) => [
        purpose,
        await context.services.connectedAccounts.getBinding(
          purpose,
          { signal: context.signal, observation: true },
        ),
      ] as const),
    );
    const bindings = Object.fromEntries(bindingEntries) as Record<
      OpenCodeNativeConnectedAccountPurposeId,
      Binding
    >;
    for (const purpose of OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_PURPOSE_IDS) {
      assertExpectedBinding(purpose, bindings[purpose]);
    }
    const openAiCodexBinding = bindings[OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID];
    const openAiBinding = bindings[OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID];
    const anthropicRequestAuthBinding = bindings[OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID];
    const anthropicBinding = bindings[OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID];

    const hasSelectedAccount = bindingEntries.some(([, binding]) => Boolean(binding));
    const selectedModel = normalizeOpenCodePromptConfigUpdate({ modelId: request.configuration?.model.value }).model;
    // Session/Run launches need a concrete model of the selected Account provider;
    // native saved/default models may target another provider. Catalog observation
    // prepares credentials before the person can choose a model.
    if (!context.catalogObservation && hasSelectedAccount && (!selectedModel || !OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.some(
      (row) => bindings[row.declaration.purpose] && openCodeAccountProviders(row).some(provider => provider === selectedModel.providerID),
    ))) {
      throw modelSelectionRequired();
    }

    const directAccountCredentials: Partial<Record<OpenCodeNativeProvider, OpenCodeNativeAccountCredential>> = {};
    const nativeEnvironment: Record<string, string> = {};
    const requiredRequestAuthProviders: OpenCodeRequestAuthProvider[] = [];

    if (openAiCodexBinding) {
      requiredRequestAuthProviders.push('openai');
    } else if (openAiBinding) {
      const materialized = await context.services.connectedAccounts.materialize(
        OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        { signal: context.signal, expectedAccount: openAiBinding.account },
      );
      directAccountCredentials.openai = { key: readExactEnvironmentValue(
        OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
        materialized,
        'OPENAI_API_KEY',
      ), service: openAiBinding.service };
    }

    if (anthropicRequestAuthBinding) {
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
        directAccountCredentials.anthropic = { key: setupToken, service: anthropicRequestAuthBinding.service };
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
      const materialized = await context.services.connectedAccounts.materialize(
        OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
        { signal: context.signal, expectedAccount: anthropicBinding.account },
      );
      directAccountCredentials.anthropic = { key: readExactEnvironmentValue(
        OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
        materialized,
        'ANTHROPIC_API_KEY',
      ), service: anthropicBinding.service };
    }

    for (const row of OPEN_CODE_NATIVE_ACCOUNT_DESCRIPTORS) {
      const purpose = row.declaration.purpose;
      const binding = bindings[purpose];
      if (!binding) continue;
      const result = await context.services.connectedAccounts.materialize(purpose,
        { kind: 'environment', keys: [...row.environmentKeys] },
        { signal: context.signal, expectedAccount: binding.account });
      if (result.kind !== 'environment') throw new Error(`OpenCode ${purpose} returned an invalid environment materialization`);
      const key = result.env[row.nativeEnvironmentAuth.key];
      if (row.provider === 'google' && !key?.trim()) {
        if (selectedModel?.providerID === 'google') throw modelSelectionRequired();
        const files = await context.services.connectedAccounts.materialize(purpose,
          { kind: 'files', fileIds: ['google-service-account.json'] },
          { signal: context.signal, expectedAccount: binding.account });
        if (files.kind !== 'files' || !files.files['google-service-account.json']) {
          throw new Error('OpenCode Gemini did not materialize service-account ADC');
        }
        context.signal?.throwIfAborted();
        requestAuthAssets ??= createSecureTempDirectorySync({ prefix: 'opencode-account-auth' });
        const path = join(requestAuthAssets.path, 'google-service-account.json');
        await writeFile(path, files.files['google-service-account.json'], { mode: 0o600 });
        Object.assign(nativeEnvironment, result.env, { GOOGLE_APPLICATION_CREDENTIALS: path });
        directAccountCredentials['google-vertex'] = { service: binding.service };
        continue;
      }
      if (!key?.trim()) throw new Error(`OpenCode ${purpose} did not materialize ${row.nativeEnvironmentAuth.key}`);
      if (row.provider === 'google' && selectedModel?.providerID === 'google-vertex') throw modelSelectionRequired();
      const provider = openCodeAccountProviders(row).find(provider => provider === selectedModel?.providerID) ?? row.provider;
      const baseURL = 'baseURLKey' in row.nativeEnvironmentAuth ? result.env[row.nativeEnvironmentAuth.baseURLKey] : undefined;
      if ('baseURLKey' in row.nativeEnvironmentAuth && !baseURL?.trim()) throw new Error(`OpenCode ${purpose} did not materialize its native endpoint`);
      directAccountCredentials[provider] = { key, service: binding.service, ...(baseURL ? { baseURL } : {}) };
    }

    let requestAuthEnvironment: Awaited<ReturnType<typeof materializeOpenCodeAuthEnvironment>> | undefined;
    if (requiredRequestAuthProviders.length > 0) {
      const capabilityPath = request.launchEnvironment?.values[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV];
      if (!capabilityPath?.trim()) {
        throw new Error('OpenCode request-auth materialization requires the host child capability');
      }
      context.signal?.throwIfAborted();
      requestAuthAssets ??= createSecureTempDirectorySync({ prefix: 'opencode-request-auth' });
      // The host has already selected and authorized these purposes. Materialize
      // only native transport assets here; OAuth bytes stay with request auth.
      requestAuthEnvironment = await materializeOpenCodeAuthEnvironment({
        rootDir: requestAuthAssets.path,
        materializationId: requestAuthAssets.path,
        connectedAccountMaterializationAuthority: 'qualified',
        requestAuth: {
          capabilityPath,
          purposeBindings: requiredRequestAuthProviders.map((provider) => {
            const declaredPurpose = OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES[provider];
            const purpose = declaredPurpose.purpose;
            return {
              purpose: declaredPurpose,
              target: { kind: 'account', account: bindings[purpose]!.account },
            };
          }),
        },
      });
      context.signal?.throwIfAborted();
    }
    const qualifiedAuth = hasSelectedAccount ? buildOpenCodeQualifiedAuthContent({
      baseAuthContent: requestAuthEnvironment?.env.OPENCODE_AUTH_CONTENT,
      directAccountCredentials,
      requiredRequestAuthProviders,
    }) : null;
    const preparedRequest = qualifiedAuth
      ? mergeQualifiedLaunchEnvironment({
          request,
          authContent: qualifiedAuth.authContent,
          requestAuthEnvironment,
          nativeEnvironment,
          nativeConfig: qualifiedAuth.configPart,
        })
      : request;

    function projectNativeAccountFailure<Event extends AgentSessionRuntimeEvent | AgentExecutionRunEvent>(event: Event): Event {
      if (disposed || context.signal?.aborted || !qualifiedAuth
        || (event.kind !== 'turn-failed' && event.kind !== 'run-failed')) return event;
      const diagnostic = event.diagnostic;
      if (!diagnostic || !isRecord(diagnostic.details)) return event;
      const evidence = diagnostic.details.nativeProviderFailure;
      if (!isRecord(evidence) || evidence.httpStatus !== 429
        || !isOpenCodeNativeProvider(evidence.providerId)) return event;
      const service = qualifiedAuth.nativeAccountServicesByProvider[evidence.providerId];
      if (!service) return event; // Proxy slots already report exact failures at their request-auth leaf.
      const classification = {
        kind: 'rate_limit', limitCategory: 'rate_limit', quotaScope: 'unknown',
        serviceId: `${service.pluginId}/${service.localId}`, profileId: null, groupId: null,
        resetsAtMs: null, retryAfterMs: null, planType: null, rateLimits: null,
        source: 'structured_provider_error',
      };
      return { ...event, diagnostic: { ...diagnostic, details: {
        ...diagnostic.details, runtimeAuthClassification: AgentRuntimeJsonValueSchema.parse(classification),
      } } };
    }
    const hasDirectAccountSource = qualifiedAuth
      && Object.keys(qualifiedAuth.nativeAccountServicesByProvider).length > 0;

    return Object.freeze({
      request: preparedRequest,
      ...(hasSelectedAccount ? { catalogConfidence: 'account_unverified' as const } : {}),
      isInvalidated: () => invalidated || context.signal?.aborted === true,
      bindSession(session) {
        let sessionDisposed = false;
        const watch: AgentSessionRuntime['watch'] = listener => session.watch(event => listener(projectNativeAccountFailure(event)));
        const preparedSession: AgentSessionRuntime = {
          ...session,
          watch: hasDirectAccountSource ? watch : session.watch,
          async dispose(reason) {
            if (sessionDisposed) return;
            sessionDisposed = true;
            disposed = true;
            retirePurposeObservations();
            try {
              await session.dispose(reason);
            } catch (error) {
              await disposeAfterFailure();
              throw error;
            }
            await dispose();
          },
        };
        // Startup already passed admission; observations govern the next open.
        return preparedSession;
      },
      bindExecutionRun(runtime) {
        // The admitted run retains its source and assets until explicit disposal.
        retirePurposeObservations();
        let runtimeDisposed = false;
        const watch: AgentExecutionRunRuntime['watch'] = listener => runtime.watch(event => listener(projectNativeAccountFailure(event)));
        const preparedRuntime: AgentExecutionRunRuntime = {
          ...runtime,
          watch: hasDirectAccountSource ? watch : runtime.watch,
          async dispose() {
            if (runtimeDisposed) return;
            runtimeDisposed = true;
            disposed = true;
            retirePurposeObservations();
            try {
              await runtime.dispose();
            } catch (error) {
              await disposeAfterFailure();
              throw error;
            }
            await dispose();
          },
        };
        return preparedRuntime;
      },
      dispose,
      disposeAfterFailure,
    });
  } catch (error) {
    await disposeAfterFailure();
    throw error;
  }
}
