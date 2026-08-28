import type { PublicActionInputById, PublicActionResultById } from '../actions/generated.js';
import type { FollowTranscriptOptions, HappierTranscriptItem } from '../subscriptions.js';
import type { ActionExecute, ActionExecutionOptions } from '../types.js';

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
  spawn: (
    input: SessionSpawnActionInput,
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionResultById['session.spawn_new']>;
  followTranscript: (
    sessionId: string,
    options?: FollowTranscriptOptions,
  ) => AsyncIterable<HappierTranscriptItem>;
  requireSessionId: (sessionId: string) => string;
}>;

function resolveAgentIdentity(
  items: readonly AgentBackendInventoryItem[],
  agentId: string,
): AgentIdentity {
  const candidate = items.find((item) => item.agentId === agentId);
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
    return Object.freeze({
      id,
      send: (message: string, options?: TOptions) => params.execute(
        'session.message.send',
        { sessionId: id, message },
        options,
      ),
      sendAndWait: (message: string, input = {}, options?: TOptions) => params.execute(
        'session.message.send',
        { ...input, sessionId: id, message, wait: true },
        options,
      ),
      waitForIdle: (input = {}, options?: TOptions) => params.execute(
        'session.wait.idle',
        { ...input, sessionId: id },
        options,
      ),
      history: (input = {}, options?: TOptions) => params.execute(
        'session.transcript.get',
        { ...input, sessionId: id },
        options,
      ),
      followTranscript: (options?: FollowTranscriptOptions) => params.followTranscript(id, options),
      stop: (options?: TOptions) => params.execute('session.stop', { sessionId: id }, options),
    });
  };

  return Object.freeze({
    async spawn(input: HappierSessionSpawnInput, options?: TOptions) {
      const { agent, initialMessage, ...actionInput } = input;
      const inventory = await params.execute(
        'agents.backends.list',
        { includeDisabled: true },
        options === undefined
          ? undefined
          : {
              ...(options.target === undefined ? {} : { target: options.target }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
      );
      const result = await params.spawn({
        ...actionInput,
        ...(initialMessage === undefined ? {} : { initialInput: { text: initialMessage } }),
        agentTarget: { kind: 'agent', identity: resolveAgentIdentity(inventory.items, agent) },
      }, options);
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
