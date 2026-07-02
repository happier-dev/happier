import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import {
  resolveRecoverableTurnFailureRetryDecision,
  resolveRecoverableTurnFailureSecondFailure,
} from '@happier-dev/agents';
import type {
  InternalRuntimeTurnOperationsV1,
} from '@happier-dev/plugin-sdk/internal/runtime/session';
import {
  buildProviderAccountUsageRecordId,
  buildProviderAccountUsageOpaqueLocalCredentialRef,
  type ProviderAccountUsageRecordKeyV1,
  type RuntimeEventV1,
} from '@happier-dev/protocol';

import { readCodexAuthStoreProviderAccountId } from '../../auth/services/runtime/auth/accountId.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../auth/services/quota/runtimeRateLimits.js';
import { resolveCodexUsageSubjectRef } from '../../auth/services/usage/identity.js';
import {
  type CodexProviderAccountUsageAliasInput,
  mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot,
} from '../../auth/services/usage/snapshot.js';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../protocol/runtimeDescriptorV1.js';
import {
  createCodexAppServerClient,
  isCodexAppServerOversizedJsonFrameError,
  resolveCodexHome,
  type CodexAppServerRequestOptions,
  type DisposableCodexAppServerClient,
} from './client.js';
import { readCodexAppServerResumeRecoveryTimeoutMs } from './client/timeout.js';
import { buildCodexAppServerConfigOverrides } from './config/overrides.js';
import {
  buildCodexAppServerLegacyPermissionParams,
  buildCodexAppServerPermissionParams,
  shouldRetryWithoutCodexAppServerPermissionProfile,
  type CodexAppServerPermissionSupport,
  type CodexAppServerPermissionTarget,
} from './permissionProfile.js';
import { buildCodexAppServerTurnInput } from './turnInput.js';
import {
  createCodexAppServerTurnFailure,
  isCodexAppServerTemporaryRecoverableTurnFailureError,
} from './turns/failure.js';
import {
  buildThreadConfigOverrideParams,
  buildThreadServiceTierParams,
  isCodexTurnInterruptedStatus,
  readCodexTurnStatus,
  readModelId,
  readProviderEventTurnId,
  readServiceTier,
  readThreadId,
  readTurnId,
  trimSessionId,
  trimStringValue,
} from './wire/fields.js';

export type CodexAppServerPolicy = Readonly<{
  approvalPolicy?: unknown;
  approvalsReviewer?: string;
  sandboxPolicy?: unknown;
  sandbox?: unknown;
}>;

type CodexAppServerMcpServerConfig = Readonly<{
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

export type CodexAppServerStartOrLoadOptions = Readonly<{
  resumeId?: string | null;
  existingSessionId?: string | null;
  importHistory?: boolean;
  preserveRequestedThreadId?: boolean;
}>;

export type CodexAppServerRuntime = InternalRuntimeTurnOperationsV1 & Readonly<{
  probeTurnLiveness(): Readonly<{
    active: boolean;
    lastActivityAtMs: number | null;
    diagnostics: Readonly<Record<string, unknown>>;
  }>;
}>;

type PendingTurn = {
  threadId: string;
  sessionTurnId: string;
  providerTurnId: string | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type CodexAppServerRuntimeParams = Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
  mcpServers?: unknown;
  resolveCurrentPolicy?: () => CodexAppServerPolicy | null;
  setThinking?: (thinking: boolean) => void;
}>;

const CODEX_TEMPORARY_RECOVERABLE_TURN_CONTINUATION_PROMPT =
  'Please continue the interrupted work from the recovered Codex turn. Do not restart or repeat completed work.';
const CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT_ENV_KEY = 'HAPPIER_CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = readRecord(value);
  if (!record) return {};
  const output: Record<string, string> = {};
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') output[key] = child;
  }
  return output;
}

function normalizeContinuationPrompt(value: unknown): string | null {
  const prompt = trimStringValue(value);
  return prompt && prompt.length <= 4000 ? prompt : null;
}

function resolveTemporaryRecoverableTurnContinuationPrompt(params: CodexAppServerRuntimeParams): string {
  const env = {
    ...params.ctx.env.list(),
    ...(params.processEnv ?? {}),
  };
  return normalizeContinuationPrompt(env[CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT_ENV_KEY])
    ?? CODEX_TEMPORARY_RECOVERABLE_TURN_CONTINUATION_PROMPT;
}

type CodexProviderAccountUsageAliasContext = Awaited<
  ReturnType<PluginContextV1['accountUsage']['resolveAliasContext']>
>;

function buildCodexProviderAccountUsageAlias(input: Readonly<{
  aliasContext: CodexProviderAccountUsageAliasContext;
  happierSessionId: string;
  codexHome: string;
}>): CodexProviderAccountUsageAliasInput {
  if (input.aliasContext?.serviceId === 'openai-codex' && input.aliasContext.profileId) {
    if (input.aliasContext.groupId) {
      return {
        kind: 'connectedServiceGroupMember',
        serviceId: 'openai-codex',
        profileId: input.aliasContext.profileId,
        groupId: input.aliasContext.groupId,
      };
    }
    return {
      kind: 'connectedServiceProfile',
      serviceId: 'openai-codex',
      profileId: input.aliasContext.profileId,
    };
  }
  return {
    kind: 'appServerNative',
    sessionId: input.happierSessionId,
    localCredentialRef: buildProviderAccountUsageOpaqueLocalCredentialRef({
      providerId: 'openai-codex',
      kind: 'appServerNative',
      value: input.codexHome,
    }),
  };
}

function buildCodexProviderAccountUsageProvisionalDiscriminator(input: Readonly<{
  alias: CodexProviderAccountUsageAliasInput;
  happierSessionId: string;
  codexHome: string;
}>): string {
  if (input.alias.kind === 'connectedServiceGroupMember') {
    return `connected-service-group:${input.alias.serviceId}:${input.alias.groupId}:${input.alias.profileId}`;
  }
  if (input.alias.kind === 'connectedServiceProfile') {
    return `connected-service-profile:${input.alias.serviceId}:${input.alias.profileId}`;
  }
  return `${input.happierSessionId}:${input.codexHome}`;
}

function normalizeMcpServers(value: unknown): Readonly<Record<string, CodexAppServerMcpServerConfig>> {
  const record = readRecord(value);
  if (!record) return {};
  const output: Record<string, CodexAppServerMcpServerConfig> = {};
  for (const [name, rawConfig] of Object.entries(record)) {
    const config = readRecord(rawConfig);
    const command = trimStringValue(config?.command);
    if (!command) continue;
    output[name] = {
      command,
      args: Array.isArray(config?.args)
        ? config.args.filter((arg): arg is string => typeof arg === 'string')
        : [],
      env: readStringRecord(config?.env),
    };
  }
  return output;
}

function readResumeId(options: Readonly<Record<string, unknown>> | undefined): string | null {
  return trimStringValue(options?.resumeId)
    ?? trimStringValue(options?.resumeSessionId)
    ?? trimStringValue(options?.sessionId);
}

function createPendingTurn(threadId: string, seq: number): PendingTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    threadId,
    sessionTurnId: `codex-turn-${seq}`,
    providerTurnId: null,
    promise,
    resolve,
    reject,
  };
}

function createErrorFromAppServerNotification(value: unknown): Error {
  return createCodexAppServerTurnFailure({ value });
}

function createCodexRuntimeEvent(
  happierSessionId: string,
  event: Omit<RuntimeEventV1, 'sessionId' | 'emittedAtMs'>,
): RuntimeEventV1 {
  return {
    ...event,
    sessionId: happierSessionId,
    emittedAtMs: Date.now(),
  } as RuntimeEventV1;
}

export function createCodexAppServerRuntime(
  params: CodexAppServerRuntimeParams,
): CodexAppServerRuntime {
  const temporaryRecoverableTurnContinuationPrompt = resolveTemporaryRecoverableTurnContinuationPrompt(params);
  const readRuntimeProcessEnv = (): Readonly<Record<string, string | undefined>> => ({
    ...params.ctx.env.list(),
    ...(params.processEnv ?? {}),
  });
  let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;
  let client: DisposableCodexAppServerClient | null = null;
  let threadId: string | null = null;
  let currentModelId: string | null = null;
  let currentReasoningEffort: string | null = null;
  let currentServiceTier: string | null = null;
  let hasServiceTierOverride = false;
  let permissionSupport: CodexAppServerPermissionSupport = 'unknown';
  let publishedThreadId: string | null = null;
  let turnSeq = 0;
  let pendingTurn: PendingTurn | null = null;
  let activeTurnHadMeaningfulActivity = false;
  let deferredTemporaryRecoverableFailure: Error | null = null;
  let terminalPendingTurnFailure: Error | null = null;
  let originalTemporaryRecoverableFailure: Error | null = null;
  let promptForTemporaryRecoverableRetry: string | null = null;
  let temporaryRecoverableRetryAttemptCount = 0;
  let active = false;
  let lastActivityAtMs: number | null = null;
  let disposed = false;
  const runtimeSubscribers = new Set<(event: RuntimeEventV1) => void>();

  const publishRuntimeEvent = (event: Omit<RuntimeEventV1, 'sessionId' | 'emittedAtMs'>): void => {
    const payload = createCodexRuntimeEvent(params.happierSessionId, event);
    for (const subscriber of runtimeSubscribers) subscriber(payload);
  };

  const recordProviderAccountUsageSnapshot = async (rawSnapshot: unknown): Promise<void> => {
    const service = params.ctx.accountUsage;
    if (!service || typeof service.recordSnapshot !== 'function') return;
    const env = readRuntimeProcessEnv();
    const codexHome = resolveCodexHome(env);
    const observedAtMs = Date.now();
    try {
      const aliasContext = typeof service.resolveAliasContext === 'function'
        ? await service.resolveAliasContext({ serviceId: 'openai-codex', env })
        : null;
      const alias = buildCodexProviderAccountUsageAlias({
        aliasContext,
        happierSessionId: params.happierSessionId,
        codexHome,
      });
      const provisionalDiscriminator = buildCodexProviderAccountUsageProvisionalDiscriminator({
        alias,
        happierSessionId: params.happierSessionId,
        codexHome,
      });
      const subject = resolveCodexUsageSubjectRef({
        authStoreProviderAccountIdProof: await readCodexAuthStoreProviderAccountId(codexHome),
        provisionalDiscriminator,
      });
      const snapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
        subject,
        rawSnapshot,
        observedAtMs,
        fetchedAtMs: observedAtMs,
        aliases: [alias],
      });
      const result = await service.recordSnapshot({ snapshot });
      if (result.status !== 'recorded') {
        params.ctx.logger?.debug?.('Codex app-server provider-account usage snapshot was not recorded', {
          status: result.status,
          reason: 'reason' in result ? result.reason : null,
        });
        return;
      }
      if (subject.kind === 'providerSubject' && typeof service.adoptProvisionalRecord === 'function') {
        const provisionalSubject = resolveCodexUsageSubjectRef({ provisionalDiscriminator });
        if (provisionalSubject.kind === 'provisionalLocalSubject') {
          const provisionalRecordKey: ProviderAccountUsageRecordKeyV1 = {
            providerId: 'openai-codex',
            accountSubjectId: provisionalSubject.accountSubjectId,
            subjectKind: 'unknown',
            quotaScope: 'account',
          };
          const adoptionResult = await service.adoptProvisionalRecord({
            adoption: {
              providerId: 'openai-codex',
              fromRecordId: buildProviderAccountUsageRecordId(provisionalRecordKey),
              toRecordId: snapshot.recordId,
              stableRecordKey: snapshot.recordKey,
              proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
              observedAtMs,
              aliases: snapshot.aliases,
            },
          });
          if (adoptionResult.status !== 'adopted' && adoptionResult.status !== 'already_adopted') {
            params.ctx.logger?.debug?.('Codex app-server provider-account usage adoption was not applied', {
              status: adoptionResult.status,
              reason: 'reason' in adoptionResult ? adoptionResult.reason : null,
            });
          }
        }
      }
    } catch (error) {
      params.ctx.logger?.debug?.('Codex app-server provider-account usage recording failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  const publishThreadIdentity = (nextThreadId: string): void => {
    const normalizedThreadId = trimSessionId(nextThreadId);
    if (!normalizedThreadId) return;
    threadId = normalizedThreadId;
    if (publishedThreadId === normalizedThreadId) return;
    publishedThreadId = normalizedThreadId;
    publishRuntimeEvent({
      kind: 'session-id-publish',
      publishedSessionId: normalizedThreadId,
      source: 'codex-app-server',
    });
    publishRuntimeEvent({
      kind: 'descriptor-update',
      descriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: normalizedThreadId,
      }),
    });
  };

  const setActive = (nextActive: boolean): void => {
    active = nextActive;
    lastActivityAtMs = Date.now();
    params.setThinking?.(nextActive);
  };

  const notificationMatchesPendingTurn = (notificationParams: unknown): boolean => {
    const activeTurn = pendingTurn;
    if (!activeTurn) return false;
    const notificationThreadId = readThreadId(notificationParams) ?? activeTurn.threadId;
    if (notificationThreadId !== activeTurn.threadId) return false;
    const providerTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams);
    return !providerTurnId || !activeTurn.providerTurnId || providerTurnId === activeTurn.providerTurnId;
  };

  const readMeaningfulText = (notificationParams: unknown, keys: readonly string[]): string | null => {
    const record = readRecord(notificationParams);
    for (const key of keys) {
      const text = trimStringValue(record?.[key]);
      if (text) return text;
    }
    return null;
  };

  const isMeaningfulActivityNotification = (method: string, notificationParams: unknown): boolean => {
    if (method === 'item/agentMessage/delta') {
      return readMeaningfulText(notificationParams, ['delta', 'text']) !== null;
    }
    if (method === 'turn/diff/updated') {
      return readMeaningfulText(notificationParams, ['unifiedDiff', 'diff']) !== null;
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      return readMeaningfulText(notificationParams, ['delta', 'text']) !== null;
    }
    return true;
  };

  const markMeaningfulActivityFromNotification = (method: string, notificationParams: unknown): void => {
    if (!notificationMatchesPendingTurn(notificationParams)) return;
    if (!isMeaningfulActivityNotification(method, notificationParams)) return;
    activeTurnHadMeaningfulActivity = true;
  };

  const completePendingTurn = (status: 'completed' | 'interrupted', notificationParams: unknown): void => {
    const activeTurn = pendingTurn;
    if (!activeTurn) return;
    const notificationThreadId = readThreadId(notificationParams) ?? activeTurn.threadId;
    if (notificationThreadId !== activeTurn.threadId) return;
    const providerTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams)
      ?? activeTurn.providerTurnId;
    if (providerTurnId && activeTurn.providerTurnId && providerTurnId !== activeTurn.providerTurnId) return;
    if (providerTurnId && !activeTurn.providerTurnId) {
      activeTurn.providerTurnId = providerTurnId;
      publishRuntimeEvent({
        kind: 'turn-provider-id-observed',
        turnId: activeTurn.sessionTurnId,
        providerTurnId,
      });
    }
    pendingTurn = null;
    terminalPendingTurnFailure = null;
    originalTemporaryRecoverableFailure = null;
    setActive(false);
    if (status === 'interrupted' || isCodexTurnInterruptedStatus(readCodexTurnStatus(notificationParams))) {
      publishRuntimeEvent({
        kind: 'turn-cancelled',
        turnId: activeTurn.sessionTurnId,
        ...(providerTurnId ? { providerTurnId } : {}),
      });
    } else {
      publishRuntimeEvent({
        kind: 'turn-complete',
        turnId: activeTurn.sessionTurnId,
        ...(providerTurnId ? { providerTurnId } : {}),
      });
    }
    activeTurn.resolve();
  };

  const failPendingTurn = (
    error: Error,
    options: Readonly<{ deferBackendError?: boolean }> = {},
  ): void => {
    const activeTurn = pendingTurn;
    if (!activeTurn) return;
    pendingTurn = null;
    setActive(false);
    if (options.deferBackendError !== true) {
      deferredTemporaryRecoverableFailure = null;
      terminalPendingTurnFailure = resolveTerminalPendingTurnFailure(error);
      publishRuntimeEvent({
        kind: 'backend-error',
        error: { message: terminalPendingTurnFailure.message },
      });
    } else {
      deferredTemporaryRecoverableFailure = error;
    }
    activeTurn.reject(error);
  };

  const shouldDeferTemporaryRecoverableFailure = (error: Error): boolean => {
    return isCodexAppServerTemporaryRecoverableTurnFailureError(error)
      && temporaryRecoverableRetryAttemptCount === 0;
  };

  const resolveTerminalPendingTurnFailure = (error: Error): Error => {
    const originalFailure = originalTemporaryRecoverableFailure;
    if (!originalFailure || !isCodexAppServerTemporaryRecoverableTurnFailureError(error)) {
      return error;
    }
    return resolveRecoverableTurnFailureSecondFailure({
      originalFailure,
      latestFailure: error,
    }).failure;
  };

  const attachClientHandlers = (nextClient: DisposableCodexAppServerClient): void => {
    nextClient.registerNotificationHandler('account/rateLimits/updated', (notificationParams) => {
      void recordProviderAccountUsageSnapshot(notificationParams);
    });
    nextClient.registerNotificationHandler('turn/started', (notificationParams) => {
      const activeTurn = pendingTurn;
      if (!activeTurn) return;
      const providerTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
        ?? readTurnId(notificationParams);
      if (!providerTurnId || activeTurn.providerTurnId === providerTurnId) return;
      activeTurn.providerTurnId = providerTurnId;
      publishRuntimeEvent({
        kind: 'turn-provider-id-observed',
        turnId: activeTurn.sessionTurnId,
        providerTurnId,
      });
    });
    nextClient.registerNotificationHandler('turn/completed', (notificationParams) => {
      const status = readCodexTurnStatus(notificationParams);
      if (status === 'failed') {
        const failure = createErrorFromAppServerNotification(notificationParams);
        failPendingTurn(failure, {
          deferBackendError: shouldDeferTemporaryRecoverableFailure(failure),
        });
        return;
      }
      completePendingTurn('completed', notificationParams);
    });
    nextClient.registerNotificationHandler('turn/interrupted', (notificationParams) => {
      completePendingTurn('interrupted', notificationParams);
    });
    nextClient.registerNotificationHandler('error', (notificationParams) => {
      const record = readRecord(notificationParams);
      if (record?.willRetry === true) return;
      const failure = createErrorFromAppServerNotification(notificationParams);
      failPendingTurn(failure, {
        deferBackendError: shouldDeferTemporaryRecoverableFailure(failure),
      });
    });
    for (const method of [
      'item/agentMessage/delta',
      'turn/diff/updated',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta',
      'item/started',
      'item/completed',
      'rawResponseItem/completed',
    ]) {
      nextClient.registerNotificationHandler(method, (notificationParams) => {
        markMeaningfulActivityFromNotification(method, notificationParams);
      });
    }
  };

  const ensureClient = async (): Promise<DisposableCodexAppServerClient> => {
    if (disposed) throw new Error('Codex app-server runtime has been disposed.');
    if (client) return client;
    if (!clientPromise) {
      const processEnv = readRuntimeProcessEnv();
      clientPromise = createCodexAppServerClient({
        exec: params.ctx.exec,
        cwd: params.directory,
        processEnv,
        configOverrides: buildCodexAppServerConfigOverrides(normalizeMcpServers(params.mcpServers)),
      }).then((createdClient) => {
        if (disposed) {
          void createdClient.dispose().catch(() => undefined);
          throw new Error('Codex app-server runtime has been disposed.');
        }
        client = createdClient;
        attachClientHandlers(createdClient);
        void readCodexRuntimeRateLimitsSnapshot(createdClient)
          .then((result) => recordProviderAccountUsageSnapshot(result.rawSnapshot))
          .catch(() => undefined);
        return createdClient;
      }, (error: unknown) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  };

  const startOrLoadSession = async (options?: Readonly<Record<string, unknown>>): Promise<string> => {
    const appServerClient = await ensureClient();
    const resumeId = readResumeId(options);
    const existingSessionId = trimStringValue(options?.existingSessionId);
    const requestedThreadId = resumeId ?? existingSessionId;
    if (requestedThreadId) {
      publishThreadIdentity(requestedThreadId);
    }
    const policy = params.resolveCurrentPolicy?.() ?? null;
    const permissionFields = buildCodexAppServerPermissionParams({
      policy,
      support: permissionSupport,
      target: 'thread',
    });
    const commonFields = {
      ...(currentModelId ? { model: currentModelId } : {}),
      ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
      ...buildThreadConfigOverrideParams(currentReasoningEffort),
      ...permissionFields,
    };
    const requestWithPermissionFallback = async (
      method: 'thread/start' | 'thread/resume',
      requestParams: Record<string, unknown>,
      target: CodexAppServerPermissionTarget,
      requestOptions?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
      try {
        const result = await appServerClient.request(method, requestParams, requestOptions);
        if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
          permissionSupport = 'supported';
        }
        return result;
      } catch (error) {
        if (!policy || !shouldRetryWithoutCodexAppServerPermissionProfile(error, requestParams)) {
          throw error;
        }
        permissionSupport = 'legacy';
        const retryParams = { ...requestParams };
        delete retryParams.permissions;
        return await appServerClient.request(method, {
          ...retryParams,
          ...buildCodexAppServerLegacyPermissionParams({ policy, target }),
        }, requestOptions);
      }
    };
    const readResumedThreadMetadata = async (
      nextThreadId: string,
      requestOptions?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
      const startedAt = Date.now();
      params.ctx.logger.debug('Reading lean Codex app-server thread metadata after oversized resume response', {
        threadId: nextThreadId,
        timeoutMs: requestOptions?.timeoutMs ?? null,
      });
      try {
        const result = await appServerClient.request('thread/read', {
          threadId: nextThreadId,
          includeTurns: false,
        }, requestOptions);
        params.ctx.logger.debug('Completed lean Codex app-server thread metadata read after oversized resume response', {
          threadId: nextThreadId,
          elapsedMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        params.ctx.logger.debug('Failed lean Codex app-server thread metadata read after oversized resume response', {
          threadId: nextThreadId,
          elapsedMs: Date.now() - startedAt,
          error,
        });
        throw error;
      }
    };
    const resumeThread = async (nextThreadId: string): Promise<unknown> => {
      const resumeRequestOptions = options?.importHistory === true
        ? undefined
        : { timeoutMs: readCodexAppServerResumeRecoveryTimeoutMs(readRuntimeProcessEnv()) };
      try {
        return await requestWithPermissionFallback('thread/resume', {
          threadId: nextThreadId,
          ...commonFields,
          persistExtendedHistory: true,
        }, 'thread', resumeRequestOptions);
      } catch (error) {
        if (options?.importHistory === true || !isCodexAppServerOversizedJsonFrameError(error)) {
          throw error;
        }
        return await readResumedThreadMetadata(nextThreadId, resumeRequestOptions);
      }
    };
    const response = requestedThreadId
      ? await resumeThread(requestedThreadId)
      : await requestWithPermissionFallback('thread/start', {
        cwd: params.directory,
        ...commonFields,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      }, 'thread');
    const nextThreadId = requestedThreadId && options?.preserveRequestedThreadId === true
      ? requestedThreadId
      : readThreadId(response) ?? requestedThreadId;
    if (!nextThreadId) {
      throw new Error('Codex app-server thread/start returned no thread id');
    }
    threadId = nextThreadId;
    currentModelId = readModelId(response) ?? currentModelId;
    currentServiceTier = readServiceTier(response) ?? (hasServiceTierOverride ? currentServiceTier : null);
    publishThreadIdentity(nextThreadId);
    return nextThreadId;
  };

  const ensureThreadId = async (requestedSessionId?: string | null): Promise<string> => {
    const requested = trimSessionId(requestedSessionId);
    if (threadId && (!requested || requested === threadId)) return threadId;
    return await startOrLoadSession(requested ? { existingSessionId: requested, importHistory: false } : undefined);
  };

  const startTurnPromptAttempt = async (prompt: string): Promise<void> => {
    const activeThreadId = await ensureThreadId();
    if (pendingTurn) throw new Error('Codex app-server already has a turn in flight');
    const appServerClient = await ensureClient();
    turnSeq += 1;
    const activeTurn = createPendingTurn(activeThreadId, turnSeq);
    pendingTurn = activeTurn;
    activeTurnHadMeaningfulActivity = false;
    deferredTemporaryRecoverableFailure = null;
    terminalPendingTurnFailure = null;
    void activeTurn.promise.catch(() => undefined);
    setActive(true);
    publishRuntimeEvent({
      kind: 'turn-start',
      turnId: activeTurn.sessionTurnId,
      startedBy: 'user',
    });
    try {
      const policy = params.resolveCurrentPolicy?.() ?? null;
      const requestParams: Record<string, unknown> = {
        ...buildCodexAppServerPermissionParams({
          policy,
          support: permissionSupport,
          target: 'turn',
        }),
        threadId: activeThreadId,
        input: buildCodexAppServerTurnInput({ text: prompt }),
        ...(currentModelId ? { model: currentModelId } : {}),
        ...(currentReasoningEffort ? { effort: currentReasoningEffort } : {}),
        ...(hasServiceTierOverride
          ? (currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null })
          : {}),
      };
      const response = await appServerClient.request('turn/start', requestParams)
        .then((result) => {
          if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
            permissionSupport = 'supported';
          }
          return result;
        })
        .catch(async (error: unknown) => {
          if (!policy || !shouldRetryWithoutCodexAppServerPermissionProfile(error, requestParams)) {
            throw error;
          }
          permissionSupport = 'legacy';
          const retryParams = { ...requestParams };
          delete retryParams.permissions;
          return await appServerClient.request('turn/start', {
            ...retryParams,
            ...buildCodexAppServerLegacyPermissionParams({ policy, target: 'turn' }),
          });
        });
      const providerTurnId = readTurnId(response);
      if (providerTurnId && activeTurn.providerTurnId !== providerTurnId) {
        activeTurn.providerTurnId = providerTurnId;
        publishRuntimeEvent({
          kind: 'turn-provider-id-observed',
          turnId: activeTurn.sessionTurnId,
          providerTurnId,
        });
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failPendingTurn(failure, {
        deferBackendError: shouldDeferTemporaryRecoverableFailure(failure),
      });
      throw failure;
    }
  };

  const resolveTemporaryRecoverableRetryPrompt = (failure: Error): string | null => {
    if (!isCodexAppServerTemporaryRecoverableTurnFailureError(failure)) return null;
    const originalPrompt = promptForTemporaryRecoverableRetry;
    if (!originalPrompt) return null;
    const decision = resolveRecoverableTurnFailureRetryDecision({
      attemptCount: temporaryRecoverableRetryAttemptCount,
      maxRetries: 1,
      providerWillRetry: false,
      failureRetryAfterMs: null,
      failedTurnHadMeaningfulActivity: activeTurnHadMeaningfulActivity,
      promptMode: 'activity_aware',
      originalPrompt,
      continuationPrompt: temporaryRecoverableTurnContinuationPrompt,
    });
    if (decision.action !== 'retry') return null;
    if (!originalTemporaryRecoverableFailure) {
      originalTemporaryRecoverableFailure = failure;
    }
    if (decision.consumeRetryBudget) {
      temporaryRecoverableRetryAttemptCount += 1;
    }
    return decision.prompt;
  };

  const sendTurnPrompt = async (prompt: string): Promise<void> => {
    promptForTemporaryRecoverableRetry = prompt;
    temporaryRecoverableRetryAttemptCount = 0;
    originalTemporaryRecoverableFailure = null;
    terminalPendingTurnFailure = null;
    while (true) {
      try {
        await startTurnPromptAttempt(prompt);
        return;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const retryPrompt = resolveTemporaryRecoverableRetryPrompt(failure);
        if (!retryPrompt) throw failure;
        prompt = retryPrompt;
      }
    }
  };

  const steerInFlightTurn = async (message: string): Promise<void> => {
    const activeTurn = pendingTurn;
    if (!activeTurn) throw new Error('Codex app-server steer requires an active turn');
    const providerTurnId = activeTurn.providerTurnId;
    if (!providerTurnId) throw new Error('Codex app-server steer requires an active provider turn id');
    const appServerClient = await ensureClient();
    await appServerClient.request('turn/steer', {
      threadId: activeTurn.threadId,
      input: buildCodexAppServerTurnInput({ text: message }),
      expectedTurnId: providerTurnId,
    });
    publishRuntimeEvent({
      kind: 'turn-input-appended',
      turnId: activeTurn.sessionTurnId,
      providerTurnId,
    });
  };

  const cancelTurn = async (): Promise<void> => {
    const activeTurn = pendingTurn;
    if (!activeTurn) {
      setActive(false);
      return;
    }
    const providerTurnId = activeTurn.providerTurnId;
    if (!providerTurnId) {
      pendingTurn = null;
      activeTurn.resolve();
      setActive(false);
      return;
    }
    const appServerClient = await ensureClient();
    await appServerClient.request('turn/interrupt', {
      threadId: activeTurn.threadId,
      turnId: providerTurnId,
    });
    await activeTurn.promise.catch(() => undefined);
  };

  const resetOrDisposeRuntime = async (): Promise<void> => {
    disposed = true;
    const activeTurn = pendingTurn;
    pendingTurn = null;
    activeTurn?.resolve();
    terminalPendingTurnFailure = null;
    deferredTemporaryRecoverableFailure = null;
    originalTemporaryRecoverableFailure = null;
    runtimeSubscribers.clear();
    threadId = null;
    active = false;
    lastActivityAtMs = null;
    const currentClient = client;
    client = null;
    clientPromise = null;
    publishedThreadId = null;
    await currentClient?.dispose();
  };

  return {
    beginTurnLifecycle() {
      setActive(true);
    },
    startOrLoadSession,
    sendTurnPrompt,
    steerInFlightTurn,
    async waitForTurnCompletion() {
      while (true) {
        const activeTurn = pendingTurn;
        if (!activeTurn) {
          const terminalFailure = terminalPendingTurnFailure;
          if (terminalFailure) {
            terminalPendingTurnFailure = null;
            throw terminalFailure;
          }
          const deferredFailure = deferredTemporaryRecoverableFailure;
          if (!deferredFailure) return;
          deferredTemporaryRecoverableFailure = null;
          const retryPrompt = resolveTemporaryRecoverableRetryPrompt(deferredFailure);
          if (!retryPrompt) throw resolveTerminalPendingTurnFailure(deferredFailure);
          await startTurnPromptAttempt(retryPrompt);
          continue;
        }
        try {
          await activeTurn.promise;
          return;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          const retryPrompt = resolveTemporaryRecoverableRetryPrompt(failure);
          if (!retryPrompt) throw resolveTerminalPendingTurnFailure(failure);
          await startTurnPromptAttempt(retryPrompt);
        }
      }
    },
    subscribeRuntimeEvents(handler) {
      runtimeSubscribers.add(handler);
      return () => {
        runtimeSubscribers.delete(handler);
      };
    },
    async respondToPermission() {
      return undefined;
    },
    cancelTurn,
    readSessionIdentity() {
      return { sessionId: threadId };
    },
    async updateSessionRuntimeConfig(update) {
      currentModelId = trimStringValue(update.modelId) ?? currentModelId;
      currentReasoningEffort = trimStringValue(readRecord(update.configOption)?.value) ?? currentReasoningEffort;
      const serviceTier = trimStringValue(update.serviceTier ?? readRecord(update.configOption)?.value);
      if (serviceTier === 'fast' || serviceTier === 'standard') {
        currentServiceTier = serviceTier;
        hasServiceTierOverride = true;
      }
    },
    resetOrDisposeRuntime,
    probeTurnLiveness() {
      return {
        active,
        lastActivityAtMs,
        diagnostics: {
          source: 'codex-app-server-runtime',
          promptInFlight: pendingTurn !== null,
          threadId,
        },
      };
    },
  };
}
