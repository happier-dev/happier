import type { AcpTier2PermissionDecisionResultV1 } from '@happier-dev/plugin-sdk';

import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { logger } from '@/ui/logger';

import type { AcpRuntimeDefinitionV1 } from './_types';

export type AcpTier2CallbackName =
  | 'argvBuilder'
  | 'envBuilder'
  | 'preflight'
  | 'permissionDecision';

export type MaybePromise<T> = T | Promise<T>;

export class AcpTier2CallbackError extends Error {
  readonly code = 'HAPPIER_ACP_TIER2_CALLBACK_ERROR';
  readonly backendId: string;
  readonly callback: AcpTier2CallbackName;
  readonly startupFailure: boolean;
  readonly cause: unknown;

  constructor(params: Readonly<{
    backendId: string;
    callback: AcpTier2CallbackName;
    message: string;
    cause?: unknown;
    startupFailure?: boolean;
  }>) {
    super(`ACP backend '${params.backendId}' ${params.callback} callback failed: ${params.message}`);
    this.name = 'AcpTier2CallbackError';
    this.backendId = params.backendId;
    this.callback = params.callback;
    this.startupFailure = params.startupFailure === true;
    this.cause = params.cause;
  }
}

export function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return Boolean(value) && typeof (value as PromiseLike<T>).then === 'function';
}

export function mapMaybePromise<T, U>(
  value: MaybePromise<T>,
  map: (resolved: T) => U,
): MaybePromise<U> {
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then(map);
  }
  return map(value);
}

function callbackError(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  callback: AcpTier2CallbackName;
  message: string;
  cause?: unknown;
  startupFailure?: boolean;
}>): AcpTier2CallbackError {
  return new AcpTier2CallbackError({
    backendId: params.definition.backendId,
    callback: params.callback,
    message: params.message,
    cause: params.cause,
    startupFailure: params.startupFailure,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeStartupCallback<T>(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  callback: AcpTier2CallbackName;
  invoke: () => MaybePromise<T>;
}>): MaybePromise<T> {
  try {
    const result = params.invoke();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).catch((cause: unknown) => {
        throw callbackError({
          definition: params.definition,
          callback: params.callback,
          message: errorMessage(cause),
          cause,
          startupFailure: true,
        });
      });
    }
    return result;
  } catch (cause) {
    throw callbackError({
      definition: params.definition,
      callback: params.callback,
      message: errorMessage(cause),
      cause,
      startupFailure: true,
    });
  }
}

function validateStringArray(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  callback: 'argvBuilder';
  value: unknown;
}>): readonly string[] {
  if (!Array.isArray(params.value)) {
    throw callbackError({
      definition: params.definition,
      callback: params.callback,
      message: 'expected a non-empty string array',
      startupFailure: true,
    });
  }
  if (params.value.length === 0) {
    throw callbackError({
      definition: params.definition,
      callback: params.callback,
      message: 'returned an empty argv array',
      startupFailure: true,
    });
  }
  if (!params.value.every((entry) => typeof entry === 'string')) {
    throw callbackError({
      definition: params.definition,
      callback: params.callback,
      message: 'expected argv entries to be strings',
      startupFailure: true,
    });
  }
  return Object.freeze([...params.value]);
}

function validateStringRecord(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  callback: 'envBuilder';
  value: unknown;
}>): Readonly<Record<string, string>> {
  if (!params.value || typeof params.value !== 'object' || Array.isArray(params.value)) {
    throw callbackError({
      definition: params.definition,
      callback: params.callback,
      message: 'expected an environment record',
      startupFailure: true,
    });
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.value)) {
    if (typeof value !== 'string') {
      throw callbackError({
        definition: params.definition,
        callback: params.callback,
        message: `expected env value '${key}' to be a string`,
        startupFailure: true,
      });
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

export function resolveAcpTier2Argv(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  baseArgs: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: string;
}>): MaybePromise<readonly string[]> {
  const callback = params.definition.callbacks.argvBuilder;
  if (!callback) {
    return Object.freeze([...params.baseArgs]);
  }

  const result = invokeStartupCallback({
    definition: params.definition,
    callback: 'argvBuilder',
    invoke: () => callback({
      baseArgs: params.baseArgs,
      cwd: params.cwd,
      env: params.env,
      ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    }),
  });
  return mapMaybePromise(result, (value) => validateStringArray({
    definition: params.definition,
    callback: 'argvBuilder',
    value,
  }));
}

export function resolveAcpTier2Env(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: string;
}>): MaybePromise<Readonly<Record<string, string>>> {
  const callback = params.definition.callbacks.envBuilder;
  if (!callback) {
    return params.env;
  }

  const result = invokeStartupCallback({
    definition: params.definition,
    callback: 'envBuilder',
    invoke: () => callback({
      cwd: params.cwd,
      env: params.env,
      ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    }),
  });
  return mapMaybePromise(result, (value) => Object.freeze({
    ...params.env,
    ...validateStringRecord({
      definition: params.definition,
      callback: 'envBuilder',
      value,
    }),
  }));
}

export function runAcpTier2Preflight(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
}>): MaybePromise<void> {
  const callback = params.definition.callbacks.preflight;
  if (!callback) {
    return undefined;
  }
  return invokeStartupCallback({
    definition: params.definition,
    callback: 'preflight',
    invoke: () => callback({ cwd: params.cwd }),
  });
}

function isPermissionDecision(value: unknown): value is AcpTier2PermissionDecisionResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'allow' && kind !== 'deny' && kind !== 'defer') {
    return false;
  }
  const rationale = (value as { rationale?: unknown }).rationale;
  return rationale === undefined || typeof rationale === 'string';
}

function createPermissionCallbackError(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  message: string;
  cause?: unknown;
}>): AcpTier2CallbackError {
  return callbackError({
    definition: params.definition,
    callback: 'permissionDecision',
    message: params.message,
    cause: params.cause,
    startupFailure: false,
  });
}

function reportPermissionDecisionError(error: AcpTier2CallbackError): void {
  logger.debug('[ACP Tier2] permissionDecision failed; deferring to the ACP permission handler', {
    backendId: error.backendId,
    callback: error.callback,
    code: error.code,
    message: error.message,
  });
}

function mapPermissionDecisionToHandlerResult(
  decision: AcpTier2PermissionDecisionResultV1,
): NonNullable<ReturnType<NonNullable<AcpPermissionHandler['getImmediateDecision']>>> | null {
  if (decision.kind === 'defer') {
    return null;
  }
  return {
    decision: decision.kind === 'allow' ? 'approved' : 'denied',
    ...(decision.rationale ? { rationale: decision.rationale } : {}),
  };
}

export function composeAcpTier2PermissionHandler(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  permissionHandler?: AcpPermissionHandler;
}>): AcpPermissionHandler | undefined {
  const callback = params.definition.callbacks.permissionDecision;
  if (!callback) {
    return params.permissionHandler;
  }

  const cachedDecisions = new Map<string, MaybePromise<AcpTier2PermissionDecisionResultV1>>();

  const evaluateDecision = (
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): MaybePromise<AcpTier2PermissionDecisionResultV1> => {
    const cached = cachedDecisions.get(toolCallId);
    if (cached) {
      return cached;
    }

    const evaluated = (() => {
      try {
        const result = callback({ toolCallId, toolName, input });
        const normalize = (value: unknown): AcpTier2PermissionDecisionResultV1 => {
          if (isPermissionDecision(value)) {
            return value;
          }
          const error = createPermissionCallbackError({
            definition: params.definition,
            message: 'returned an invalid permission decision',
          });
          reportPermissionDecisionError(error);
          return { kind: 'defer' };
        };
        if (isPromiseLike(result)) {
          return Promise.resolve(result)
            .then(normalize)
            .catch((cause: unknown) => {
              const error = createPermissionCallbackError({
                definition: params.definition,
                message: errorMessage(cause),
                cause,
              });
              reportPermissionDecisionError(error);
              return { kind: 'defer' as const };
            });
        }
        return normalize(result);
      } catch (cause) {
        const error = createPermissionCallbackError({
          definition: params.definition,
          message: errorMessage(cause),
          cause,
        });
        reportPermissionDecisionError(error);
        return { kind: 'defer' as const };
      }
    })();
    cachedDecisions.set(toolCallId, evaluated);
    return evaluated;
  };

  const fallbackHandler = params.permissionHandler;
  return {
    async resolvePrePromptDecision(toolCallId, toolName, input) {
      const decision = await evaluateDecision(toolCallId, toolName, input);
      const callbackResult = mapPermissionDecisionToHandlerResult(decision);
      if (callbackResult) {
        cachedDecisions.delete(toolCallId);
        return callbackResult;
      }
      return null;
    },
    getImmediateDecision(toolCallId, toolName, input) {
      const decision = evaluateDecision(toolCallId, toolName, input);
      if (isPromiseLike(decision)) {
        return fallbackHandler?.getImmediateDecision?.(toolCallId, toolName, input) ?? null;
      }
      const callbackResult = mapPermissionDecisionToHandlerResult(decision);
      if (callbackResult) {
        return callbackResult;
      }
      return fallbackHandler?.getImmediateDecision?.(toolCallId, toolName, input) ?? null;
    },
    async handleToolCall(toolCallId, toolName, input) {
      try {
        const decision = await evaluateDecision(toolCallId, toolName, input);
        const callbackResult = mapPermissionDecisionToHandlerResult(decision);
        if (callbackResult) {
          return callbackResult;
        }
        if (fallbackHandler) {
          return await fallbackHandler.handleToolCall(toolCallId, toolName, input);
        }
        return {
          decision: 'denied',
          rationale: 'permissionDecision deferred without a fallback permission handler',
        };
      } finally {
        cachedDecisions.delete(toolCallId);
      }
    },
  };
}
