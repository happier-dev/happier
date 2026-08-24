import {
  ExternalActionHttpErrorV1Schema,
  parseExternalActionResponseEnvelopeV1,
} from '@happier-dev/protocol/actions';

import { createGeneratedActions, MUTATING_PUBLIC_ACTION_IDS } from './actions/generated.js';
import { HappierActionError, HappierClientClosedError, HappierTransportError } from './errors.js';
import {
  createMachineSessions,
  createSessions,
  type HappierMachineSessions,
  type HappierSessions,
} from './fluent/sessions.js';
import {
  parseMachineListResponse,
  type HappierMachine,
  type MachineListOptions,
} from './machines.js';
import {
  createTranscriptIterable,
  startExecutionRunStream,
  type FollowTranscriptOptions,
  type HappierExecutionRunStream,
} from './subscriptions.js';
import type {
  ActionExecute,
  ActionExecutionOptions,
  ContributedActionId,
  HappierConnectOptions,
} from './types.js';
import type {
  PublicActionId,
  PublicActionInputById,
  PublicActionResultById,
} from './actions/generated.js';

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must be non-empty`);
  return normalized;
}

function normalizeEndpoint(endpoint: string | URL): URL {
  const parsed = endpoint instanceof URL ? new URL(endpoint.href) : new URL(endpoint);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('endpoint must use http or https');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/`;
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function combinedSignal(signal: AbortSignal | undefined, closeSignal: AbortSignal): AbortSignal {
  return signal === undefined ? closeSignal : AbortSignal.any([signal, closeSignal]);
}

function transportErrorCode(body: unknown): string | undefined {
  const externalActionError = ExternalActionHttpErrorV1Schema.safeParse(body);
  if (externalActionError.success) return externalActionError.data.code;
  if (body === null || typeof body !== 'object') return undefined;
  const candidate = body as Readonly<{ error?: unknown }>;
  return typeof candidate.error === 'string' ? candidate.error : undefined;
}

export type HappierActions = ReturnType<typeof createGeneratedActions> & Readonly<{
  execute: ActionExecute;
  search: (
    input: PublicActionInputById['action.spec.search'],
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionResultById['action.spec.search']>;
  invoke: (
    action: ContributedActionId,
    input: unknown,
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionResultById['action.invoke']>;
}>;

/** Per-call controls for an Action client already bound to one Machine. */
export type HappierMachineActionExecutionOptions = Readonly<Omit<ActionExecutionOptions, 'target'>>;

export type HappierMachineActionExecute = <K extends PublicActionId>(
  actionId: K,
  input: PublicActionInputById[K],
  options?: HappierMachineActionExecutionOptions,
) => Promise<PublicActionResultById[K]>;

type MachineBoundActionMethods<T> = T extends (
  input: infer Input,
  options?: ActionExecutionOptions,
) => infer Result
  ? (input: Input, options?: HappierMachineActionExecutionOptions) => Result
  : T extends object
    ? Readonly<{ [K in keyof T]: MachineBoundActionMethods<T[K]> }>
    : T;

/** The generated Action tree with routing fixed by `client.machine(machineId)`. */
export type HappierMachineActions = MachineBoundActionMethods<ReturnType<typeof createGeneratedActions>> & Readonly<{
  execute: HappierMachineActionExecute;
  search: (
    input: PublicActionInputById['action.spec.search'],
    options?: HappierMachineActionExecutionOptions,
  ) => Promise<PublicActionResultById['action.spec.search']>;
  invoke: (
    action: ContributedActionId,
    input: unknown,
    options?: HappierMachineActionExecutionOptions,
  ) => Promise<PublicActionResultById['action.invoke']>;
}>;

export type HappierExecutionRuns<TOptions extends ActionExecutionOptions = ActionExecutionOptions> = Readonly<{
  startStream: (
    input: PublicActionInputById['execution.run.stream.start'],
    options?: TOptions,
  ) => Promise<HappierExecutionRunStream>;
}>;

export type HappierMachineExecutionRuns = HappierExecutionRuns<HappierMachineActionExecutionOptions>;

export type HappierClient = Readonly<{
  actions: HappierActions;
  machines: Readonly<{
    list: (options?: MachineListOptions) => Promise<readonly HappierMachine[]>;
  }>;
  sessions: HappierSessions;
  runs: HappierExecutionRuns;
  machine: (machineId: string) => HappierMachineClient;
  close: () => void;
}>;

export type HappierMachineClient = Readonly<
  Omit<HappierClient, 'actions' | 'machine' | 'sessions' | 'runs'> & Readonly<{
    actions: HappierMachineActions;
    sessions: HappierMachineSessions;
    runs: HappierMachineExecutionRuns;
    machine: (machineId: string) => HappierMachineClient;
  }>
>;

type MachineActionTarget = Readonly<{ kind: 'machine'; machineId: string }>;

function assertMachineBoundTarget(target: unknown, boundTarget: MachineActionTarget): void {
  if (target === undefined) return;
  if (target !== null && typeof target === 'object') {
    const candidate = target as Readonly<{ kind?: unknown; machineId?: unknown }>;
    if (candidate.kind === 'machine' && candidate.machineId === boundTarget.machineId) return;
  }
  throw new HappierTransportError(
    'A machine-bound Happier client cannot execute an Action against a different target.',
    {
      code: 'machine_target_conflict',
      details: { requestedTarget: target, boundTarget },
    },
  );
}

function createActions(execute: ActionExecute): HappierActions {
  const generated = createGeneratedActions(execute);
  return Object.freeze({
    ...generated,
    execute,
    search: (input: PublicActionInputById['action.spec.search'], options?: ActionExecutionOptions) => (
      execute('action.spec.search', input, options)
    ),
    invoke: (action: ContributedActionId, input: unknown, options?: ActionExecutionOptions) => (
      execute('action.invoke', { action, input }, options)
    ),
  });
}

function createMachineActions(execute: ActionExecute): HappierMachineActions {
  return createActions(execute);
}

function createClient(
  endpoint: URL,
  token: string,
  lifecycle: Readonly<{ controller: AbortController; isClosed: () => boolean }>,
): HappierClient;
function createClient(
  endpoint: URL,
  token: string,
  lifecycle: Readonly<{ controller: AbortController; isClosed: () => boolean }>,
  defaultTarget: MachineActionTarget,
): HappierMachineClient;
function createClient(
  endpoint: URL,
  token: string,
  lifecycle: Readonly<{ controller: AbortController; isClosed: () => boolean }>,
  defaultTarget?: MachineActionTarget,
): HappierClient | HappierMachineClient {
  const requestJson = async (params: Readonly<{
    path: string;
    method: 'GET' | 'POST';
    body?: string;
    signal?: AbortSignal;
    allowAfterClose?: boolean;
  }>): Promise<unknown> => {
    if (lifecycle.isClosed() && params.allowAfterClose !== true) throw new HappierClientClosedError();
    const requestSignal = params.allowAfterClose === true
      ? params.signal
      : combinedSignal(params.signal, lifecycle.controller.signal);
    let response: Response;
    try {
      response = await fetch(new URL(params.path, endpoint), {
        method: params.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(params.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(params.body === undefined ? {} : { body: params.body }),
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
    } catch (error) {
      if (lifecycle.controller.signal.aborted && params.allowAfterClose !== true) {
        throw lifecycle.controller.signal.reason;
      }
      if (params.signal?.aborted) throw params.signal.reason;
      throw new HappierTransportError('Could not reach the Happier API.', { cause: error });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (lifecycle.controller.signal.aborted && params.allowAfterClose !== true) {
        throw lifecycle.controller.signal.reason;
      }
      if (params.signal?.aborted) throw params.signal.reason;
      throw new HappierTransportError('The Happier API returned invalid JSON.', {
        status: response.status,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new HappierTransportError(`The Happier API returned HTTP ${response.status}.`, {
        code: transportErrorCode(body),
        status: response.status,
        details: body,
      });
    }
    return body;
  };

  const executeRequest = async <K extends PublicActionId>(
    actionId: K,
    input: PublicActionInputById[K],
    options: ActionExecutionOptions = {},
    allowAfterClose = false,
  ): Promise<PublicActionResultById[K]> => {
    const requestId = options.requestId
      ?? (MUTATING_PUBLIC_ACTION_IDS.has(actionId) ? globalThis.crypto.randomUUID() : undefined);
    const requestBody = {
      v: 1 as const,
      ...(requestId === undefined ? {} : { requestId: requireNonEmpty(requestId, 'requestId') }),
      ...((options.target ?? defaultTarget) === undefined ? {} : { target: options.target ?? defaultTarget }),
      input,
    };

    const body = await requestJson({
      path: `v1/actions/${encodeURIComponent(actionId)}`,
      method: 'POST',
      body: JSON.stringify(requestBody),
      signal: options.signal,
      allowAfterClose,
    });
    const externalActionResponse = parseExternalActionResponseEnvelopeV1(body);
    if (!externalActionResponse || externalActionResponse.actionId !== actionId) {
      throw new HappierTransportError('The Happier Action API returned an invalid response envelope.', {
        details: body,
      });
    }
    if (!externalActionResponse.execution.ok) {
      throw new HappierActionError(
        externalActionResponse.execution.errorCode,
        externalActionResponse.execution.error,
        externalActionResponse.execution.details,
      );
    }
    return externalActionResponse.execution.result as PublicActionResultById[K];
  };
  const execute: ActionExecute = (actionId, input, options) => executeRequest(actionId, input, options);
  const createExecutionRuns = <TOptions extends ActionExecutionOptions>(params: Readonly<{
    execute: ActionExecute;
    cancel: (
      input: PublicActionInputById['execution.run.stream.cancel'],
      options: Readonly<Pick<ActionExecutionOptions, 'target'>>,
    ) => Promise<void>;
  }>): HappierExecutionRuns<TOptions> => Object.freeze({
    startStream: async (input, options) => {
      const scope = input.sessionId === undefined ? {} : { sessionId: input.sessionId };
      const routing = options?.target === undefined ? {} : { target: options.target };
      return await startExecutionRunStream({
        runId: input.runId,
        start: () => params.execute('execution.run.stream.start', input, options),
        read: (readInput, signal) => params.execute('execution.run.stream.read', {
          ...scope,
          ...readInput,
        }, { ...routing, signal }),
        cancel: async (cancelInput) => {
          await params.cancel({ ...scope, ...cancelInput }, routing);
        },
        closeSignal: lifecycle.controller.signal,
        signal: options?.signal,
      });
    },
  });

  const followTranscript = (sessionId: string, options?: FollowTranscriptOptions) => (
    createTranscriptIterable({
      execute,
      release: async (input) => {
        await executeRequest('transcript.unfollow', input, {}, true);
      },
      sessionId: requireNonEmpty(sessionId, 'sessionId'),
      closeSignal: lifecycle.controller.signal,
      options,
    })
  );
  const machines = Object.freeze({
    async list(options: MachineListOptions = {}) {
      return parseMachineListResponse(await requestJson({
        path: 'v1/machines',
        method: 'GET',
        signal: options.signal,
      }));
    },
  });
  const machine = (machineId: string) => createClient(endpoint, token, lifecycle, {
    kind: 'machine',
    machineId: requireNonEmpty(machineId, 'machineId'),
  });
  const close = () => {
    if (!lifecycle.isClosed()) lifecycle.controller.abort(new HappierClientClosedError());
  };

  if (defaultTarget !== undefined) {
    const machineExecute: ActionExecute = async (actionId, input, options) => {
      assertMachineBoundTarget(options?.target, defaultTarget);
      return await executeRequest(actionId, input, { ...(options ?? {}), target: defaultTarget });
    };
    const sessions = createMachineSessions({
      execute: machineExecute,
      followTranscript,
      requireSessionId: (sessionId) => requireNonEmpty(sessionId, 'sessionId'),
      spawn: (input, options) => machineExecute('session.spawn_new', input, options),
    });
    const runs = createExecutionRuns<HappierMachineActionExecutionOptions>({
      execute: machineExecute,
      cancel: async (input) => {
        await executeRequest('execution.run.stream.cancel', input, { target: defaultTarget }, true);
      },
    });
    return Object.freeze({
      actions: createMachineActions(machineExecute),
      machines,
      sessions,
      runs,
      machine,
      close,
    });
  }

  const actions = createActions(execute);
  const sessions = createSessions({
    execute,
    spawn: (input, options) => execute('session.spawn_new', input, options),
    followTranscript,
    requireSessionId: (sessionId) => requireNonEmpty(sessionId, 'sessionId'),
  });
  const runs = createExecutionRuns<ActionExecutionOptions>({
    execute,
    cancel: async (input, options) => {
      await executeRequest('execution.run.stream.cancel', input, options, true);
    },
  });

  return Object.freeze({
    actions,
    machines,
    sessions,
    runs,
    machine,
    close,
  });
}

export function connect(options: HappierConnectOptions): HappierClient {
  const endpoint = normalizeEndpoint(options.endpoint);
  const token = requireNonEmpty(options.token, 'token');
  const controller = new AbortController();
  return createClient(endpoint, token, {
    controller,
    isClosed: () => controller.signal.aborted,
  });
}
