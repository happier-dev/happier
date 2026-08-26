import {
  ExternalActionHttpErrorV1Schema,
  parseExternalActionResponseEnvelopeV1,
  parseQualifiedPluginActionId,
} from '@happier-dev/protocol/actions';
import { Agent, request as requestWithUndici } from 'undici';

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

const CLIENT_CLOSE_CLEANUP_GRACE_MS = 1_000;

async function waitForCloseCleanup(cleanup: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLIENT_CLOSE_CLEANUP_GRACE_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function transportErrorCode(body: unknown): string | undefined {
  const externalActionError = ExternalActionHttpErrorV1Schema.safeParse(body);
  if (externalActionError.success) return externalActionError.data.code;
  if (body === null || typeof body !== 'object') return undefined;
  const candidate = body as Readonly<{ error?: unknown }>;
  return typeof candidate.error === 'string' ? candidate.error : undefined;
}

function responseHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isDeferredApprovalRequest(
  value: unknown,
  actionId: string,
): value is Readonly<{
  kind: 'approval_request_created';
  artifactId: string;
  actionId: string;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.kind === 'approval_request_created'
    && typeof candidate.artifactId === 'string'
    && candidate.artifactId.trim().length > 0
    && candidate.actionId === actionId;
}

export type HappierActions = ReturnType<typeof createGeneratedActions> & Readonly<{
  execute: ActionExecute;
  get: (
    input: PublicActionInputById['action.spec.get'],
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionResultById['action.spec.get']>;
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
  get: (
    input: PublicActionInputById['action.spec.get'],
    options?: HappierMachineActionExecutionOptions,
  ) => Promise<PublicActionResultById['action.spec.get']>;
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
  close: () => Promise<void>;
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

type ClientCloseCleanup = () => Promise<void>;

type ClientLifecycle = Readonly<{
  controller: AbortController;
  dispatcher: Agent;
  isClosed: () => boolean;
  close: () => Promise<void>;
  registerCloseCleanup: (cleanup: ClientCloseCleanup) => () => void;
}>;

function createClientLifecycle(): ClientLifecycle {
  const controller = new AbortController();
  const dispatcher = new Agent();
  const cleanup = new Set<ClientCloseCleanup>();
  let closePromise: Promise<void> | undefined;

  const registerCloseCleanup = (finalizer: ClientCloseCleanup) => {
    cleanup.add(finalizer);
    return () => cleanup.delete(finalizer);
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;

    let resolveClose: (() => void) | undefined;
    let rejectClose: ((reason?: unknown) => void) | undefined;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });

    controller.abort(new HappierClientClosedError());
    void (async () => {
      try {
        await waitForCloseCleanup(Promise.allSettled([...cleanup].map((finalizer) => finalizer())));
        await dispatcher.destroy();
        resolveClose?.();
      } catch (error) {
        rejectClose?.(error);
      }
    })();
    return closePromise;
  };

  return {
    controller,
    dispatcher,
    isClosed: () => controller.signal.aborted,
    close,
    registerCloseCleanup,
  };
}

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
    get: (input: PublicActionInputById['action.spec.get'], options?: ActionExecutionOptions) => (
      execute('action.spec.get', input, options)
    ),
    search: (input: PublicActionInputById['action.spec.search'], options?: ActionExecutionOptions) => (
      execute('action.spec.search', input, options)
    ),
    invoke: (action: ContributedActionId, input: unknown, options?: ActionExecutionOptions) => {
      const identity = typeof action === 'string' ? parseQualifiedPluginActionId(action) : action;
      if (identity === null) {
        throw new TypeError(
          'Contributed Action id must use the canonical <pluginId>/actions/<localId> spelling.',
        );
      }
      return execute('action.invoke', { action: identity, input }, options);
    },
  });
}

function createMachineActions(execute: ActionExecute): HappierMachineActions {
  return createActions(execute);
}

function createClient(
  endpoint: URL,
  token: string,
  lifecycle: ClientLifecycle,
): HappierClient;
function createClient(
  endpoint: URL,
  token: string,
  lifecycle: ClientLifecycle,
  defaultTarget: MachineActionTarget,
): HappierMachineClient;
function createClient(
  endpoint: URL,
  token: string,
  lifecycle: ClientLifecycle,
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
    let response: Awaited<ReturnType<typeof requestWithUndici>>;
    try {
      // Session Actions may wait for their declared maximum. Native Node fetch
      // applies Undici's hidden 300-second header limit, which is shorter than
      // a valid Action wait. Caller cancellation remains the SDK deadline.
      response = await requestWithUndici(new URL(params.path, endpoint), {
        method: params.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(params.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(params.body === undefined ? {} : { body: params.body }),
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        dispatcher: lifecycle.dispatcher,
        headersTimeout: 0,
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
      body = await response.body.json();
    } catch (error) {
      if (lifecycle.controller.signal.aborted && params.allowAfterClose !== true) {
        throw lifecycle.controller.signal.reason;
      }
      if (params.signal?.aborted) throw params.signal.reason;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const code = responseHeader(response.headers, 'x-happier-retry-reason');
        throw new HappierTransportError(
          code === 'server_unavailable'
            ? 'The Happier API is unavailable.'
            : `The Happier API returned HTTP ${response.statusCode}.`,
          { code, status: response.statusCode },
        );
      }
      throw new HappierTransportError('The Happier API returned invalid JSON.', {
        status: response.statusCode,
        cause: error,
      });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new HappierTransportError(`The Happier API returned HTTP ${response.statusCode}.`, {
        code: transportErrorCode(body),
        status: response.statusCode,
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
    if (isDeferredApprovalRequest(externalActionResponse.execution.result, actionId)) {
      throw new HappierActionError(
        'approval_required',
        `The ${actionId} Action requires user approval before it can execute.`,
        externalActionResponse.execution.result,
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
        registerCloseCleanup: lifecycle.registerCloseCleanup,
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
      registerCloseCleanup: lifecycle.registerCloseCleanup,
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
      close: lifecycle.close,
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
    close: lifecycle.close,
  });
}

export function connect(options: HappierConnectOptions): HappierClient {
  const endpoint = normalizeEndpoint(options.endpoint);
  const token = requireNonEmpty(options.token, 'token');
  return createClient(endpoint, token, createClientLifecycle());
}
