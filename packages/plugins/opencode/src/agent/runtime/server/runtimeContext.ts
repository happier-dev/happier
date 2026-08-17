import { randomUUID } from 'node:crypto';

import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  InteractionTransientApprovalAuthorRequestV1,
  InteractionTransientApprovalResultV1,
} from '@happier-dev/plugin-sdk/interactions';
import type {
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';

type OpenCodeWorkStateSnapshot = Readonly<{
  updatedAt: number;
  items: readonly Readonly<{
    id: string;
    kind: 'goal' | 'task' | 'todo';
    origin: 'vendor' | 'happier' | 'derived';
    status: 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
    title: string;
    vendorRef?: string;
    order?: number;
    priority?: string;
    updatedAt: number;
  }>[];
  primaryItemId?: string | null;
  truncated?: Readonly<{ reason: string; omittedCount?: number }>;
}>;

export type OpenCodeRuntimeContext = Readonly<{
  logger: Readonly<{
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  }>;
  abort: Readonly<{
    signal: AbortSignal;
    compose(signals: readonly AbortSignal[]): AbortSignal;
  }>;
  config: Readonly<{ values: Readonly<Record<string, unknown>> }>;
  env: Readonly<{ list(): Readonly<Record<string, string>> }>;
  managedServices: ManagedServices;
  ui: Pick<AgentRuntimeContext['services']['interactions'], 'askQuestions'>;
  sessions: Readonly<{
    current: Readonly<{
      permissions: Readonly<{
        requestDecision(
          request: Parameters<AgentSessionRuntimeContext['services']['interactions']['requestApproval']>[0],
          options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<InteractionTransientApprovalResultV1>;
      }>;
    }>;
    writeStateField(request: Readonly<{
      fieldId: string;
      value: unknown;
      reason: string;
    }>): Promise<void>;
  }>;
  storage: Readonly<{
    daemonSession: Pick<AgentRuntimeContext['services']['storage']['daemonSession'], 'get' | 'set'>;
  }>;
  experimental: Readonly<{
    telemetry: Readonly<{ emit(event: unknown): void }>;
  }>;
}>;

function composeAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as JsonValue;
}

function toJsonFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!fields) return undefined;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, toJsonValue(value)]),
  );
}

function toWorkStatePublishRequest(snapshot: OpenCodeWorkStateSnapshot) {
  return {
    sourceSequence: snapshot.updatedAt,
    observedAtMs: snapshot.updatedAt,
    items: snapshot.items.map((item) => ({
      localId: item.id,
      kind: item.kind,
      origin: item.origin,
      status: item.status,
      title: item.title,
      ...(item.vendorRef ? { providerRef: item.vendorRef } : {}),
      ...(item.order === undefined ? {} : { order: item.order }),
      ...(item.priority ? { priority: item.priority } : {}),
      updatedAtMs: item.updatedAt,
    })),
    ...(snapshot.primaryItemId === undefined
      ? {}
      : { primaryLocalId: snapshot.primaryItemId }),
  };
}

export function requestOpenCodeApprovalWithSignal(params: Readonly<{
  request: InteractionTransientApprovalAuthorRequestV1;
  signal?: AbortSignal;
  requestApproval(request: InteractionTransientApprovalAuthorRequestV1): Promise<InteractionTransientApprovalResultV1>;
}>): Promise<InteractionTransientApprovalResultV1> {
  const cancelled = (): InteractionTransientApprovalResultV1 => ({
    requestId: randomUUID(),
    kind: 'approval',
    status: 'requesterAborted',
  });
  if (params.signal?.aborted) return Promise.resolve(cancelled());
  return new Promise<InteractionTransientApprovalResultV1>((resolve, reject) => {
    let settled = false;
    const finish = (result: InteractionTransientApprovalResultV1) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => finish(cancelled());
    params.signal?.addEventListener('abort', onAbort, { once: true });
    void params.requestApproval(params.request).then(finish, fail);
  });
}

export function createOpenCodeRuntimeContext(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
  workStateService?: AgentSessionRuntimeContext['workState'],
): OpenCodeRuntimeContext {
  const environment = request.launchEnvironment?.values ?? {};
  const workState = workStateService?.publisher('opencode-todos') ?? null;
  return {
    logger: {
      debug: (message, fields) => context.services.logger.debug(
        message,
        toJsonFields(fields),
      ),
      info: (message, fields) => context.services.logger.info(
        message,
        toJsonFields(fields),
      ),
      warn: (message, fields) => context.services.logger.warn(
        message,
        toJsonFields(fields),
      ),
      error: (message, fields) => context.services.logger.error(
        message,
        toJsonFields(fields),
      ),
    },
    abort: {
      signal: context.signal,
      compose: composeAbortSignals,
    },
    config: { values: environment },
    env: { list: () => environment },
    managedServices: context.services.managedServices,
    ui: {
      askQuestions: (questions, options) =>
        context.services.interactions.askQuestions(questions, options),
    },
    sessions: {
      current: {
        permissions: {
          requestDecision: (approvalRequest, options) => requestOpenCodeApprovalWithSignal({
            request: approvalRequest,
            signal: options?.signal,
            requestApproval: (request) => context.services.interactions.requestApproval(request),
          }),
        },
      },
      async writeStateField(stateRequest) {
        if (stateRequest.fieldId !== 'runtime.workState') return;
        if (!workState) return;
        await workState.publish(
          toWorkStatePublishRequest(stateRequest.value as OpenCodeWorkStateSnapshot),
          { signal: context.signal },
        );
      },
    },
    storage: {
      daemonSession: {
        get: (key) => context.services.storage.daemonSession.get(key),
        set: (key, value) => context.services.storage.daemonSession.set(
          key,
          toJsonValue(value),
        ),
      },
    },
    experimental: { telemetry: { emit: () => undefined } },
  };
}
