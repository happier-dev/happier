import {
  getActionSpec,
  type ActionExecuteResult,
  type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';
import {
  ExternalSessionMaterializeActionInputV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  type ExternalSessionOperationAuthorIntentV1,
} from '@happier-dev/protocol';

import {
  loadPersistedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { StoredCredentials } from '@/persistence';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { configuration } from '@/configuration';
import {
  isExternalSessionOperationTerminalReceiptExpired,
  readExternalSessionOperationStoredEntry,
  resolveExternalSessionOperationAccountScope,
  resolveExternalSessionPluginOperationPreflightAdmission,
} from './operationRecordStore';
import {
  deriveExternalSessionPluginOperationDurableKey,
} from '@/session/external/pluginOperationDurableKey';
import type {
  ExternalSessionPluginMaterializeStart,
} from './materializeStartAction';

type PluginExternalSessionActionArgs = Parameters<
  NonNullable<ActionExecutorDeps['externalSessionAction']>
>[0];

export type PluginExternalSessionMaterializeStart =
  ExternalSessionPluginMaterializeStart;

type PluginExternalSessionActionExecutorOptions = Readonly<{
  materializeStart?: PluginExternalSessionMaterializeStart;
  activeServerDir?: string;
  nowMs?: () => number;
}>;

function readSessionId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Readonly<Record<string, unknown>>;
  const request = record.request;
  const nestedSessionId = request && typeof request === 'object' && !Array.isArray(request)
    ? (request as Readonly<Record<string, unknown>>).sessionId
    : null;
  const sessionId = nestedSessionId ?? record.sessionId;
  return typeof sessionId === 'string' ? sessionId : null;
}

function isViewerAction(actionId: PluginExternalSessionActionArgs['actionId']): boolean {
  return actionId === 'sessions.external.status.get'
    || actionId === 'sessions.external.follow'
    || actionId === 'sessions.external.unfollow'
    || actionId === 'sessions.external.backgroundFollow.set';
}

function operationStatusFailure(
  code: 'internal_error' | 'operation_not_found' | 'stale_revision',
  message: string,
): ActionExecuteResult {
  return { ok: true, result: { ok: false, error: { code, message } } };
}

export async function executePluginExternalSessionAction(args: Readonly<
  PluginExternalSessionActionArgs & { credentials: StoredCredentials }
>, options: PluginExternalSessionActionExecutorOptions = {}): Promise<ActionExecuteResult> {
  const sessionId = readSessionId(args.input);
  if (!sessionId) {
    return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  }
  if (args.actionId === 'sessions.external.materialize.start') {
    const parsed = ExternalSessionMaterializeActionInputV1Schema.safeParse(args.input);
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    const authorIntent = {
      v: 1,
      surface: 'plugin',
      kind: 'materialize',
      sessionId: parsed.data.request.sessionId,
      targetStorageMode: 'external-linked',
    } as const satisfies Extract<
      ExternalSessionOperationAuthorIntentV1,
      { kind: 'materialize' }
    >;
    let durableIdempotencyKey: string;
    try {
      durableIdempotencyKey = deriveExternalSessionPluginOperationDurableKey({
        pluginId: args.pluginId,
        callerKey: parsed.data.request.idempotencyKey,
      });
    } catch (error) {
      const code = error && typeof error === 'object'
        && typeof (error as Readonly<{ code?: unknown }>).code === 'string'
        ? (error as Readonly<{ code: string }>).code
        : 'plugin_external_operation_idempotency_key_invalid';
      return { ok: false, errorCode: code, error: code };
    }
    const linked = await loadPersistedLinkedExternalSession({
      credentials: args.credentials,
      sessionId: parsed.data.request.sessionId,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!linked.ok) {
      return {
        ok: false,
        errorCode: linked.errorCode,
        error: linked.error,
      };
    }
    const activeServerDir = options.activeServerDir
      ?? configuration.activeServerDir;
    const accountScope = resolveExternalSessionOperationAccountScope(
      activeServerDir,
      args.credentials.token,
    );
    if (!accountScope) {
      return {
        ok: true,
        result: {
          ok: false,
          error: {
            code: 'source_unavailable',
            message: 'Current Account identity is unavailable.',
          },
        },
      };
    }
    const preflight = await resolveExternalSessionPluginOperationPreflightAdmission({
      activeServerDir,
      accountScope,
      durableIdempotencyKey,
      authorIntent,
      nowMs: (options.nowMs ?? Date.now)(),
    });
    if (preflight.kind === 'conflict') {
      return {
        ok: true,
        result: {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Materialization idempotency request changed.',
          },
        },
      };
    }
    if (preflight.kind === 'legacy_unavailable') {
      return {
        ok: true,
        result: {
          ok: false,
          error: {
            code: 'source_unavailable',
            message: 'A legacy operation cannot be safely resumed.',
          },
        },
      };
    }
    if (preflight.kind === 'existing_record') {
      return {
        ok: true,
        result: {
          ok: true,
          operation: {
            sessionId: preflight.record.request.sessionId,
            operationId: preflight.record.operationId,
            revision: preflight.record.revision,
          },
        },
      };
    }
    if (preflight.kind === 'terminal_receipt') {
      return {
        ok: true,
        result: {
          ok: true,
          operation: preflight.receipt.reference,
        },
      };
    }
    if (!options.materializeStart) {
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: 'unsupported_action:sessions.external.materialize.start',
      };
    }
    const result = await options.materializeStart({
      sessionId: parsed.data.request.sessionId,
      durableIdempotencyKey,
      authorIntent,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    const response = ExternalSessionOperationActionResponseV1Schema.safeParse(result);
    return response.success
      ? { ok: true, result: response.data }
      : { ok: false, errorCode: 'external_session_action_failed', error: 'external_session_action_failed' };
  }

  const linked = await loadPersistedLinkedExternalSession({
    credentials: args.credentials,
    sessionId,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!linked.ok) {
    return isViewerAction(args.actionId)
      ? {
          ok: true,
          result: {
            ok: false,
            errorCode: linked.errorCode,
            error: linked.error,
          },
        }
      : {
          ok: false,
          errorCode: linked.errorCode,
          error: linked.error,
      };
  }

  if (args.actionId === 'sessions.external.operation.status.get') {
    const parsed = ExternalSessionOperationStatusInputV1Schema.safeParse(
      args.input,
    );
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      };
    }
    let stored: Awaited<ReturnType<
      typeof readExternalSessionOperationStoredEntry
    >>;
    try {
      stored = await readExternalSessionOperationStoredEntry(
        options.activeServerDir ?? configuration.activeServerDir,
        parsed.data.operationId,
      );
    } catch {
      return operationStatusFailure(
        'internal_error',
        'External session operation status could not be read.',
      );
    }
    if (!stored) {
      return operationStatusFailure(
        'operation_not_found',
        'External session operation was not found.',
      );
    }
    if (stored.kind === 'terminal_receipt') {
      const { receipt } = stored;
      let expired: boolean;
      try {
        expired = isExternalSessionOperationTerminalReceiptExpired(
          receipt,
          (options.nowMs ?? Date.now)(),
        );
      } catch {
        return operationStatusFailure(
          'internal_error',
          'External session operation status could not be read.',
        );
      }
      if (
        expired
        || receipt.reference.sessionId !== parsed.data.sessionId
        || receipt.reference.operationId !== parsed.data.operationId
      ) {
        return operationStatusFailure(
          'operation_not_found',
          'External session operation was not found.',
        );
      }
      if (receipt.reference.revision !== parsed.data.revision) {
        return operationStatusFailure(
          'stale_revision',
          'External session operation revision is stale.',
        );
      }
      const result = ExternalSessionOperationActionResultV1Schema.safeParse({
        ok: true,
        operation: receipt.reference,
        presentation: receipt.presentation,
      });
      if (!result.success) {
        return operationStatusFailure(
          'internal_error',
          'External session operation status could not be read.',
        );
      }
      return { ok: true, result: result.data };
    }
  }

  const semantic = args.input as Readonly<Record<string, unknown>>;
  const transportInput = isViewerAction(args.actionId)
    ? {
        ...semantic,
        machineId: linked.session.machineId,
        ...(args.actionId === 'sessions.external.unfollow'
          ? {}
          : {
              agentId: linked.session.agentId,
              remoteSessionId: linked.session.remoteSessionId,
              source: linked.session.source,
            }),
      }
    : semantic;
  const rpcMethod = getActionSpec(args.actionId).bindings?.rpcMethod;
  if (!rpcMethod) {
    return {
      ok: false,
      errorCode: 'unsupported_action',
      error: `unsupported_action:${args.actionId}`,
    };
  }
  try {
    return {
      ok: true,
      result: await callMachineRpc({
        credentials: args.credentials,
        machineId: linked.session.machineId,
        method: rpcMethod,
        request: transportInput,
        ...(args.signal ? { signal: args.signal } : {}),
      }),
    };
  } catch (error) {
    const code = error && typeof error === 'object'
      && typeof (error as Readonly<{ code?: unknown }>).code === 'string'
      ? (error as Readonly<{ code: string }>).code
      : 'external_session_action_failed';
    return { ok: false, errorCode: code, error: code };
  }
}
