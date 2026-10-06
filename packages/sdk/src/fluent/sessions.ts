import type { PublicActionInputById, PublicActionResultById } from '../actions/generated.js';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SessionListQueryV1 } from '@happier-dev/protocol';
import type { FollowTranscriptOptions, HappierTranscriptItem } from '../subscriptions.js';
import type { HappierSessionController, HappierSessionLiveOptions } from '../live/types.js';
import type { ActionExecute, ActionExecutionOptions, ActionTarget } from '../types.js';
import { bindPublicActionInput, correspondenceOptions } from './boundActionCall.js';
import { createSessionExecutionRuns, type HappierSessionExecutionRuns } from './sessionExecutionRuns.js';

type WithoutSessionId<T> = T extends object ? Omit<T, 'sessionId'> : never;
type SessionSpawnActionInput = PublicActionInputById['session.spawn_new'];
type SessionSpawnSuccessResult = Extract<
  PublicActionResultById['session.spawn_new'],
  Readonly<{ type: 'success' }>
>;
type SessionSpawnInitialInputFailure = Exclude<
  SessionSpawnSuccessResult['initialInput'],
  Readonly<{ status: 'accepted' }> | Readonly<{ status: 'alreadyAccepted' }>
>;
type SessionSpawnSuccessWithInitialInputFailure = SessionSpawnSuccessResult & Readonly<{
  initialInput: SessionSpawnInitialInputFailure;
}>;
type AgentBackendInventoryItem = PublicActionResultById['agents.backends.list']['items'][number];
type AgentIdentity = SessionSpawnActionInput['agentTarget']['identity'];

/**
 * Author-facing Session creation input for a client already bound to a
 * Machine. Transport routing remains at `machine(machineId)`; the current
 * Machine inventory resolves the friendly Agent id to the canonical target.
 */
export type HappierSessionSpawnInput = Readonly<
  Omit<SessionSpawnActionInput, 'agentTarget' | 'executionTarget' | 'initialInput'> & Readonly<{
    /** Friendly Agent id or canonical Agent target key; both resolve through the Machine inventory. */
    agent: string;
    initialMessage?: string;
  }>
>;

/** Additional Action input for `session.sendAndWait()`, whose Session and wait mode are fixed by the fluent handle. */
export type HappierSessionSendAndWaitInput = Readonly<
  Omit<PublicActionInputById['session.message.send'], 'sessionId' | 'message' | 'wait'>
>;

/** Per-call controls for an unbound fluent Session client. */
export type HappierSessionSpawnOptions = ActionExecutionOptions;

/** Exact folder membership and tag membership each use ANY; the two filters combine with AND. */
export type HappierSessionListInput = Readonly<Partial<Pick<SessionListQueryV1,
  'folderIds' | 'tagIds' | 'storage' | 'includeInactive' | 'cursor' | 'limit'
>>>;

type HappierMachineSessionOptions = Readonly<Omit<ActionExecutionOptions, 'target'>>;

export type HappierAgentUnavailableReason = 'not_installed' | 'disabled' | 'identity_unavailable';

/** The requested Agent cannot be selected from this Machine's current inventory. */
export class HappierAgentUnavailableError extends Error {
  readonly agentId: string;
  readonly reason: HappierAgentUnavailableReason;

  constructor(agentId: string, reason: HappierAgentUnavailableReason) {
    super(
      reason === 'not_installed'
        ? `The Agent ${JSON.stringify(agentId)} is not installed on this Machine.`
        : reason === 'disabled'
          ? `The Agent ${JSON.stringify(agentId)} is disabled on this Machine.`
          : `The Agent ${JSON.stringify(agentId)} cannot be used to create a Session on this Machine.`,
    );
    this.name = 'HappierAgentUnavailableError';
    this.agentId = agentId;
    this.reason = reason;
  }
}

export class HappierSessionSpawnError extends Error {
  readonly result: Exclude<PublicActionResultById['session.spawn_new'], Readonly<{ type: 'success' }>>;

  constructor(result: Exclude<PublicActionResultById['session.spawn_new'], Readonly<{ type: 'success' }>>) {
    super(`Session creation did not settle successfully: ${result.type}`);
    this.name = 'HappierSessionSpawnError';
    this.result = result;
  }
}

export type HappierSession<TOptions extends ActionExecutionOptions = ActionExecutionOptions> = Readonly<{
  id: string;
  runs: HappierSessionExecutionRuns<TOptions>;
  send: (
    message: string,
    options?: TOptions,
  ) => Promise<PublicActionResultById['session.message.send']>;
  sendAndWait: (
    message: string,
    input?: HappierSessionSendAndWaitInput,
    options?: TOptions,
  ) => Promise<PublicActionResultById['session.message.send']>;
  waitForIdle: (
    input?: WithoutSessionId<PublicActionInputById['session.wait.idle']>,
    options?: TOptions,
  ) => Promise<PublicActionResultById['session.wait.idle']>;
  history: (
    input?: WithoutSessionId<PublicActionInputById['session.transcript.get']>,
    options?: TOptions,
  ) => Promise<PublicActionResultById['session.transcript.get']>;
  followTranscript: (options?: FollowTranscriptOptions) => AsyncIterable<HappierTranscriptItem>;
  live: (options?: HappierSessionLiveOptions) => Promise<HappierSessionController>;
  stop: (options?: TOptions) => Promise<PublicActionResultById['session.stop']>;
}>;

/**
 * A Session was committed, but the initial message requested through the
 * fluent API was not admitted. Continue with `session`; inspect
 * `result.initialInput` for the canonical admission disposition.
 */
export class HappierSessionInitialInputError<TOptions extends ActionExecutionOptions = ActionExecutionOptions> extends Error {
  readonly session: HappierSession<TOptions>;
  readonly result: SessionSpawnSuccessWithInitialInputFailure;

  constructor(session: HappierSession<TOptions>, result: SessionSpawnSuccessWithInitialInputFailure) {
    super(
      `Session ${JSON.stringify(result.sessionId)} was committed, but its initial message was not admitted: ${result.initialInput.status}.`,
    );
    this.name = 'HappierSessionInitialInputError';
    this.session = session;
    this.result = result;
  }
}

export type HappierSessions<TOptions extends ActionExecutionOptions = ActionExecutionOptions> = Readonly<{
  list: (
    input?: HappierSessionListInput,
    options?: TOptions,
  ) => Promise<PublicActionResultById['session.list']>;
  spawn: (
    input: HappierSessionSpawnInput,
    options?: TOptions,
  ) => Promise<HappierSession<TOptions>>;
  get: (sessionId: string) => HappierSession<TOptions>;
  followTranscript: (
    sessionId: string,
    options?: FollowTranscriptOptions,
  ) => AsyncIterable<HappierTranscriptItem>;
}>;

/** The same fluent Session collection, with routing fixed by its bound client. */
export type HappierMachineSessions = HappierSessions<HappierMachineSessionOptions>;

type SessionCollectionParams = Readonly<{
  execute: ActionExecute;
  sessionTarget?: (sessionId: string) => ActionTarget;
  spawn: (
    input: SessionSpawnActionInput,
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionResultById['session.spawn_new']>;
  followTranscript: (
    sessionId: string,
    options?: FollowTranscriptOptions,
  ) => AsyncIterable<HappierTranscriptItem>;
  requireSessionId: (sessionId: string) => string;
  live: (sessionId: string, options?: HappierSessionLiveOptions) => Promise<HappierSessionController>;
}>;

function resolveAgentIdentity(
  items: readonly AgentBackendInventoryItem[],
  agentId: string,
): AgentIdentity {
  const candidate = items.find((item) => agentId.startsWith('agent:')
    ? item.identity !== undefined && buildBackendTargetKeyV2({ kind: 'agent', identity: item.identity }) === agentId
    : item.agentId === agentId);
  if (candidate === undefined) throw new HappierAgentUnavailableError(agentId, 'not_installed');
  if (!candidate.enabled) throw new HappierAgentUnavailableError(agentId, 'disabled');
  if (candidate.identity === undefined) {
    throw new HappierAgentUnavailableError(agentId, 'identity_unavailable');
  }
  return candidate.identity;
}

function hasInitialInputFailure(
  result: SessionSpawnSuccessResult,
): result is SessionSpawnSuccessWithInitialInputFailure {
  return result.initialInput.status !== 'accepted' && result.initialInput.status !== 'alreadyAccepted';
}

export function createSessions<TOptions extends ActionExecutionOptions = ActionExecutionOptions>(
  params: SessionCollectionParams,
): HappierSessions<TOptions> {
  const get = (sessionId: string): HappierSession<TOptions> => {
    const id = params.requireSessionId(sessionId);
    const optionsForSession = (options: TOptions | undefined): ActionExecutionOptions | undefined => {
      const target = options?.target ?? params.sessionTarget?.(id);
      return target === undefined ? options : { ...(options ?? {}), target };
    };
    return Object.freeze({
      id,
      runs: createSessionExecutionRuns<TOptions>({ sessionId: id, execute: params.execute, optionsForSession }),
      send: async (message: string, options?: TOptions) => await params.execute(
        'session.message.send',
        bindPublicActionInput('session.message.send', { sessionId: id, message }, options?.requestId),
        optionsForSession(options),
      ),
      sendAndWait: async (message: string, input = {}, options?: TOptions) => await params.execute(
        'session.message.send',
        bindPublicActionInput(
          'session.message.send',
          { ...input, sessionId: id, message, wait: true },
          options?.requestId,
        ),
        optionsForSession(options),
      ),
      waitForIdle: async (input = {}, options?: TOptions) => await params.execute(
        'session.wait.idle',
        bindPublicActionInput('session.wait.idle', { ...input, sessionId: id }, options?.requestId),
        optionsForSession(options),
      ),
      history: async (input = {}, options?: TOptions) => await params.execute(
        'session.transcript.get',
        bindPublicActionInput('session.transcript.get', { ...input, sessionId: id }, options?.requestId),
        optionsForSession(options),
      ),
      followTranscript: (options?: FollowTranscriptOptions) => params.followTranscript(id, options),
      live: (options?: HappierSessionLiveOptions) => params.live(id, options),
      stop: async (options?: TOptions) => await params.execute(
        'session.stop',
        bindPublicActionInput('session.stop', { sessionId: id }, options?.requestId),
        optionsForSession(options),
      ),
    });
  };

  return Object.freeze({
    list: async (input: HappierSessionListInput = {}, options?: TOptions) => await params.execute(
      'session.list',
      bindPublicActionInput('session.list', { query: {
        v: 1,
        storage: 'active',
        includeInactive: true,
        scope: 'all_accessible',
        attention: 'any',
        audiences: [],
        ...input,
        // The fluent query accepts immutable inputs; the public Action request owns its array.
        tagIds: [...(input.tagIds ?? [])],
        folderIds: input.folderIds === undefined ? undefined : [...input.folderIds],
      } }, options?.requestId),
      options,
    ),
    async spawn(input: HappierSessionSpawnInput, options?: TOptions) {
      const { agent, initialMessage, ...actionInput } = input;
      const inventory = await params.execute(
        'agents.backends.list',
        { includeDisabled: true },
        correspondenceOptions(options),
      );
      const result = await params.spawn(bindPublicActionInput('session.spawn_new', {
        ...actionInput,
        ...(initialMessage === undefined ? {} : { initialInput: { text: initialMessage } }),
        agentTarget: { kind: 'agent', identity: resolveAgentIdentity(inventory.items, agent) },
      }, options?.requestId), options);
      if (result.type !== 'success') throw new HappierSessionSpawnError(result);
      const session = get(result.sessionId);
      if (initialMessage !== undefined && hasInitialInputFailure(result)) {
        throw new HappierSessionInitialInputError<TOptions>(session, result);
      }
      return session;
    },
    get,
    followTranscript: params.followTranscript,
  });
}

export function createMachineSessions(
  params: SessionCollectionParams,
): HappierMachineSessions {
  return createSessions<HappierMachineSessionOptions>(params);
}
