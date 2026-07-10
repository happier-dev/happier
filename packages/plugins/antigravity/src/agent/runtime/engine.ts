import type {
  AgentRuntimeV1,
  CreateExecutionRunBackendParamsV1,
  CreateSessionRuntimeParamsV1,
  ExecutionRunBackendCreateResultV1,
  ExecutionRunBackendV1,
  ExecutionRunHostBackendV1,
  ExecutionRunHostMessageV1,
  ExecutionRunInputV1,
  PluginContextV1,
  SessionRuntimeV1,
  SessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk';
import {
  buildBackendTargetKeyV2,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

import { probeAntigravityCliPrintAvailability } from '../cliPrint/availability.js';
import {
  type AntigravityConversationDiscovery,
  discoverNewAntigravityConversationId,
  resolveAntigravityBrainDir,
  resolveAntigravityTranscriptFullPath,
  snapshotAntigravityConversations,
} from '../cliPrint/conversationStore.js';
import { createAntigravityCliPrintSessionRuntime } from '../cliPrint/runtime.js';
import { runAntigravityCliPrintOneShot } from '../cliPrint/oneShot.js';
import { readAntigravityTranscriptTail, type AntigravityTranscriptTailCursor } from '../cliPrint/transcript/jsonl.js';
import { mapAntigravityTranscriptRecordsToSteps } from '../cliPrint/transcript/mapper.js';
import { ANTIGRAVITY_AGENT_ID } from '../install/cliRuntime.js';
import {
  createAntigravityLocalharnessExecutionRunBackend,
  createAntigravityLocalharnessRuntimeFromContext,
} from '../localharness/runtime/sessionRuntime.js';
import type { AntigravityStep } from '../normalize/index.js';
import {
  type AntigravityRuntimeModeProbes,
  type ConcreteAntigravityRuntimeMode,
  resolveAntigravityRuntimeMode,
  resolveAntigravityRuntimeModeRequest,
} from '../lifecycle/runtimeMode.js';
import {
  hasAntigravitySdkCredentialEnv,
  isolateAntigravityCliPrintEnv,
} from '../lifecycle/runtimeEnv.js';
import { readAntigravitySessionMetadataRuntimeDescriptor } from './runtimeDescriptor.js';

export type AntigravitySessionRuntimeFactory = (
  params: Readonly<{
    ctx: PluginContextV1;
    sessionParams: CreateSessionRuntimeParamsV1;
  }>,
) => SessionRuntimeCreateResultV1 | Promise<SessionRuntimeCreateResultV1>;

export type AntigravityExecutionRunBackendFactory = (
  params: Readonly<{
    ctx: PluginContextV1;
    mode: ConcreteAntigravityRuntimeMode;
    executionRunParams: CreateExecutionRunBackendParamsV1;
  }>,
) => ExecutionRunBackendCreateResultV1;

export type CreateAntigravityBackendEngineOptions = Readonly<{
  sessionRuntimes?: Partial<Record<ConcreteAntigravityRuntimeMode, AntigravitySessionRuntimeFactory>>;
  executionRuns?: Partial<Record<ConcreteAntigravityRuntimeMode, AntigravityExecutionRunBackendFactory>>;
  probes?: Partial<AntigravityRuntimeModeProbes>;
}>;

type AntigravityLocalharnessContext = Parameters<typeof createAntigravityLocalharnessRuntimeFromContext>[0]['ctx'];

function toAntigravityLocalharnessContext(ctx: PluginContextV1): AntigravityLocalharnessContext {
  return {
    ...ctx,
    sessions: {
      ...ctx.sessions,
      current: ctx.sessions.current,
    },
  };
}

class AntigravityRuntimeModeResolutionError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, diagnostic: string) {
    super(diagnostic);
    this.name = 'AntigravityRuntimeModeResolutionError';
    this.reasonCode = reasonCode;
  }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string | undefined>> | null {
  const record = readRecord(value);
  if (!record) return null;
  const entries: Array<[string, string | undefined]> = [];
  for (const [key, rawValue] of Object.entries(record)) {
    if (typeof rawValue === 'string' || typeof rawValue === 'undefined') {
      entries.push([key, rawValue]);
    }
  }
  return Object.fromEntries(entries);
}

function readEnv(params: unknown): Readonly<Record<string, string | undefined>> {
  const record = readRecord(params);
  const isolation = readRecord(record?.isolation);
  return readStringRecord(isolation?.env) ?? readStringRecord(record?.env) ?? {};
}

function readCwd(params: unknown): string | null {
  const record = readRecord(params);
  return typeof record?.cwd === 'string'
    ? record.cwd
    : typeof record?.directory === 'string'
      ? record.directory
      : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readModelId(params: unknown): string | null {
  const record = readRecord(params);
  const metadata = readRecord(record?.metadata);
  const targetKey = buildBackendTargetKeyV2({
    kind: 'backend',
    backendId: ANTIGRAVITY_AGENT_ID,
    sourceKind: 'built_in',
  });
  const hasExplicitSelection = record?.modelSelection !== undefined;
  const explicitSelection = SessionModelSelectionV1Schema.safeParse(record?.modelSelection);
  if (explicitSelection.success) {
    if (explicitSelection.data.ref.agentTargetKey !== targetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
    }
    return explicitSelection.data.ref.modelId;
  }
  if (hasExplicitSelection) {
    throw new Error('Invalid session model selection');
  }
  const explicitLegacyModelId = readNonEmptyString(record?.modelId);
  if (explicitLegacyModelId && explicitLegacyModelId !== 'default') return explicitLegacyModelId;
  const intent = resolveSessionModelSelectionIntentV1({
    canonical: metadata?.modelSelectionIntentV1,
    legacy: metadata?.modelOverrideV1,
    agentTargetKey: targetKey,
  });
  return intent?.selection?.modelId ?? null;
}

function readAccountSettings(params: unknown): Readonly<Record<string, unknown>> | null {
  return readRecord(readRecord(params)?.accountSettings);
}

function readMetadata(params: unknown): Readonly<Record<string, unknown>> | null {
  return readRecord(readRecord(params)?.metadata);
}

function readSignal(params: unknown): AbortSignal | undefined {
  const signal = readRecord(params)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

async function defaultCliPrintAvailabilityProbe(
  ctx: PluginContextV1,
  params: Readonly<{
    cwd?: string | null;
    env?: Readonly<Record<string, string | undefined>> | null;
    signal?: AbortSignal;
}>,
): Promise<boolean> {
  const env = isolateAntigravityCliPrintEnv(params.env ?? {});
  const availability = await probeAntigravityCliPrintAvailability({
    exec: ctx.agentRuntime.exec,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(env ? { env } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return availability.available;
}

async function defaultSdkCredentialProbe(
  ctx: PluginContextV1,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (hasAntigravitySdkCredentialEnv(env)) return true;
  const materialized = await ctx.auth.services.materialize({
    serviceId: 'gemini',
    reason: 'antigravity-runtime-mode-auto-sdk-probe',
  });
  return hasAntigravitySdkCredentialEnv(materialized?.env ?? {});
}

function createModeProbes(
  ctx: PluginContextV1,
  probes: Partial<AntigravityRuntimeModeProbes> | undefined,
): AntigravityRuntimeModeProbes {
  return {
    isCliPrintAvailable: probes?.isCliPrintAvailable
      ?? ((probeContext) => defaultCliPrintAvailabilityProbe(ctx, probeContext)),
    hasSdkCredentials: probes?.hasSdkCredentials
      ?? ((probeContext) => defaultSdkCredentialProbe(ctx, probeContext.env ?? {})),
  };
}

async function resolveConcreteMode(params: Readonly<{
  ctx: PluginContextV1;
  runtimeParams: unknown;
  probes?: Partial<AntigravityRuntimeModeProbes>;
}>): Promise<ConcreteAntigravityRuntimeMode> {
  const resolution = await resolveAntigravityRuntimeMode({
    metadata: readMetadata(params.runtimeParams),
    accountSettings: readAccountSettings(params.runtimeParams),
    env: readEnv(params.runtimeParams),
    cwd: readCwd(params.runtimeParams),
    signal: readSignal(params.runtimeParams),
    probes: createModeProbes(params.ctx, params.probes),
  });
  if (resolution.status === 'resolved') return resolution.mode;
  throw new AntigravityRuntimeModeResolutionError(resolution.reasonCode, resolution.diagnostic);
}

function resolveConcreteModeRequest(params: unknown): ConcreteAntigravityRuntimeMode | null {
  const request = resolveAntigravityRuntimeModeRequest({
    metadata: readMetadata(params),
    accountSettings: readAccountSettings(params),
    env: readEnv(params),
  });
  return request.requestedMode === 'cliPrint' || request.requestedMode === 'sdk'
    ? request.requestedMode
    : null;
}

function createDefaultCliPrintSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): SessionRuntimeCreateResultV1 {
  const cwd = readCwd(params.sessionParams) ?? '.';
  const env = isolateAntigravityCliPrintEnv(readEnv(params.sessionParams));
  const brainDir = resolveAntigravityBrainDir(env);
  const runtimeDescriptor = readAntigravitySessionMetadataRuntimeDescriptor(
    readMetadata(params.sessionParams),
  );
  let lastDiscovery: AntigravityConversationDiscovery | null = null;

  const readTranscriptSteps = async (input: Readonly<{
    turnId?: string;
    conversationId?: string | null;
    cursor?: AntigravityTranscriptTailCursor;
  }>): Promise<readonly AntigravityStep[]> => {
    const conversationId = input.conversationId?.trim();
    if (!conversationId) return [];
    const transcriptPath = resolveAntigravityTranscriptFullPath(brainDir, conversationId);
    const tail = await readAntigravityTranscriptTail({
      path: transcriptPath,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return mapAntigravityTranscriptRecordsToSteps(tail.records, {
      ...(input.turnId ? { generatedIdNamespace: input.turnId } : {}),
    });
  };

  const readPromptMatchedConversation = async (input: Readonly<{
    discovery: Extract<AntigravityConversationDiscovery, { status: 'ambiguous' }>;
    prompt: string;
    turnId?: string;
  }>): Promise<Readonly<{
    conversationId: string;
    steps: readonly AntigravityStep[];
  }> | null> => {
    const prompt = input.prompt.trim();
    if (!prompt) return null;
    const matches: Array<Readonly<{
      conversationId: string;
      steps: readonly AntigravityStep[];
    }>> = [];
    for (const conversationId of input.discovery.candidates) {
      const steps = await readTranscriptSteps({
        conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      }).catch(() => []);
      if (steps.some((step) => step.kind === 'user_message' && step.text.trim() === prompt)) {
        matches.push({ conversationId, steps });
      }
    }
    return matches.length === 1 ? matches[0] ?? null : null;
  };

  return createAntigravityCliPrintSessionRuntime({
    sessionId: params.sessionParams.sessionId ?? 'antigravity-cliprint-session',
    cwd,
    executable: ANTIGRAVITY_AGENT_ID,
    ...(env ? { env } : {}),
    modelId: readModelId(params.sessionParams),
    sandbox: true,
    includeWorkspaceScope: true,
    conversationId: runtimeDescriptor?.agyConversationId ?? null,
    promptTimeoutMs: 120_000,
    discoverConversationId: async () => lastDiscovery ?? { status: 'not_found' },
    runOneShot: async (input) => {
      lastDiscovery = null;
      const beforeConversations = input.conversationId
        ? null
        : await snapshotAntigravityConversations(brainDir);
      const beforeTranscript = input.conversationId
        ? await readAntigravityTranscriptTail({
            path: resolveAntigravityTranscriptFullPath(brainDir, input.conversationId),
          })
        : null;
      return await runAntigravityCliPrintOneShot({
        agentId: ANTIGRAVITY_AGENT_ID,
        args: input.args,
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        run: params.ctx.agentRuntime.exec.run,
        readTranscriptSteps: async () => {
          const discoveredConversation = beforeConversations
            ? discoverNewAntigravityConversationId(beforeConversations, await snapshotAntigravityConversations(brainDir))
            : { status: 'not_found' } satisfies AntigravityConversationDiscovery;
          lastDiscovery = discoveredConversation;
          if (!input.conversationId && discoveredConversation.status === 'ambiguous') {
            const match = await readPromptMatchedConversation({
              discovery: discoveredConversation,
              prompt: input.prompt,
              turnId: input.turnId,
            });
            if (match) {
              lastDiscovery = { status: 'found', conversationId: match.conversationId };
              return match.steps;
            }
          }
          const transcriptConversationId = input.conversationId
            ?? (discoveredConversation.status === 'found' ? discoveredConversation.conversationId : null);
          return await readTranscriptSteps({
            turnId: input.turnId,
            conversationId: transcriptConversationId,
            ...(beforeTranscript?.cursor ? { cursor: beforeTranscript.cursor } : {}),
          });
        },
      });
    },
  });
}

function withExecutionRunSessionIdentity(
  runtime: SessionRuntimeV1,
  fallbackSessionId: string,
): SessionRuntimeV1 {
  return {
    ...runtime,
    identity: {
      read: () => {
        const identity = runtime.identity.read();
        return {
          ...identity,
          providerSessionId: readNonEmptyString(identity.providerSessionId) ?? fallbackSessionId,
        };
      },
    },
  };
}

function createDefaultCliPrintExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunBackendCreateResultV1 {
  const cwd = readCwd(params.executionRunParams) ?? '.';
  const runId = readNonEmptyString(params.executionRunParams.runId) ?? 'default';
  const fallbackSessionId = `antigravity-cliprint-execution-run:${runId}`;

  return createExecutionRunHostBackendFromSessionRuntime({
    createSessionRuntime: async (factoryParams) => withExecutionRunSessionIdentity(
      await createDefaultCliPrintSessionRuntime({
        ctx: params.ctx,
        sessionParams: {
          ...params.executionRunParams,
          cwd,
          sessionId: readNonEmptyString(factoryParams?.resumeSessionId) ?? fallbackSessionId,
          metadata: {
            ...(readMetadata(params.executionRunParams) ?? {}),
            antigravityRuntimeMode: 'cliPrint',
          },
        },
      }),
      fallbackSessionId,
    ),
    readResumeSupport: async () => true,
    supportsSteerPrompt: false,
    waitForTurnCompletion: {
      mode: 'untilIdle',
    },
    diagnostics: {
      source: 'antigravity-cliprint-execution-run',
    },
  });
}

function isRunBackend(
  backend: ExecutionRunBackendCreateResultV1,
): backend is ExecutionRunBackendV1 {
  return typeof (backend as Readonly<{ run?: unknown }>).run === 'function';
}

function isHostBackend(
  backend: ExecutionRunBackendCreateResultV1,
): backend is ExecutionRunHostBackendV1 {
  return typeof (backend as Readonly<{ provisionSession?: unknown }>).provisionSession === 'function';
}

function createDeferredExecutionRunBackend(params: Readonly<{
  resolveDelegate(): Promise<ExecutionRunBackendCreateResultV1>;
}>): ExecutionRunBackendV1 & ExecutionRunHostBackendV1 {
  let delegatePromise: Promise<ExecutionRunBackendCreateResultV1> | null = null;
  const handlers = new Set<(message: ExecutionRunHostMessageV1) => void>();
  let unsubscribeDelegate: (() => void) | null = null;

  const getDelegate = async (): Promise<ExecutionRunBackendCreateResultV1> => {
    if (!delegatePromise) {
      delegatePromise = params.resolveDelegate().then((delegate) => {
        if (isHostBackend(delegate)) {
          unsubscribeDelegate = delegate.subscribeMessages((message) => {
            for (const handler of Array.from(handlers)) handler(message);
          });
        }
        return delegate;
      });
    }
    return delegatePromise;
  };

  return {
    async run(input: ExecutionRunInputV1, options) {
      const delegate = await getDelegate();
      if (!isRunBackend(delegate)) {
        return {
          status: 'unsupported',
          diagnostic: 'Resolved Antigravity execution-run backend does not support single-shot run().',
        };
      }
      return delegate.run(input, options);
    },
    async readResumeSupport(options) {
      const delegate = await getDelegate();
      return isHostBackend(delegate) ? delegate.readResumeSupport(options) : false;
    },
    async provisionSession(options) {
      const delegate = await getDelegate();
      if (!isHostBackend(delegate)) {
        throw new Error('Resolved Antigravity execution-run backend does not support session provisioning.');
      }
      return delegate.provisionSession(options);
    },
    async sendPrompt(sessionId, prompt, meta) {
      const delegate = await getDelegate();
      if (!isHostBackend(delegate)) {
        throw new Error('Resolved Antigravity execution-run backend does not support sendPrompt.');
      }
      return delegate.sendPrompt(sessionId, prompt, meta);
    },
    async sendSteerPrompt(sessionId, prompt, meta) {
      const delegate = await getDelegate();
      if (!isHostBackend(delegate) || !delegate.sendSteerPrompt) {
        throw new Error('Resolved Antigravity execution-run backend does not support steer prompts.');
      }
      return delegate.sendSteerPrompt(sessionId, prompt, meta);
    },
    async cancel(sessionId) {
      const delegate = await getDelegate();
      if (isHostBackend(delegate)) return delegate.cancel(sessionId);
      return undefined;
    },
    subscribeMessages(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async respondToPermission(requestId, approved) {
      const delegate = await getDelegate();
      if (!isHostBackend(delegate) || !delegate.respondToPermission) {
        return { delivered: false, reason: 'unknown_request' };
      }
      return delegate.respondToPermission(requestId, approved);
    },
    async waitForTurnCompletion(timeoutMs) {
      const delegate = await getDelegate();
      if (isHostBackend(delegate)) return delegate.waitForTurnCompletion?.(timeoutMs);
      return undefined;
    },
    async probeTurnLiveness(sessionId) {
      const delegate = await getDelegate();
      return isHostBackend(delegate) && delegate.probeTurnLiveness
        ? delegate.probeTurnLiveness(sessionId)
        : { active: false, reason: 'unsupported' };
    },
    async dispose() {
      unsubscribeDelegate?.();
      const delegate = delegatePromise ? await delegatePromise : null;
      await delegate?.dispose?.();
    },
  };
}

export function createAntigravityBackendEngine(
  ctx: PluginContextV1,
  options: CreateAntigravityBackendEngineOptions = {},
): AgentRuntimeV1 {
  const createSdkSessionRuntime =
    options.sessionRuntimes?.sdk ?? ((params) => createAntigravityLocalharnessRuntimeFromContext({
      ctx: toAntigravityLocalharnessContext(params.ctx),
      sessionParams: params.sessionParams,
    }));
  const createCliPrintSessionRuntime =
    options.sessionRuntimes?.cliPrint ?? createDefaultCliPrintSessionRuntime;
  const createSdkExecutionRunBackend =
    options.executionRuns?.sdk
    ?? ((params) => createAntigravityLocalharnessExecutionRunBackend({
      ctx: toAntigravityLocalharnessContext(params.ctx),
      executionRunParams: params.executionRunParams,
    }));
  const createCliPrintExecutionRunBackend =
    options.executionRuns?.cliPrint ?? ((params) => createDefaultCliPrintExecutionRunBackend({
      ctx: params.ctx,
      executionRunParams: params.executionRunParams,
    }));

  const createExecutionRunBackendForMode = (
    mode: ConcreteAntigravityRuntimeMode,
    executionRunParams: CreateExecutionRunBackendParamsV1,
  ): ExecutionRunBackendCreateResultV1 => {
    const createExecutionRunBackend =
      mode === 'cliPrint' ? createCliPrintExecutionRunBackend : createSdkExecutionRunBackend;
    return createExecutionRunBackend({ ctx, mode, executionRunParams });
  };

  return {
    runtimeCore: {
      createSessionRuntime: async (sessionParams) => {
        const mode = await resolveConcreteMode({
          ctx,
          runtimeParams: sessionParams,
          probes: options.probes,
        });
        const createSessionRuntime = mode === 'cliPrint' ? createCliPrintSessionRuntime : createSdkSessionRuntime;
        return createSessionRuntime({ ctx, sessionParams });
      },
      createExecutionRunBackend: (executionRunParams) => {
        const concreteMode = resolveConcreteModeRequest(executionRunParams);
        if (concreteMode) return createExecutionRunBackendForMode(concreteMode, executionRunParams);
        return createDeferredExecutionRunBackend({
          resolveDelegate: async () => {
            const mode = await resolveConcreteMode({
              ctx,
              runtimeParams: executionRunParams,
              probes: options.probes,
            });
            return createExecutionRunBackendForMode(mode, executionRunParams);
          },
        });
      },
    },
  };
}
