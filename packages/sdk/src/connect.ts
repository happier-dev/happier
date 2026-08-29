import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionApprovalRequestCreatedResult,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  ExternalActionHttpErrorV1Schema,
  ExternalActionRequestIdV1Schema,
  ExternalActionTargetV1Schema,
  parseExternalActionResponseEnvelopeV1,
  parseQualifiedPluginActionId,
} from '@happier-dev/protocol/actions';
import { parseAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { Agent, request as requestWithUndici } from 'undici';

import { createGeneratedActions, MUTATING_PUBLIC_ACTION_IDS } from './actions/generated.js';
import { waitForClientCleanupGrace } from './cleanupGrace.js';
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
  ActionTarget,
  ContributedActionId,
  HappierConnectOptions,
  PublicActionExecutionResult,
  RawActionExecute,
} from './types.js';
import type {
  PublicActionId,
  PublicActionInputById,
  PublicActionResultById,
} from './actions/generated.js';

function requireApiToken(value: string): string {
  if (parseAccountApiTokenBearerV1(value) === null) {
    throw new TypeError('token must be an exact Happier API Token');
  }
  return value;
}

function requireMachineId(value: string): string {
  const parsed = ExternalActionTargetV1Schema.safeParse({
    kind: 'machine',
    machineId: value,
  });
  if (!parsed.success || parsed.data.kind !== 'machine') {
    throw new TypeError('machineId must be a valid external Action target identifier');
  }
  return parsed.data.machineId;
}

function requireSessionId(value: string): string {
  const parsed = SessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError('sessionId must be a valid Happier Session identifier');
  }
  return parsed.data;
}

/**
 * Request identities consume the one Protocol-owned external Action request-id
 * schema exactly: the original value is sent unchanged, 1-128 code units are
 * admitted, Unicode is allowed, and outer whitespace is rejected — never
 * trimmed into a different correlation identity.
 */
function requireExternalActionRequestId(value: string): string {
  const parsed = ExternalActionRequestIdV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError('requestId must be 1-128 code units with no outer whitespace');
  }
  return parsed.data;
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


class ExternalActionResponseBodyTooLargeError extends Error {
  constructor() {
    super('The Happier API response exceeded the external Action response limit.');
    this.name = 'ExternalActionResponseBodyTooLargeError';
  }
}

type ExternalActionResponseBody = AsyncIterable<Uint8Array> & Readonly<{
  once?: (event: 'error', listener: (error: Error) => void) => unknown;
  destroy: (error?: Error) => unknown;
}>;

function rejectOversizedExternalActionResponse(body: ExternalActionResponseBody): never {
  const error = new ExternalActionResponseBodyTooLargeError();
  // Undici requires every response body to be consumed or explicitly
  // destroyed. Stop an oversized response immediately so it cannot occupy a
  // connection until the remote endpoint finishes sending it.
  body.once?.('error', () => undefined);
  body.destroy();
  throw error;
}

function declaredResponseByteLength(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): number | undefined {
  const raw = responseHeader(headers, 'content-length');
  if (raw === undefined || !/^[0-9]+$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * The server and daemon both cap one complete public Action response envelope.
 * Enforce that same ceiling while consuming the body so a misconfigured endpoint
 * cannot turn a finite API contract into an unbounded SDK allocation.
 */
async function readExternalActionResponseJson(
  body: ExternalActionResponseBody,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Promise<unknown> {
  const declaredLength = declaredResponseByteLength(headers);
  if (declaredLength !== undefined && declaredLength > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
    rejectOversizedExternalActionResponse(body);
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    byteLength += chunk.byteLength;
    if (byteLength > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
      rejectOversizedExternalActionResponse(body);
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
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

function parseDeferredApprovalRequest(
  value: unknown,
  actionId: string,
  requestId?: string,
): ActionApprovalRequestCreatedResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.kind !== 'approval_request_created') return null;

  const parsed = ActionApprovalRequestCreatedResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.actionId !== actionId) {
    throw new HappierTransportError(
      'The Happier Action API returned an invalid approval result.',
      { details: value, requestId },
    );
  }
  return parsed.data;
}

export type HappierActions = ReturnType<typeof createGeneratedActions> & Readonly<{
  execute: RawActionExecute;
  get: (
    input: PublicActionInputById['action.spec.get'],
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.spec.get'>>;
  search: (
    input: PublicActionInputById['action.spec.search'],
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.spec.search'>>;
  invoke: (
    action: ContributedActionId,
    input: unknown,
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.invoke'>>;
}>;

/** Per-call controls for an Action client already bound to one Machine. */
export type HappierMachineActionExecutionOptions = Readonly<Omit<ActionExecutionOptions, 'target'>>;

export type HappierMachineActionExecute = <K extends PublicActionId>(
  actionId: K,
  input: PublicActionInputById[K],
  options?: HappierMachineActionExecutionOptions,
) => Promise<PublicActionExecutionResult<K>>;

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
  ) => Promise<PublicActionExecutionResult<'action.spec.get'>>;
  search: (
    input: PublicActionInputById['action.spec.search'],
    options?: HappierMachineActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.spec.search'>>;
  invoke: (
    action: ContributedActionId,
    input: unknown,
    options?: HappierMachineActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.invoke'>>;
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
        await waitForClientCleanupGrace(Promise.allSettled([...cleanup].map((finalizer) => finalizer())));
        const destroy = Reflect.get(dispatcher, 'destroy') as unknown;
        if (typeof destroy === 'function') {
          await destroy.call(dispatcher);
        }
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

function assertMachineBoundTarget(
  target: unknown,
  boundTarget: MachineActionTarget,
  requestId?: string,
): void {
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
      requestId,
    },
  );
}

function createActions(execute: RawActionExecute): HappierActions {
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
    invoke: async (action: ContributedActionId, input: unknown, options?: ActionExecutionOptions) => {
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

function createMachineActions(execute: RawActionExecute): HappierMachineActions {
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
    requestId?: string;
    signal?: AbortSignal;
    allowAfterClose?: boolean;
  }>): Promise<unknown> => {
    if (lifecycle.isClosed() && params.allowAfterClose !== true) {
      throw new HappierClientClosedError(params.requestId);
    }
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
        throw new HappierClientClosedError(params.requestId);
      }
      if (params.signal?.aborted) throw params.signal.reason;
      throw new HappierTransportError('Could not reach the Happier API.', {
        requestId: params.requestId,
        cause: error,
      });
    }

    let body: unknown;
    try {
      body = await readExternalActionResponseJson(response.body, response.headers);
    } catch (error) {
      if (error instanceof ExternalActionResponseBodyTooLargeError) {
        throw new HappierTransportError(error.message, {
          code: 'response_too_large',
          status: response.statusCode,
          requestId: params.requestId,
          details: { maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES },
        });
      }
      if (lifecycle.controller.signal.aborted && params.allowAfterClose !== true) {
        throw new HappierClientClosedError(params.requestId);
      }
      if (params.signal?.aborted) throw params.signal.reason;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const code = responseHeader(response.headers, 'x-happier-retry-reason');
        throw new HappierTransportError(
          code === 'server_unavailable'
            ? 'The Happier API is unavailable.'
            : `The Happier API returned HTTP ${response.statusCode}.`,
          { code, status: response.statusCode, requestId: params.requestId },
        );
      }
      throw new HappierTransportError('The Happier API returned invalid JSON.', {
        status: response.statusCode,
        requestId: params.requestId,
        cause: error,
      });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new HappierTransportError(`The Happier API returned HTTP ${response.statusCode}.`, {
        code: transportErrorCode(body),
        status: response.statusCode,
        details: body,
        requestId: params.requestId,
      });
    }
    return body;
  };

  const executeRequest = async <K extends PublicActionId>(
    actionId: K,
    input: PublicActionInputById[K],
    options: ActionExecutionOptions = {},
    allowAfterClose = false,
    preserveDeferredApproval = true,
  ): Promise<PublicActionExecutionResult<K>> => {
    const requestId = options.requestId === undefined
      ? (MUTATING_PUBLIC_ACTION_IDS.has(actionId) ? globalThis.crypto.randomUUID() : undefined)
      : requireExternalActionRequestId(options.requestId);
    const requestBody = {
      v: 1 as const,
      ...(requestId === undefined ? {} : { requestId }),
      ...((options.target ?? defaultTarget) === undefined ? {} : { target: options.target ?? defaultTarget }),
      input,
    };

    const body = await requestJson({
      path: `v1/actions/${encodeURIComponent(actionId)}`,
      method: 'POST',
      body: JSON.stringify(requestBody),
      requestId,
      signal: options.signal,
      allowAfterClose,
    });
    const externalActionResponse = parseExternalActionResponseEnvelopeV1(body);
    if (
      !externalActionResponse
      || externalActionResponse.actionId !== actionId
      || externalActionResponse.requestId !== requestId
    ) {
      throw new HappierTransportError('The Happier Action API returned an invalid response envelope.', {
        details: body,
        requestId,
      });
    }
    if (!externalActionResponse.execution.ok) {
      throw new HappierActionError(
        externalActionResponse.execution.errorCode,
        externalActionResponse.execution.error,
        externalActionResponse.execution.details,
        requestId,
      );
    }
    const deferredApproval = parseDeferredApprovalRequest(
      externalActionResponse.execution.result,
      actionId,
      requestId,
    );
    if (preserveDeferredApproval === false && deferredApproval !== null) {
      throw new HappierActionError(
        'approval_required',
        `The ${actionId} Action requires user approval before it can execute.`,
        deferredApproval,
        requestId,
      );
    }
    return (deferredApproval ?? externalActionResponse.execution.result) as PublicActionExecutionResult<K>;
  };
  const rawExecute: RawActionExecute = (actionId, input, options) => executeRequest(actionId, input, options);
  const executeCompletedRequest = async <K extends PublicActionId>(
    actionId: K,
    input: PublicActionInputById[K],
    options?: ActionExecutionOptions,
  ): Promise<PublicActionResultById[K]> => {
    return await executeRequest(actionId, input, options, false, false) as PublicActionResultById[K];
  };
  const execute: ActionExecute = executeCompletedRequest;
  const createExecutionRuns = <TOptions extends ActionExecutionOptions>(params: Readonly<{
    execute: ActionExecute;
    cancel: (
      input: PublicActionInputById['execution.run.stream.cancel'],
      options: Readonly<Pick<ActionExecutionOptions, 'target'>>,
    ) => Promise<void>;
    sessionTarget?: (sessionId: string) => ActionTarget;
  }>): HappierExecutionRuns<TOptions> => Object.freeze({
    startStream: async (input, options) => {
      const sessionId = typeof input.sessionId === 'string'
        ? requireSessionId(input.sessionId) : undefined;
      const scope = sessionId === undefined ? {} : { sessionId };
      const target = options?.target ?? (sessionId === undefined ? undefined : params.sessionTarget?.(sessionId));
      const routing = target === undefined ? {} : { target };
      const effectiveOptions = target === undefined ? options : { ...(options ?? {}), target };
      return await startExecutionRunStream({
        runId: input.runId,
        start: () => params.execute('execution.run.stream.start', input, effectiveOptions),
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

  const createFollowTranscript = (
    transcriptExecute: ActionExecute,
    targetForSession: (sessionId: string) => ActionTarget,
  ) => (sessionId: string, options?: FollowTranscriptOptions) => {
    const id = requireSessionId(sessionId);
    const target = targetForSession(id);
    const scopedExecute: ActionExecute = (actionId, input, executeOptions) => transcriptExecute(
      actionId,
      input,
      executeOptions?.target === undefined ? { ...(executeOptions ?? {}), target } : executeOptions,
    );
    return createTranscriptIterable({
      execute: scopedExecute,
      release: async (input) => {
        await executeRequest('transcript.unfollow', input, { target }, true);
      },
      sessionId: id,
      closeSignal: lifecycle.controller.signal,
      registerCloseCleanup: lifecycle.registerCloseCleanup,
      options,
    });
  };
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
    machineId: requireMachineId(machineId),
  });
  if (defaultTarget !== undefined) {
    const machineRawExecute: RawActionExecute = async (actionId, input, options) => {
      assertMachineBoundTarget(options?.target, defaultTarget, options?.requestId);
      return await executeRequest(actionId, input, { ...(options ?? {}), target: defaultTarget });
    };
    const machineExecute: ActionExecute = async <K extends PublicActionId>(
      actionId: K,
      input: PublicActionInputById[K],
      options?: ActionExecutionOptions,
    ): Promise<PublicActionResultById[K]> => {
      assertMachineBoundTarget(options?.target, defaultTarget, options?.requestId);
      return await executeRequest(
        actionId,
        input,
        { ...(options ?? {}), target: defaultTarget },
        false,
        false,
      ) as PublicActionResultById[K];
    };
    const sessions = createMachineSessions({
      execute: machineExecute,
      followTranscript: createFollowTranscript(machineExecute, () => defaultTarget),
      requireSessionId,
      spawn: (input, options) => machineExecute('session.spawn_new', input, options),
    });
    const runs = createExecutionRuns<HappierMachineActionExecutionOptions>({
      execute: machineExecute,
      cancel: async (input) => {
        await executeRequest('execution.run.stream.cancel', input, { target: defaultTarget }, true);
      },
    });
    return Object.freeze({
      actions: createMachineActions(machineRawExecute),
      machines,
      sessions,
      runs,
      machine,
      close: lifecycle.close,
    });
  }

  const actions = createActions(rawExecute);
  const sessionTarget = (sessionId: string): ActionTarget => ({ kind: 'session', sessionId });
  const followTranscript = createFollowTranscript(execute, sessionTarget);
  const sessions = createSessions({
    execute,
    sessionTarget,
    spawn: (input, options) => execute('session.spawn_new', input, options),
    followTranscript,
    requireSessionId,
  });
  const runs = createExecutionRuns<ActionExecutionOptions>({
    execute,
    sessionTarget,
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
  const token = requireApiToken(options.token);
  return createClient(endpoint, token, createClientLifecycle());
}
