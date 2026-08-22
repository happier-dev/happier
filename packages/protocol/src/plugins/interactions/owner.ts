import {
  InteractionTransientScopeV1Schema,
  normalizeInteractionTransientRequestV1,
  validateInteractionTransientSettlementV1,
  type InteractionTerminalStatusV1,
  type InteractionTransientAuthorRequestV1,
  type InteractionTransientRequestV1,
  type InteractionTransientRequesterV1,
  type InteractionTransientResultV1,
  type InteractionTransientScopeV1,
  type InteractionTransientSettlementReceiptV1,
} from './transientV1.js';

/** Node and browser timers clamp larger values; this is representation, not product policy. */
export const MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS = 2_147_483_647;

export function isTransientInteractionDeadlineMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS;
}

export type TransientInteractionPresenter = (
  request: InteractionTransientRequestV1,
  options: Readonly<{
    signal: AbortSignal;
    presentationContext?: unknown;
  }>,
) => Promise<InteractionTransientResultV1>;

export type TransientInteractionOwner = Readonly<{
  request(
    input: InteractionTransientAuthorRequestV1,
    options: Readonly<{
      requester: InteractionTransientRequesterV1;
      signal?: AbortSignal;
      /** Host-private presenter context; it never controls custody or settlement. */
      presentationContext?: unknown;
    }>,
  ): Promise<InteractionTransientResultV1>;
  settle(candidate: unknown): InteractionTransientSettlementReceiptV1;
  terminateAll(status: Extract<
    InteractionTerminalStatusV1,
    'sessionEnded' | 'generationRetired' | 'hostRestarted' | 'unavailable'
  >): void;
  current(): readonly InteractionTransientRequestV1[];
}>;

export type TransientInteractionOwnerParams = Readonly<{
  /**
   * Host-only scope selection. A Session adapter supplies the exact current
   * Session arm; an app adapter supplies only the present-user app arm.
   */
  scope: InteractionTransientScopeV1;
  /** Required only for an exact Session scope and maps exclusively to sessionEnded. */
  sessionSignal?: AbortSignal;
  isGenerationCurrent(): boolean;
  /**
   * Product policy supplied by the host; callers cannot select a fallback.
   * `null` is the explicit no-deadline arm: nothing is stamped and no timer is
   * created, so the request settles only on a lifecycle event. A host that
   * chooses it must own a lifecycle signal that can fire (an exact Session
   * scope always does, through `sessionSignal`).
   */
  deadlineMs: number | null;
  present: TransientInteractionPresenter;
  now?: () => number;
  createRequestId?: () => string;
}>;

type PendingInteraction = {
  readonly request: InteractionTransientRequestV1;
  readonly presenterAbort: AbortController;
  readonly resolve: (result: InteractionTransientResultV1) => void;
  readonly requesterSignal?: AbortSignal;
  readonly requesterAbort: () => void;
  readonly sessionAbort?: () => void;
  /** Absent for the no-deadline arm: that request has no timer to clear. */
  readonly deadline?: ReturnType<typeof setTimeout>;
  readonly presentationContext?: unknown;
};

type KnownInteractionKind = InteractionTransientRequestV1['kind'];

let fallbackRequestSequence = 0;

function defaultRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  fallbackRequestSequence += 1;
  return `transient-interaction-${Date.now()}-${fallbackRequestSequence}`;
}

function readKnownInteractionKind(input: unknown): KnownInteractionKind | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, 'kind');
    if (!descriptor || !('value' in descriptor)) return null;
    return descriptor.value === 'approval' || descriptor.value === 'questions' || descriptor.value === 'confirmation'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function unavailableResult(input: unknown, requestId: string): InteractionTransientResultV1 {
  return Object.freeze({
    requestId,
    kind: readKnownInteractionKind(input) ?? 'approval',
    status: 'unavailable',
  }) as InteractionTransientResultV1;
}

function readSettlementRequestId(candidate: unknown): string {
  try {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return 'unknown-interaction';
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'requestId');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : 'unknown-interaction';
  } catch {
    return 'unknown-interaction';
  }
}

function lifecycleResult(
  request: InteractionTransientRequestV1,
  status: InteractionTerminalStatusV1,
): InteractionTransientResultV1 {
  return Object.freeze({ requestId: request.requestId, kind: request.kind, status }) as InteractionTransientResultV1;
}

function readsCurrent(read: () => boolean): boolean {
  try {
    return read() === true;
  } catch {
    return false;
  }
}

/**
 * Host-only transient interaction lifecycle owner shared by the exact Session
 * and present-user app adapters. It is the only map/timer/first-terminal
 * owner; a presenter returns one candidate and never settles by itself.
 */
export function createTransientInteractionOwner(
  params: TransientInteractionOwnerParams,
): TransientInteractionOwner {
  if (params.deadlineMs !== null && !isTransientInteractionDeadlineMs(params.deadlineMs)) {
    throw new Error(
      `Transient interaction deadline must be null or a positive safe integer no greater than ${MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS}`,
    );
  }
  const deadlineMs = params.deadlineMs;
  const parsedScope = InteractionTransientScopeV1Schema.safeParse(params.scope);
  if (!parsedScope.success) throw new Error('Transient interaction scope must be host-stamped and valid');
  const scope = parsedScope.data;
  if (scope.kind === 'session' && !params.sessionSignal) {
    throw new Error('Exact Session interactions require the Session lifecycle signal');
  }
  if (scope.kind === 'app' && params.sessionSignal !== undefined) {
    throw new Error('Present-user app interactions cannot receive a Session lifecycle signal');
  }

  const now = params.now ?? Date.now;
  const createRequestId = params.createRequestId ?? defaultRequestId;
  const pending = new Map<string, PendingInteraction>();

  const finish = (
    entry: PendingInteraction,
    result: InteractionTransientResultV1,
  ): InteractionTransientSettlementReceiptV1 => {
    if (pending.get(entry.request.requestId) !== entry) {
      return Object.freeze({ status: 'notCurrent', requestId: entry.request.requestId });
    }
    pending.delete(entry.request.requestId);
    if (entry.deadline !== undefined) clearTimeout(entry.deadline);
    if (entry.sessionAbort) params.sessionSignal!.removeEventListener('abort', entry.sessionAbort);
    entry.requesterSignal?.removeEventListener('abort', entry.requesterAbort);
    entry.presenterAbort.abort('interaction_settled');
    entry.resolve(result);
    return Object.freeze({ status: 'settled', result });
  };

  const settleEntry = (
    entry: PendingInteraction,
    candidate: unknown,
  ): InteractionTransientSettlementReceiptV1 => {
    if (pending.get(entry.request.requestId) !== entry) {
      return Object.freeze({ status: 'notCurrent', requestId: entry.request.requestId });
    }
    if (!readsCurrent(params.isGenerationCurrent)) {
      return finish(entry, lifecycleResult(entry.request, 'generationRetired'));
    }
    let validation: ReturnType<typeof validateInteractionTransientSettlementV1>;
    try {
      validation = validateInteractionTransientSettlementV1(entry.request, candidate);
    } catch {
      return finish(entry, lifecycleResult(entry.request, 'unavailable'));
    }
    if (!validation.ok) return finish(entry, lifecycleResult(entry.request, 'unavailable'));
    return finish(entry, candidate as InteractionTransientResultV1);
  };

  const settle = (candidate: unknown): InteractionTransientSettlementReceiptV1 => {
    const requestId = readSettlementRequestId(candidate);
    const entry = pending.get(requestId);
    if (!entry) return Object.freeze({ status: 'notCurrent', requestId });
    return settleEntry(entry, candidate);
  };

  const request = async (
    input: InteractionTransientAuthorRequestV1,
    options: Readonly<{
      requester: InteractionTransientRequesterV1;
      signal?: AbortSignal;
      presentationContext?: unknown;
    }>,
  ): Promise<InteractionTransientResultV1> => {
    let requestId: string;
    try {
      requestId = createRequestId();
    } catch {
      return unavailableResult(input, 'unknown-interaction');
    }
    if (pending.has(requestId)) return unavailableResult(input, requestId);
    const createdAtMs = now();
    const normalized = normalizeInteractionTransientRequestV1(input, {
      requestId,
      scope,
      requester: options.requester,
      createdAtMs,
      ...(deadlineMs === null ? {} : { expiresAtMs: createdAtMs + deadlineMs }),
    });
    if (!normalized.ok) return unavailableResult(input, requestId);
    const stamped = normalized.value;
    if (!readsCurrent(params.isGenerationCurrent)) {
      return lifecycleResult(stamped, 'generationRetired');
    }
    if (scope.kind === 'session' && params.sessionSignal!.aborted) {
      return lifecycleResult(stamped, 'sessionEnded');
    }
    if (options.signal?.aborted) return lifecycleResult(stamped, 'requesterAborted');

    return await new Promise<InteractionTransientResultV1>((resolve) => {
      const presenterAbort = new AbortController();
      const requesterAbort = () => {
        const current = pending.get(stamped.requestId);
        if (current) finish(current, lifecycleResult(
          stamped,
          readsCurrent(params.isGenerationCurrent) ? 'requesterAborted' : 'generationRetired',
        ));
      };
      const sessionAbort = scope.kind === 'session'
        ? () => {
          const current = pending.get(stamped.requestId);
          if (!current) return;
          finish(current, lifecycleResult(
            stamped,
            readsCurrent(params.isGenerationCurrent) ? 'sessionEnded' : 'generationRetired',
          ));
        }
        : undefined;
      const deadline = deadlineMs === null
        ? undefined
        : setTimeout(() => {
          const current = pending.get(stamped.requestId);
          if (current) finish(current, lifecycleResult(stamped, 'timedOut'));
        }, deadlineMs);
      const entry: PendingInteraction = {
        request: stamped,
        presenterAbort,
        resolve,
        ...(options.signal ? { requesterSignal: options.signal } : {}),
        ...(options.presentationContext === undefined
          ? {}
          : { presentationContext: options.presentationContext }),
        requesterAbort,
        ...(sessionAbort ? { sessionAbort } : {}),
        ...(deadline === undefined ? {} : { deadline }),
      };
      pending.set(stamped.requestId, entry);
      if (sessionAbort) params.sessionSignal!.addEventListener('abort', sessionAbort, { once: true });
      options.signal?.addEventListener('abort', requesterAbort, { once: true });

      void Promise.resolve().then(
        () => params.present(stamped, {
          signal: presenterAbort.signal,
          ...(entry.presentationContext === undefined
            ? {}
            : { presentationContext: entry.presentationContext }),
        }),
      ).then(
        (candidate) => { settleEntry(entry, candidate); },
        () => {
          const current = pending.get(stamped.requestId);
          if (current) finish(current, lifecycleResult(stamped, 'unavailable'));
        },
      );
    });
  };

  const terminateAll = (
    status: Extract<
      InteractionTerminalStatusV1,
      'sessionEnded' | 'generationRetired' | 'hostRestarted' | 'unavailable'
    >,
  ): void => {
    if (scope.kind === 'app' && status === 'sessionEnded') {
      throw new Error('Present-user app interactions cannot terminate as Session-ended');
    }
    for (const entry of [...pending.values()]) {
      finish(entry, lifecycleResult(entry.request, status));
    }
  };

  return Object.freeze({
    request,
    settle,
    terminateAll,
    current: () => Object.freeze([...pending.values()].map((entry) => entry.request)),
  });
}

/** An inert host binding for a lifecycle that has no authoritative presenter. */
export function createUnavailableTransientInteractionOwner(
  params: Readonly<{ createRequestId?: () => string }> = {},
): TransientInteractionOwner {
  const createRequestId = params.createRequestId ?? defaultRequestId;
  return Object.freeze({
    request: async (input) => {
      let requestId: string;
      try {
        requestId = createRequestId();
      } catch {
        requestId = 'unknown-interaction';
      }
      return unavailableResult(input, requestId);
    },
    settle: (candidate) => Object.freeze({
      status: 'notCurrent',
      requestId: readSettlementRequestId(candidate),
    }),
    terminateAll: () => undefined,
    current: () => Object.freeze([]),
  });
}
