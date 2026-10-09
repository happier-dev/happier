import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2, ExternalActionHttpErrorSchema, ExternalActionHttpErrorV1Schema, ExternalActionRequestIdV1Schema, ExternalActionTargetV1Schema, parseExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { parseSessionListQueryActionResultV1, SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE } from '@happier-dev/protocol/sessions/awareness/action';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { SessionListActionInputV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import { ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, ACCOUNT_API_TOKEN_CHILDREN_CREATE_HTTP_PATH_V1, ACCOUNT_API_TOKEN_CHILDREN_REVOKE_HTTP_PATH_V1, ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, AccountApiTokenChildCreateRequestV1Schema, AccountApiTokenChildRevokeRequestV1Schema, AccountApiTokenSelfV1Schema, AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensServerErrorV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import type { AccountApiTokenChildCreateRequestV1, AccountApiTokenSelfV1, AccountApiTokensCreateActionOutputV1, AccountApiTokensRevokeActionOutputV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import { createHttpExchange } from '#http';
import type { HttpExchange, HttpResponse, HttpResponseBody } from './http/httpExchange.js';

import { createGeneratedActions, MUTATING_PUBLIC_ACTION_IDS } from './actions/generated.js';
import { createClientCredential, waitForClientMaterial, type ClientCredential } from './clientCredential.js';
import { waitForClientCleanupGrace } from './cleanupGrace.js';
import { HappierActionError, HappierClientClosedError, HappierTransportError } from './errors.js';
import { createSessionController } from './live/sessionController.js';
import { createSessionContentEncryption, openSessionDataKey } from './live/openSessionDataKey.js';
import { createEmbed, type HappierEmbed } from './fluent/embed.js';
import type { HappierSessionLiveOptions } from './live/types.js';
import {
  createMachineSessions,
  createSessions,
  type HappierMachineSessions,
  type HappierSessions,
} from './fluent/sessions.js';
import {
  parseMachineBootstrapRows,
  parseMachineListResponse,
  resolveMachineProtectedActionMaterial,
  type HappierMachine,
  type MachineListOptions,
  type ProtectedActionMaterial,
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

/**
 * The declared output contract of one public Action, read by identity. Every
 * entry is the same Protocol schema the executing daemon settles its result
 * through; this view keeps the lookup uniform so a generic Action id does not
 * instantiate 400 per-id schema types at the call site.
 */
type PublicActionOutputParser = Readonly<{
  safeParse(value: unknown): Readonly<{ success: true; data: unknown }> | Readonly<{ success: false }>;
}>;

const PUBLIC_ACTION_OUTPUT_PARSERS: Readonly<Record<PublicActionId, PublicActionOutputParser>> =
  PUBLIC_ACTION_OUTPUT_SCHEMAS;

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

function rejectOversizedExternalActionResponse(body: HttpResponseBody): never {
  const error = new ExternalActionResponseBodyTooLargeError();
  // Stop an oversized response immediately rather than retaining its connection
  // or browser stream until the endpoint finishes sending it.
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
  body: HttpResponseBody,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  maximumBytes = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
): Promise<unknown> {
  const declaredLength = declaredResponseByteLength(headers);
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    rejectOversizedExternalActionResponse(body);
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    byteLength += chunk.byteLength;
    if (byteLength > maximumBytes) {
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

function transportErrorCode(
  body: unknown,
  mode: 'ordinary' | 'credential_bootstrap' | 'protected_action',
  expectedRequestId?: string,
): string | undefined {
  if (mode === 'protected_action') {
    const externalActionError = ExternalActionHttpErrorSchema.safeParse(body);
    if (!externalActionError.success) return undefined;
    if ('requestId' in externalActionError.data
      && externalActionError.data.requestId !== undefined
      && externalActionError.data.requestId !== expectedRequestId) return undefined;
    return 'code' in externalActionError.data
      ? externalActionError.data.code
      : externalActionError.data.error;
  }
  if (mode === 'credential_bootstrap') {
    const apiTokenError = AccountApiTokensServerErrorV1Schema.safeParse(body);
    return apiTokenError.success ? apiTokenError.data.error : undefined;
  }
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
    input: PublicActionInputById['action.invoke']['input'],
    options?: ActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.invoke'>>;
}>;

/** Per-call controls for an Action client already bound to one Machine. */
export type HappierMachineActionExecutionOptions = Readonly<
  Omit<ActionExecutionOptions, 'target'> & { project?: WorkflowProjectTargetV1 }
>;

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
    input: PublicActionInputById['action.invoke']['input'],
    options?: HappierMachineActionExecutionOptions,
  ) => Promise<PublicActionExecutionResult<'action.invoke'>>;
}>;

export type HappierExecutionRuns<TOptions extends ActionExecutionOptions = ActionExecutionOptions> = Readonly<{
  startStream: (
    input: PublicActionInputById['execution.run.stream.start'],
    options?: TOptions,
  ) => Promise<HappierExecutionRunStream>;
}>;

/**
 * The endpoint does not serve the Machine bootstrap projection at all. That is
 * not evidence about the target Machine, so it must not be confused with a
 * Runner whose published key failed to resolve.
 */
const MACHINE_BOOTSTRAP_UNAVAILABLE = Symbol('happier.sdk.machineBootstrapUnavailable');

/**
 * Only a route the endpoint does not serve states that. A network, auth or
 * availability failure is evidence about this read, not about the projection,
 * and it keeps its own typed error instead of moving the failure to the target.
 */
function isMachineBootstrapNotServed(error: unknown): boolean {
  return error instanceof HappierTransportError
    && (error.status === 404 || error.status === 405);
}

export type HappierMachineExecutionRuns = HappierExecutionRuns<HappierMachineActionExecutionOptions>;

/** Home-owned token operations, independent of a Machine or Action target. */
export type HappierApiTokens = Readonly<{
  createChild: (
    input: Omit<AccountApiTokenChildCreateRequestV1, 'tokenId'>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<AccountApiTokensCreateActionOutputV1>;
  revokeChild: (
    tokenId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<AccountApiTokensRevokeActionOutputV1>;
  self: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<AccountApiTokenSelfV1>;
}>;

const ChildTokenCreateInputSchema = AccountApiTokenChildCreateRequestV1Schema.omit({ tokenId: true });

export type HappierClient = Readonly<{
  actions: HappierActions;
  apiTokens: HappierApiTokens;
  embed: HappierEmbed;
  machines: Readonly<{
    list: (options?: MachineListOptions) => Promise<readonly HappierMachine[]>;
  }>;
  sessions: HappierSessions;
  runs: HappierExecutionRuns;
  machine: (machineId: string) => HappierMachineClient;
  close: () => Promise<void>;
}>;

export type HappierMachineClient = Readonly<
  Omit<HappierClient, 'actions' | 'machine' | 'sessions' | 'runs' | 'embed'> & Readonly<{
    actions: HappierMachineActions;
    sessions: HappierMachineSessions;
    runs: HappierMachineExecutionRuns;
    machine: (machineId: string) => HappierMachineClient;
  }>
>;

type MachineActionTarget = Extract<ActionTarget, { kind: 'machine' }>;

type ClientCloseCleanup = () => Promise<void>;

type ClientLifecycle = Readonly<{
  controller: AbortController;
  http: HttpExchange;
  isClosed: () => boolean;
  close: () => Promise<void>;
  registerCloseCleanup: (cleanup: ClientCloseCleanup) => () => void;
}>;

function createClientLifecycle(disposeCredential: () => void): ClientLifecycle {
  const controller = new AbortController();
  const http = createHttpExchange();
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
        await http.close();
        resolveClose?.();
      } catch (error) {
        rejectClose?.(error);
      } finally {
        disposeCredential();
      }
    })();
    return closePromise;
  };

  return {
    controller,
    http,
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

function bindMachineActionExecutionOptions(
  options: ActionExecutionOptions | HappierMachineActionExecutionOptions | undefined,
  boundTarget: MachineActionTarget,
): ActionExecutionOptions {
  const runtimeOptions = options as Readonly<
    ActionExecutionOptions & { project?: WorkflowProjectTargetV1 }
  > | undefined;
  assertMachineBoundTarget(runtimeOptions?.target, boundTarget, runtimeOptions?.requestId);
  const targetFromRuntime = runtimeOptions?.target?.kind === 'machine'
    ? runtimeOptions.target
    : undefined;
  const project = runtimeOptions?.project ?? targetFromRuntime?.project;
  const parsedTarget = ExternalActionTargetV1Schema.safeParse({
    kind: 'machine',
    machineId: boundTarget.machineId,
    ...(project ? { project } : {}),
  });
  if (!parsedTarget.success || parsedTarget.data.kind !== 'machine') {
    throw new HappierTransportError(
      'A machine-bound Happier client cannot execute an Action against a project on a different Machine.',
      {
        code: 'machine_target_conflict',
        details: { requestedProject: project, boundTarget },
        requestId: runtimeOptions?.requestId,
      },
    );
  }
  return {
    ...(runtimeOptions?.signal ? { signal: runtimeOptions.signal } : {}),
    ...(runtimeOptions?.requestId !== undefined ? { requestId: runtimeOptions.requestId } : {}),
    target: parsedTarget.data,
  };
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
    invoke: async (action: ContributedActionId, input: PublicActionInputById['action.invoke']['input'], options?: ActionExecutionOptions) => {
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
  credential: ClientCredential,
  lifecycle: ClientLifecycle,
): HappierClient;
function createClient(
  endpoint: URL,
  credential: ClientCredential,
  lifecycle: ClientLifecycle,
  defaultTarget: MachineActionTarget,
): HappierMachineClient;
function createClient(
  endpoint: URL,
  credential: ClientCredential,
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
    protectedResponse?: boolean;
  }>): Promise<unknown> => {
    if (lifecycle.isClosed() && params.allowAfterClose !== true) {
      throw new HappierClientClosedError(params.requestId);
    }
    const requestSignal = params.allowAfterClose === true
      ? params.signal
      : combinedSignal(params.signal, lifecycle.controller.signal);
    let response: HttpResponse;
    try {
      response = await lifecycle.http.request(new URL(params.path, endpoint), {
        method: params.method,
        headers: {
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
          authorization: `Bearer ${credential.bearer}`,
          ...(params.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(params.body === undefined ? {} : { body: params.body }),
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
    } catch (error) {
      if (lifecycle.controller.signal.aborted && params.allowAfterClose !== true) {
        throw new HappierClientClosedError(params.requestId);
      }
      if (params.signal?.aborted) throw params.signal.reason;
      throw new HappierTransportError('Could not reach the Happier API.', {
        requestId: params.requestId,
        ...(credential.encryption ? {} : { cause: error }),
      });
    }

    const responseMaximumBytes = params.protectedResponse
      ? EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2
      : EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES;
    let body: unknown;
    try {
      body = await readExternalActionResponseJson(response.body, response.headers,
        responseMaximumBytes);
    } catch (error) {
      if (error instanceof ExternalActionResponseBodyTooLargeError) {
        throw new HappierTransportError(error.message, {
          code: 'response_too_large',
          status: response.statusCode,
          requestId: params.requestId,
          details: { maxSerializedBytes: responseMaximumBytes },
        });
      }
      if (lifecycle.controller.signal.aborted && params.allowAfterClose !== true) {
        throw new HappierClientClosedError(params.requestId);
      }
      if (params.signal?.aborted) throw params.signal.reason;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const retryReason = responseHeader(response.headers, 'x-happier-retry-reason');
        const code = credential.encryption && retryReason !== 'server_unavailable' ? undefined : retryReason;
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
        ...(credential.encryption ? {} : { cause: error }),
      });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      // Protected clients expose only the Protocol's bounded error vocabulary,
      // never arbitrary server strings or response details containing content.
      throw new HappierTransportError(`The Happier API returned HTTP ${response.statusCode}.`, {
        code: transportErrorCode(
          body,
          params.protectedResponse || (params.protectedResponse === false && credential.encryption)
            ? 'protected_action'
            : credential.encryption
              ? 'credential_bootstrap'
              : 'ordinary',
          params.requestId,
        ),
        status: response.statusCode,
        ...(credential.encryption ? {} : { details: body }),
        requestId: params.requestId,
      });
    }
    return body;
  };

  const requestApiToken = async (path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal) => {
    try {
      return await requestJson({ path: path.slice(1), method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    } catch (error) {
      if (error instanceof HappierTransportError
        && (error.status === 404 || error.status === 405 || error.status === 501)) {
        throw new HappierTransportError('This endpoint does not support Home API-token operations.', {
          code: 'unsupported_endpoint', status: error.status,
        });
      }
      throw error;
    }
  };
  const invalidApiTokenOutput = () => new HappierTransportError('The Home returned an invalid API-token response.', {
    code: 'invalid_api_token_output',
  });
  const apiTokens = Object.freeze({
    async createChild(input, options) {
      const parsedInput = ChildTokenCreateInputSchema.parse(input);
      const tokenId = globalThis.crypto.randomUUID();
      const result = AccountApiTokensCreateActionOutputV1Schema.safeParse(await requestApiToken(
        ACCOUNT_API_TOKEN_CHILDREN_CREATE_HTTP_PATH_V1, 'POST', { ...parsedInput, tokenId }, options?.signal,
      ));
      if (!result.success || result.data.apiToken.tokenId !== tokenId) throw invalidApiTokenOutput();
      return result.data;
    },
    async revokeChild(tokenId, options) {
      const input = AccountApiTokenChildRevokeRequestV1Schema.parse({ tokenId });
      const result = AccountApiTokensRevokeActionOutputV1Schema.safeParse(await requestApiToken(
        ACCOUNT_API_TOKEN_CHILDREN_REVOKE_HTTP_PATH_V1, 'POST', input, options?.signal,
      ));
      if (!result.success) throw invalidApiTokenOutput();
      return result.data;
    },
    async self(options) {
      const result = AccountApiTokenSelfV1Schema.safeParse(await requestApiToken(
        ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, 'GET', undefined, options?.signal,
      ));
      if (!result.success) throw invalidApiTokenOutput();
      return result.data;
    },
  } satisfies HappierApiTokens);

  const executeRequest = async <K extends PublicActionId>(
    actionId: K,
    input: PublicActionInputById[K],
    options: ActionExecutionOptions = {},
    allowAfterClose = false,
    preserveDeferredApproval = true,
  ): Promise<PublicActionExecutionResult<K>> => {
    if (lifecycle.isClosed() && !allowAfterClose) throw new HappierClientClosedError(options.requestId);
    options.signal?.throwIfAborted();
    const sessionListInput = actionId === 'session.list'
      ? SessionListActionInputV1Schema.parse(input)
      : undefined;
    const requestInput = sessionListInput ?? input;
    const requiresSessionListQueryProof = sessionListInput?.query !== undefined;
    const requestId = options.requestId === undefined
      ? (credential.encryption || MUTATING_PUBLIC_ACTION_IDS.has(actionId) ? globalThis.crypto.randomUUID() : undefined)
      : requireExternalActionRequestId(options.requestId);
    const requestBody = {
      v: 1 as const,
      ...(requestId === undefined ? {} : { requestId }),
      ...((options.target ?? defaultTarget) === undefined ? {} : { target: options.target ?? defaultTarget }),
      input: requestInput,
    };

    let protectedInvocation;
    let releaseMachineMaterial: (() => void) | undefined;
    try {
      const encryption = credential.encryption;
      if (encryption) {
        const target = ExternalActionTargetV1Schema.safeParse(options.target ?? defaultTarget);
        if (!target.success) throw new HappierTransportError('An encrypted Action requires an explicit target.', {
          code: 'target_required', requestId,
        });
        const getAccountMaterial = () => encryption.getMaterial(() => requestJson({
          path: ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1.slice(1), method: 'POST', body: '{}',
          allowAfterClose,
        }));
        // A shared Machine uses its current recipient content key; a Plain
        // Machine selects the existing V1 envelope independently of Account mode.
        // A restricted Runner holds no Account material: a request sealed with
        // the Account key would be unreadable there. Its own Machine content key
        // is the one thing that opens it, and that key is reachable only through
        // the creator-signed published binding — so an unresolvable Runner target
        // fails closed rather than downgrading to Account-only sealing.
        // A Runner is named either by its Machine id or by the exact Session it
        // was activated for; the Session spelling is accepted only through the
        // Runner's activation-signed claim, verified by the same resolution. The
        // two id spaces stay distinguishable in the per-credential memo key.
        const runnerTargetKey = target.data.kind === 'machine'
          ? `machine:${target.data.machineId}`
          : `session:${target.data.sessionId}`;
        // The bootstrap projection is what names a Runner target. When an
        // endpoint does not serve it — a daemon-hosted Action API does not — the
        // released Account sealing stands: that request is still readable only by
        // an Account-material holder, so nothing is disclosed, and a Runner that
        // cannot open it fails closed exactly as it did before. What must never
        // happen is sealing a *known* Runner target with anything but that
        // Runner's verified content key, and that resolution throws instead.
        let material: ProtectedActionMaterial | undefined;
        try {
          // Concurrent bootstrap waiters share the network read, not cancellation.
          // Only an immutable Runner selection is retained after it settles.
          const machineMaterialPromise = encryption.getMachineMaterial(runnerTargetKey, async () => {
            const rows = parseMachineBootstrapRows(await requestJson({
              path: 'v1/machines',
              method: 'GET',
              allowAfterClose,
            }).catch((error: unknown) => {
              throw isMachineBootstrapNotServed(error) ? MACHINE_BOOTSTRAP_UNAVAILABLE : error;
            }));
            const resolveMaterial = (accountMaterial?: ProtectedActionMaterial) => resolveMachineProtectedActionMaterial({
              rows,
              target: target.data,
              homeServerIdentityId: encryption.pins.serverIdentityId,
              accountId: encryption.pins.accountId,
              accountMaterial,
            });
            let resolution = resolveMaterial();
            if (resolution.kind === 'account' || resolution.kind === 'needs_account_material') {
              const accountMaterial = await getAccountMaterial();
              resolution = resolveMaterial(accountMaterial);
              if (resolution.kind === 'account') return { kind: 'account', material: accountMaterial };
            }
            if (resolution.kind === 'unavailable' || resolution.kind === 'needs_account_material') {
              throw new HappierTransportError('The target Machine published no usable encryption key.', {
                code: 'invalid_encrypted_envelope', requestId,
              });
            }
            return resolution;
          });
          try {
            const resolved = allowAfterClose ? await machineMaterialPromise : await waitForClientMaterial(
              machineMaterialPromise, combinedSignal(options.signal, lifecycle.controller.signal),
            );
            releaseMachineMaterial = () => encryption.releaseMachineMaterial(resolved);
            material = resolved.kind === 'plain' ? undefined : resolved.material;
          } catch (error) {
            // A canceled waiter does not own the shared bootstrap's lifetime.
            // Release its material when that bootstrap settles, without canceling peers.
            void machineMaterialPromise.then(encryption.releaseMachineMaterial, () => undefined);
            throw error;
          }
        } catch (error) {
          if (error !== MACHINE_BOOTSTRAP_UNAVAILABLE) throw error;
          const materialPromise = getAccountMaterial();
          material = allowAfterClose ? await materialPromise : await waitForClientMaterial(
            materialPromise, combinedSignal(options.signal, lifecycle.controller.signal),
          );
        }
        if (material) {
          const binding = { serverIdentityId: encryption.pins.serverIdentityId,
            accountId: encryption.pins.accountId, credentialId: encryption.pins.tokenId,
            actionId, requestId: requestId!, target: target.data };
          try {
            protectedInvocation = { material, binding, request: sealExternalActionRequestV2({ binding, input: requestInput, material,
              randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)) }) };
          } catch {
            throw new HappierTransportError('The encrypted Action request could not be prepared.', {
              code: 'invalid_encrypted_envelope', requestId,
            });
          }
        }
      }
      const body = await requestJson({
        path: `v1/actions/${encodeURIComponent(actionId)}`,
        method: 'POST',
        body: JSON.stringify(protectedInvocation?.request ?? requestBody),
        requestId,
        signal: options.signal,
        allowAfterClose,
        protectedResponse: protectedInvocation !== undefined,
      });
      const openedExecution = protectedInvocation
        ? openExternalActionResponseV2({ ...protectedInvocation, envelope: body }) : undefined;
      const externalActionResponse = protectedInvocation
        ? (openedExecution ? { actionId, requestId, execution: openedExecution } : null)
        : parseExternalActionResponseEnvelopeV1(body);
      if (
        !externalActionResponse
        || externalActionResponse.actionId !== actionId
        || externalActionResponse.requestId !== requestId
      ) {
        throw new HappierTransportError('The Happier Action API returned an invalid response envelope.', {
          ...(protectedInvocation ? { code: 'invalid_encrypted_envelope' } : { details: body }),
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
      if (
        deferredApproval === null
        && actionId === 'session.list'
        && requiresSessionListQueryProof
        && !parseSessionListQueryActionResultV1(externalActionResponse.execution.result)
      ) {
        throw new HappierActionError(
          SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
          SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
          undefined,
          requestId,
        );
      }
      if (deferredApproval !== null) return deferredApproval as PublicActionExecutionResult<K>;
      // A typed public result is a Protocol contract, not a transport promise.
      // The declared output schema — the same one the executing daemon settles
      // its result through — is what makes the returned value that type, so a
      // response that does not satisfy it fails closed instead of being cast.
      const output = PUBLIC_ACTION_OUTPUT_PARSERS[actionId].safeParse(
        externalActionResponse.execution.result,
      );
      if (!output.success) {
        // Protected clients expose only the bounded error vocabulary, never the
        // response content that failed to parse.
        throw new HappierTransportError(`The ${actionId} Action returned an invalid result.`, {
          code: 'invalid_action_output',
          requestId,
          ...(credential.encryption ? {} : { details: externalActionResponse.execution.result }),
        });
      }
      return output.data as PublicActionExecutionResult<K>;
    } finally {
      releaseMachineMaterial?.();
    }
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
  const createLiveSession = (liveExecute: ActionExecute, targetForSession: (sessionId: string) => ActionTarget) =>
    (sessionId: string, options?: HappierSessionLiveOptions) => {
      const id = requireSessionId(sessionId);
      const target = targetForSession(id);
      const scopedExecute: ActionExecute = (actionId, input, executionOptions) => liveExecute(actionId, input, {
        ...executionOptions, target,
      });
      return createSessionController({
        endpoint: endpoint.origin, token: credential.bearer, sessionId: id,
        hasContentCredential: credential.encryption !== undefined,
        read: (path, signal) => requestJson({ path, method: 'GET', signal }),
        execute: scopedExecute,
        release: async (leaseId) => { await executeRequest('transcript.unfollow', { sessionId: id, leaseId }, { target }, true); },
        openContent: async (session, signal) => {
          if (session.encryptionMode === 'plain') return { context: { mode: 'plain' }, dispose: () => undefined };
          if (!credential.encryption) throw new HappierTransportError('The Session content is locked.', { code: 'session_content_locked' });
          const material = await waitForClientMaterial(credential.encryption.getMaterial(() => requestJson({
            path: ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1.slice(1), method: 'POST', body: '{}',
          })), signal);
          signal.throwIfAborted();
          const key = openSessionDataKey(session.dataEncryptionKey, material.machineKey);
          return { context: { mode: 'e2ee', encryption: createSessionContentEncryption(key) }, dispose: () => key.fill(0) };
        },
        closeSignal: lifecycle.controller.signal, registerCloseCleanup: lifecycle.registerCloseCleanup, options,
      });
    };
  const machine = (machineId: string) => createClient(endpoint, credential, lifecycle, {
    kind: 'machine',
    machineId: requireMachineId(machineId),
  });
  if (defaultTarget !== undefined) {
    const machineRawExecute: RawActionExecute = async (actionId, input, options) => {
      return await executeRequest(
        actionId,
        input,
        bindMachineActionExecutionOptions(options, defaultTarget),
      );
    };
    const machineExecute: ActionExecute = async <K extends PublicActionId>(
      actionId: K,
      input: PublicActionInputById[K],
      options?: ActionExecutionOptions,
    ): Promise<PublicActionResultById[K]> => {
      return await executeRequest(
        actionId,
        input,
        bindMachineActionExecutionOptions(options, defaultTarget),
        false,
        false,
      ) as PublicActionResultById[K];
    };
    const sessions = createMachineSessions({
      execute: machineExecute,
      followTranscript: createFollowTranscript(machineExecute, () => defaultTarget),
      live: createLiveSession(machineExecute, () => defaultTarget),
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
      apiTokens,
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
    live: createLiveSession(execute, sessionTarget),
    requireSessionId,
  });
  const encryption = credential.encryption;
  const embed = createEmbed({
    apiTokens,
    machineSessions: (machineId) => machine(machineId).sessions,
    sessions,
    requireSessionId,
    readSession: (sessionId, signal) => requestJson({ path: `v2/sessions/${encodeURIComponent(sessionId)}`, method: 'GET', signal }),
    getAccountMaterial: encryption === undefined ? undefined : (signal) => waitForClientMaterial(
      encryption.getMaterial(() => requestJson({
        path: ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1.slice(1), method: 'POST', body: '{}',
      })), signal ?? lifecycle.controller.signal,
    ),
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
    apiTokens,
    embed,
    machines,
    sessions,
    runs,
    machine,
    close: lifecycle.close,
  });
}

export function connect(options: HappierConnectOptions): HappierClient {
  const endpoint = normalizeEndpoint(options.endpoint);
  const credential = createClientCredential(options.token);
  return createClient(endpoint, credential, createClientLifecycle(credential.dispose));
}
