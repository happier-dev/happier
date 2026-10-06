import { randomUUID } from 'node:crypto';

import { CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY, CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD, CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD, CurrentSessionPresentationAckV1Schema, CurrentSessionPresentationBindV1Schema, CurrentSessionPresentationUnbindV1Schema, CurrentSessionPresentationIntentResultV1Schema, CurrentSessionPresentationOwnerV1Schema, CurrentSessionPresentationStateV1Schema, sameCurrentSessionPresentationOwnerV1 } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import type { CurrentSessionPresentationAckV1, CurrentSessionPresentationBindV1, CurrentSessionPresentationIntentResultV1, CurrentSessionPresentationIntentV1, CurrentSessionPresentationOwnerV1, CurrentSessionPresentationStateV1 } from '@happier-dev/protocol/sessions';
import { isSocketRpcCurrentSessionPresentationOriginAuthorizationContext } from '@happier-dev/protocol/rpc';
import type { SocketRpcCurrentSessionPresentationOriginAuthorizationContext } from '@happier-dev/protocol/rpc';

import type { AgentState } from '@/api/types';
import { ComposerTransactionResultV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerTransactionResultV1 } from '@happier-dev/protocol';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type {
  HostCurrentSessionPresentationService,
  HostSessionPresentationOwner,
  HostSessionPresentationOneShotResult,
  HostSessionPresentationStatefulResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import {
  delayUnrefAbortable,
  exponentialBackoffDelay,
} from '@/utils/time';

type PresentationSessionPort = Pick<
  SessionClientPort,
  'sessionId' | 'rpcHandlerManager' | 'updateAgentState'
>;

type BoundClient = Readonly<{
  binding: CurrentSessionPresentationBindV1;
  origin: SocketRpcCurrentSessionPresentationOriginAuthorizationContext;
}>;

type PendingCommand = Readonly<{
  clientId: string;
  origin: SocketRpcCurrentSessionPresentationOriginAuthorizationContext;
  resolve: (ack: CurrentSessionPresentationAckV1 | null) => void;
}>;

const RETIRED_OWNER_PURGE_RETRY_BACKOFF_FAILURE_CAP = 3;
const RETIRED_OWNER_PURGE_RETRY_MIN_DELAY_MS = 250;
const RETIRED_OWNER_PURGE_RETRY_MAX_DELAY_MS = 1_000;

function diagnostic(code: string, message: string) {
  return Object.freeze({ code, severity: 'error' as const, message });
}

function unavailable(message: string, code = 'current_session_presentation_unavailable'): HostSessionPresentationStatefulResult {
  return Object.freeze({ status: 'unavailable', diagnostic: diagnostic(code, message) });
}

function conflict(message: string, code = 'current_session_presentation_conflict'): HostSessionPresentationStatefulResult {
  return Object.freeze({ status: 'conflict', diagnostic: diagnostic(code, message) });
}

function outcomeUnknown(message: string): HostSessionPresentationOneShotResult {
  return Object.freeze({
    status: 'outcomeUnknown',
    diagnostic: diagnostic('current_session_presentation_outcome_unknown', message),
  });
}

function readPresentationState(state: AgentState): CurrentSessionPresentationStateV1 | null {
  const raw = (state as Record<string, unknown>)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY];
  const parsed = CurrentSessionPresentationStateV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function removePresentationOwners(
  state: CurrentSessionPresentationStateV1,
  owners: ReadonlySet<CurrentSessionPresentationOwnerV1>,
): CurrentSessionPresentationStateV1 {
  if (owners.size === 0) return state;
  const owns = (owner: CurrentSessionPresentationOwnerV1) => {
    for (const retired of owners) {
      if (sameCurrentSessionPresentationOwnerV1(retired, owner)) return true;
    }
    return false;
  };
  const statuses = state.statuses.filter((entry) => !owns(entry.owner));
  const widgets = state.widgets.filter((entry) => !owns(entry.owner));
  if (
    statuses.length === state.statuses.length
    && widgets.length === state.widgets.length
  ) {
    return state;
  }
  return { ...state, statuses, widgets };
}

function isKnownPreApplicationFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'socket_not_connected' || code === 'socket_auth_failed' || code === 'session_closed';
}

function isLocalContractFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

function abortPromise(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
}

function samePresentationOrigin(
  left: SocketRpcCurrentSessionPresentationOriginAuthorizationContext,
  right: SocketRpcCurrentSessionPresentationOriginAuthorizationContext,
): boolean {
  return left.sessionId === right.sessionId
    && left.accountId === right.accountId
    && left.connectionId === right.connectionId;
}

function formatRevision(hostNonce: string, revision: number): string {
  return `${hostNonce}:${revision}`;
}

function mapComposerTransactionResult(
  hostNonce: string,
  result: ComposerTransactionResultV1,
): HostSessionPresentationOneShotResult {
  switch (result.status) {
    case 'applied':
      return Object.freeze({ status: 'applied' as const, revision: formatRevision(hostNonce, result.revision) });
    case 'conflict':
      return conflict('The client composer revision changed before the presentation could be applied');
    case 'composerUnavailable':
      return unavailable('The client composer is unavailable');
    case 'notEditable':
      return unavailable('The client composer is not editable');
    case 'invalidOperation':
      return unavailable('The client rejected the composer transaction as invalid');
    case 'limitExceeded':
      return unavailable('The client rejected the composer transaction because it exceeds a limit');
  }
}

function mapPresentationIntentResult(
  hostNonce: string,
  revision: number,
  result: CurrentSessionPresentationIntentResultV1,
): HostSessionPresentationOneShotResult {
  switch (result.status) {
    case 'applied':
    case 'unchanged':
      return Object.freeze({ status: result.status, revision: formatRevision(hostNonce, revision) });
    case 'notCurrent':
      return unavailable('The bound client is no longer presenting this Session', 'current_session_presentation_not_current');
    case 'invalidTarget':
      return unavailable('The requested Board or Companion target is unavailable', 'current_session_presentation_invalid_target');
    case 'unavailable':
      return unavailable('The current Session presentation adapter is unavailable');
  }
}

export function createCurrentSessionPresentationService(params: Readonly<{
  session: PresentationSessionPort;
  signal: AbortSignal;
  isCurrent: () => boolean;
  ackTimeoutMs?: number;
  recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): HostCurrentSessionPresentationService {
  const hostNonce = randomUUID();
  const ackTimeoutMs = params.ackTimeoutMs ?? 15_000;
  let revision = 0;
  let boundClient: BoundClient | null = null;
  const pendingCommands = new Map<string, PendingCommand>();
  // This is a host-lifetime-only retirement intent. It prevents a stale
  // invocation from reappearing while the bounded persistence retry is still
  // recovering; it is never a second persisted presentation state.
  const pendingOwnerPurges = new Set<CurrentSessionPresentationOwnerV1>();
  const pendingOwnerPurgeAbortController = new AbortController();
  let pendingOwnerPurgeRetry: Promise<void> | null = null;

  const isAvailable = () => {
    if (params.signal.aborted) return false;
    try {
      return params.isCurrent() === true;
    } catch {
      return false;
    }
  };

  const updateState = async (
    mutate: (
      current: CurrentSessionPresentationStateV1,
      storedHostNonce: string | null,
    ) => CurrentSessionPresentationStateV1,
  ): Promise<CurrentSessionPresentationStateV1> => {
    let output: CurrentSessionPresentationStateV1 | null = null;
    let appliedOwnerPurges: readonly CurrentSessionPresentationOwnerV1[] = [];
    await params.session.updateAgentState((state) => {
      const stored = readPresentationState(state);
      const storedHostNonce = stored?.hostNonce ?? null;
      revision = Math.max(revision, stored?.revision ?? 0);
      const current: CurrentSessionPresentationStateV1 = {
        v: 1,
        hostNonce,
        revision,
        statuses: stored?.statuses ?? [],
        widgets: stored?.widgets ?? [],
        ...(stored?.hostNonce === hostNonce && stored.command ? { command: stored.command } : {}),
      };
      const mutated = mutate(current, storedHostNonce);
      const pendingAtApplication = [...pendingOwnerPurges];
      output = CurrentSessionPresentationStateV1Schema.parse(
        removePresentationOwners(mutated, new Set(pendingAtApplication)),
      );
      appliedOwnerPurges = pendingAtApplication;
      params.recordRuntimeLimitMeasurement?.({
        family: 'current-session-presentation',
        decodedBytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
        itemCount: output.statuses.length + output.widgets.length,
      });
      return { ...state, [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: output } as AgentState;
    });
    if (!output) throw new Error('Presentation state update did not execute');
    for (const applied of appliedOwnerPurges) {
      pendingOwnerPurges.delete(applied);
    }
    return output;
  };

  const hasPendingOwnerPurge = (owner: CurrentSessionPresentationOwnerV1): boolean => {
    for (const pending of pendingOwnerPurges) {
      if (sameCurrentSessionPresentationOwnerV1(pending, owner)) return true;
    }
    return false;
  };

  const retainOwnerPurge = (owner: CurrentSessionPresentationOwnerV1): void => {
    if (!hasPendingOwnerPurge(owner)) pendingOwnerPurges.add(owner);
  };

  const persistPendingOwnerPurges = async (): Promise<boolean> => {
    if (pendingOwnerPurges.size === 0 || !isAvailable()) return false;
    try {
      await updateState((current) => {
        const purged = removePresentationOwners(current, pendingOwnerPurges);
        return purged === current
          ? current
          : { ...purged, revision: ++revision };
      });
      return true;
    } catch {
      return false;
    }
  };

  const schedulePendingOwnerPurgeRetry = (): void => {
    if (
      pendingOwnerPurges.size === 0
      || params.signal.aborted
      || pendingOwnerPurgeAbortController.signal.aborted
      || pendingOwnerPurgeRetry
    ) {
      return;
    }
    pendingOwnerPurgeRetry = (async () => {
      let failureCount = 0;
      while (pendingOwnerPurges.size > 0) {
        const delayMs = exponentialBackoffDelay(
          failureCount + 1,
          RETIRED_OWNER_PURGE_RETRY_MIN_DELAY_MS,
          RETIRED_OWNER_PURGE_RETRY_MAX_DELAY_MS,
          RETIRED_OWNER_PURGE_RETRY_BACKOFF_FAILURE_CAP,
        );
        await delayUnrefAbortable(delayMs, pendingOwnerPurgeAbortController.signal);
        if (pendingOwnerPurgeAbortController.signal.aborted || !isAvailable()) {
          pendingOwnerPurges.clear();
          return;
        }
        if (pendingOwnerPurges.size === 0) return;
        if (await persistPendingOwnerPurges()) return;
        failureCount += 1;
      }
    })().finally(() => {
      pendingOwnerPurgeRetry = null;
    });
  };

  const clearCommand = async (commandId: string) => {
    try {
      await updateState((current) => current.command?.id === commandId
        ? { ...current, revision: ++revision, command: undefined }
        : current);
    } catch {
      // A stale command is fenced by hostNonce/clientId and cannot apply to a new binding.
    }
  };

  params.session.rpcHandlerManager.registerHandler(
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
    async (raw, context) => {
      const parsed = CurrentSessionPresentationBindV1Schema.safeParse(raw);
      const origin = context?.authorization;
      if (
        !parsed.success
        || !isAvailable()
        || !isSocketRpcCurrentSessionPresentationOriginAuthorizationContext(origin)
        || origin.sessionId !== params.session.sessionId
      ) {
        return { status: 'rejected' as const, reason: 'unavailable' as const };
      }
      const candidate: BoundClient = Object.freeze({
        binding: Object.freeze({ ...parsed.data }),
        origin,
      });
      const sameBinding = boundClient !== null
        && boundClient.binding.clientId === candidate.binding.clientId
        && samePresentationOrigin(boundClient.origin, candidate.origin);
      const accepted = sameBinding || (
        boundClient === null
        || candidate.binding.focused
        || !boundClient.binding.focused
      );
      if (!accepted) {
        return { status: 'rejected' as const, reason: 'notCurrent' as const };
      }
      if (sameBinding) {
        // Focus and draft revision are binding-local input, not persisted
        // presentation state. Only a new host or origin changes the snapshot.
        boundClient = candidate;
        return Object.freeze({
          status: 'bound' as const,
          sessionId: params.session.sessionId,
          hostNonce,
          revision,
        });
      }
      const replacedBinding = boundClient !== null && !sameBinding;
      const replacedPending = replacedBinding ? [...pendingCommands.values()] : [];
      const snapshot = await updateState((current, storedHostNonce) => {
        const nextRevision = ++revision;
        if (storedHostNonce !== null && storedHostNonce !== hostNonce) {
          // A new native host has superseded every transient producer that
          // wrote the previous host snapshot. Do this at the one reconnect
          // binding boundary so a failed abort-time exact purge cannot leak
          // rows into the successor's UI.
          pendingOwnerPurges.clear();
          return {
            ...current,
            revision: nextRevision,
            statuses: [],
            widgets: [],
            command: undefined,
          };
        }
        return replacedBinding
          ? { ...current, revision: nextRevision, command: undefined }
          : { ...current, revision: nextRevision };
      });
      if (replacedBinding) {
        for (const [commandId, pending] of pendingCommands) {
          if (replacedPending.includes(pending)) pendingCommands.delete(commandId);
        }
      }
      boundClient = candidate;
      for (const pending of replacedPending) pending.resolve(null);
      return Object.freeze({
        status: 'bound' as const,
        sessionId: params.session.sessionId,
        hostNonce,
        revision: snapshot.revision,
      });
    },
  );

  params.session.rpcHandlerManager.registerHandler(
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    async (raw, context) => {
      const parsed = CurrentSessionPresentationAckV1Schema.safeParse(raw);
      const origin = context?.authorization;
      if (
        !parsed.success
        || parsed.data.hostNonce !== hostNonce
        || !isSocketRpcCurrentSessionPresentationOriginAuthorizationContext(origin)
        || origin.sessionId !== params.session.sessionId
      ) return { status: 'ignored' };
      const pending = pendingCommands.get(parsed.data.commandId);
      if (
        !pending
        || pending.clientId !== parsed.data.clientId
        || !samePresentationOrigin(pending.origin, origin)
        || !boundClient
        || boundClient.binding.clientId !== parsed.data.clientId
        || !samePresentationOrigin(boundClient.origin, origin)
      ) return { status: 'ignored' };
      pendingCommands.delete(parsed.data.commandId);
      pending.resolve(parsed.data);
      return { status: 'accepted' };
    },
  );

  params.session.rpcHandlerManager.registerHandler(
    CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
    async (raw, context) => {
      const parsed = CurrentSessionPresentationUnbindV1Schema.safeParse(raw);
      const origin = context?.authorization;
      if (
        !parsed.success
        || !isSocketRpcCurrentSessionPresentationOriginAuthorizationContext(origin)
        || origin.sessionId !== params.session.sessionId
        || !boundClient
        || boundClient.binding.clientId !== parsed.data.clientId
        || !samePresentationOrigin(boundClient.origin, origin)
      ) return { status: 'ignored' as const };
      boundClient = null;
      const retiredPending = [...pendingCommands.values()].filter((pending) => (
        pending.clientId === parsed.data.clientId && samePresentationOrigin(pending.origin, origin)
      ));
      for (const [commandId, pending] of pendingCommands) {
        if (pending.clientId === parsed.data.clientId && samePresentationOrigin(pending.origin, origin)) {
          pendingCommands.delete(commandId);
        }
      }
      await updateState((current) => current.command?.clientId === parsed.data.clientId
        ? { ...current, revision: ++revision, command: undefined }
        : current);
      for (const pending of retiredPending) pending.resolve(null);
      return { status: 'retired' as const };
    },
  );

  params.signal.addEventListener('abort', () => {
    pendingOwnerPurgeAbortController.abort(params.signal.reason);
    pendingOwnerPurges.clear();
    boundClient = null;
    for (const [commandId, pending] of pendingCommands) {
      pendingCommands.delete(commandId);
      pending.resolve(null);
    }
  }, { once: true });

  const setStateful = async (
    operationId: string,
    mutate: (
      current: CurrentSessionPresentationStateV1,
      nextRevision: number,
    ) => CurrentSessionPresentationStateV1,
    options?: { signal?: AbortSignal },
    allowRetiredExactPurge = false,
  ): Promise<HostSessionPresentationStatefulResult> => {
    const isStatefulOperationCurrent = () => (
      (allowRetiredExactPurge || isAvailable())
      && !options?.signal?.aborted
    );
    if (!operationId.trim() || !isStatefulOperationCurrent()) {
      return unavailable('The current Agent session is not available');
    }
    try {
      let changed = false;
      const next = await updateState((current) => {
        if (!isStatefulOperationCurrent()) return current;
        const candidate = mutate(current, revision + 1);
        if (candidate === current) return current;
        revision += 1;
        changed = true;
        return candidate;
      });
      return Object.freeze({
        status: changed ? 'applied' as const : 'unchanged' as const,
        revision: formatRevision(hostNonce, next.revision),
      });
    } catch {
      return unavailable('The current-session presentation snapshot could not be persisted');
    }
  };

  const stampOwner = (owner: HostSessionPresentationOwner) => {
    const parsed = CurrentSessionPresentationOwnerV1Schema.safeParse({
      ...owner,
      sessionId: params.session.sessionId,
    });
    return parsed.success ? parsed.data : null;
  };

  const publishNotification = async (
    operationId: string,
    request: Readonly<{ message: string; severity: 'info' | 'warning' | 'error' }>,
    options?: { signal?: AbortSignal },
  ): Promise<HostSessionPresentationOneShotResult> => {
    if (!operationId.trim() || !isAvailable() || options?.signal?.aborted) {
      return unavailable('The current Agent session is not available');
    }
    const client = boundClient;
    if (!client?.binding.focused) return unavailable('No focused authenticated client is bound to this session presentation');
    let published: CurrentSessionPresentationStateV1;
    try {
      published = await updateState((current) => ({
        ...current,
        revision: ++revision,
        command: {
          id: operationId,
          clientId: client.binding.clientId,
          kind: 'notify',
          message: request.message,
          severity: request.severity,
        },
      }));
    } catch (error) {
      if (isLocalContractFailure(error)) {
        return unavailable('The presentation command did not satisfy the bounded host contract');
      }
      return isKnownPreApplicationFailure(error)
        ? unavailable('The presentation target was offline before the command could be published')
        : outcomeUnknown('The command may have been published before the transport failed');
    }

    // Notifications have no result grammar. Clear the transient command only
    // after its successful state publication, without converting cleanup into
    // a second acknowledgement path.
    await clearCommand(operationId);
    return Object.freeze({
      status: 'applied' as const,
      revision: formatRevision(hostNonce, published.revision),
    });
  };

  const publishComposerReplace = async (
    operationId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostSessionPresentationOneShotResult> => {
    if (!operationId.trim() || !isAvailable() || options?.signal?.aborted) {
      return unavailable('The current Agent session is not available');
    }
    const client = boundClient;
    if (!client?.binding.focused) return unavailable('No focused authenticated client is bound to this session presentation');
    if (pendingCommands.size > 0) return unavailable('Another current-session presentation is awaiting the client');
    const nextCommand = {
      id: operationId,
      clientId: client.binding.clientId,
      kind: 'composer.replace' as const,
      transaction: {
        expectedRevision: client.binding.draftRevision,
        operations: [{ kind: 'text.set' as const, text }],
      },
    };
    let published = false;
    let resolveAck: (ack: CurrentSessionPresentationAckV1 | null) => void = () => undefined;
    const ackPromise = new Promise<CurrentSessionPresentationAckV1 | null>((resolve) => { resolveAck = resolve; });
    pendingCommands.set(operationId, Object.freeze({
      clientId: client.binding.clientId,
      origin: client.origin,
      resolve: resolveAck,
    }));
    try {
      await updateState((current) => ({ ...current, revision: ++revision, command: nextCommand }));
      published = true;
    } catch (error) {
      pendingCommands.delete(operationId);
      if (isLocalContractFailure(error)) {
        return unavailable('The presentation command did not satisfy the bounded host contract');
      }
      return isKnownPreApplicationFailure(error)
        ? unavailable('The presentation target was offline before the command could be published')
        : outcomeUnknown('The command may have been published before the transport failed');
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ackTimeoutMs);
      timer.unref?.();
    });
    const ack = await Promise.race([
      ackPromise,
      timeout,
      abortPromise(params.signal),
      ...(options?.signal ? [abortPromise(options.signal)] : []),
    ]);
    if (timer) clearTimeout(timer);
    pendingCommands.delete(operationId);
    await clearCommand(operationId);
    if (!ack) {
      return published
        ? outcomeUnknown('The command was published, but the client acknowledgement was not observed')
        : unavailable('The command was not published');
    }
    const result = ComposerTransactionResultV1Schema.safeParse(ack.result);
    return result.success
      ? mapComposerTransactionResult(hostNonce, result.data)
      : unavailable('The client returned a result for a different presentation operation');
  };

  const publishPresentationIntent = async (
    operationId: string,
    intent: CurrentSessionPresentationIntentV1,
    options?: { signal?: AbortSignal },
  ): Promise<HostSessionPresentationOneShotResult> => {
    if (!operationId.trim() || !isAvailable() || options?.signal?.aborted) {
      return unavailable('The current Agent session is not available');
    }
    const client = boundClient;
    if (!client) return unavailable(
      'No current Session UI is mounted',
      'current_session_presentation_not_current',
    );
    if (!client.binding.focused) return conflict('The target Session UI is not focused');
    if (pendingCommands.size > 0) return unavailable('Another current-session presentation is awaiting the client');
    let publishedRevision = 0;
    let resolveAck: (ack: CurrentSessionPresentationAckV1 | null) => void = () => undefined;
    const ackPromise = new Promise<CurrentSessionPresentationAckV1 | null>((resolve) => { resolveAck = resolve; });
    pendingCommands.set(operationId, Object.freeze({
      clientId: client.binding.clientId,
      origin: client.origin,
      resolve: resolveAck,
    }));
    try {
      const published = await updateState((current) => ({
        ...current,
        revision: ++revision,
        command: { id: operationId, clientId: client.binding.clientId, kind: 'presentation.apply', intent },
      }));
      publishedRevision = published.revision;
    } catch (error) {
      pendingCommands.delete(operationId);
      if (isLocalContractFailure(error)) {
        return unavailable('The presentation command did not satisfy the bounded host contract');
      }
      return isKnownPreApplicationFailure(error)
        ? unavailable('The presentation target was offline before the command could be published')
        : outcomeUnknown('The command may have been published before the transport failed');
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ackTimeoutMs);
      timer.unref?.();
    });
    const ack = await Promise.race([
      ackPromise,
      timeout,
      abortPromise(params.signal),
      ...(options?.signal ? [abortPromise(options.signal)] : []),
    ]);
    if (timer) clearTimeout(timer);
    pendingCommands.delete(operationId);
    await clearCommand(operationId);
    if (!ack) return outcomeUnknown('The command was published, but the client acknowledgement was not observed');
    const result = CurrentSessionPresentationIntentResultV1Schema.safeParse(ack.result);
    return result.success
      ? mapPresentationIntentResult(hostNonce, publishedRevision, result.data)
      : unavailable('The client returned a result for a different presentation operation');
  };

  const service: HostCurrentSessionPresentationService = {
    notify: async (request, options) => await publishNotification(
      request.operationId,
      request,
      options,
    ),
    setStatus: async (request, options) => {
      const owner = stampOwner(request.owner);
      if (!owner) return unavailable('The current-session presentation owner did not satisfy the host contract');
      if (hasPendingOwnerPurge(owner)) {
        return unavailable('The current-session presentation owner has retired');
      }
      return await setStateful(request.operationId, (current, nextRevision) => ({
        ...current,
        revision: nextRevision,
        statuses: request.text === null
          ? current.statuses.filter((entry) => (
              entry.localKey !== request.key || !sameCurrentSessionPresentationOwnerV1(entry.owner, owner)
            ))
          : [...current.statuses.filter((entry) => (
              entry.localKey !== request.key || !sameCurrentSessionPresentationOwnerV1(entry.owner, owner)
            )), {
              localKey: request.key, text: request.text, owner, revision: nextRevision,
            }],
      }), options);
    },
    setWidget: async (request, options) => {
      const owner = stampOwner(request.owner);
      if (!owner) return unavailable('The current-session presentation owner did not satisfy the host contract');
      if (hasPendingOwnerPurge(owner)) {
        return unavailable('The current-session presentation owner has retired');
      }
      return await setStateful(request.operationId, (current, nextRevision) => ({
        ...current,
        revision: nextRevision,
        widgets: request.lines === null
          ? current.widgets.filter((entry) => (
              entry.localKey !== request.key || !sameCurrentSessionPresentationOwnerV1(entry.owner, owner)
            ))
          : [...current.widgets.filter((entry) => (
              entry.localKey !== request.key || !sameCurrentSessionPresentationOwnerV1(entry.owner, owner)
            )), {
              localKey: request.key,
              placement: request.placement,
              lines: [...request.lines],
              owner,
              revision: nextRevision,
            }],
      }), options);
    },
    purgeOwner: async (request) => {
      const owner = stampOwner(request.owner);
      if (!owner) return unavailable('The current-session presentation owner did not satisfy the host contract');
      const retainAfterFailure = !params.signal.aborted;
      if (retainAfterFailure) retainOwnerPurge(owner);
      const result = await setStateful(request.operationId, (current, nextRevision) => {
        const statuses = current.statuses.filter((entry) => (
          !sameCurrentSessionPresentationOwnerV1(entry.owner, owner)
        ));
        const widgets = current.widgets.filter((entry) => (
          !sameCurrentSessionPresentationOwnerV1(entry.owner, owner)
        ));
        if (
          statuses.length === current.statuses.length
          && widgets.length === current.widgets.length
        ) {
          return current;
        }
        return { ...current, revision: nextRevision, statuses, widgets };
      }, undefined, true);
      if (result.status === 'unavailable' && retainAfterFailure) {
        schedulePendingOwnerPurgeRetry();
      }
      return result;
    },
    replaceComposerText: async (request, options) => {
      const client = boundClient;
      if (!client?.binding.focused) return conflict('The target session composer is not focused');
      return await publishComposerReplace(
        request.operationId,
        request.text,
        options,
      );
    },
    present: async (request, options) => await publishPresentationIntent(
      request.operationId,
      request.intent,
      options,
    ),
  };
  return Object.freeze(service);
}
