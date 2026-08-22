import {
  SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX,
} from '@happier-dev/protocol';
import { SESSION_RUNTIME_ACTIVITY_SLOT_ACTIVE_COUNT_MAX } from '@happier-dev/protocol/runtime';
import type { AgentSessionRuntimeEventV1 } from '@happier-dev/protocol/runtime';
import {
  createRegisteredSessionStateFieldMutation,
  type RegisteredSessionStateFieldMutationV1,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { RuntimeActivityApplicability } from './runtimeActivityApplicability';

export type { RuntimeActivityApplicability } from './runtimeActivityApplicability';

export type HostRuntimeActivityState = 'active' | 'idle' | 'unknown';
export type HostRuntimeActivitySnapshot = Readonly<{
  state: HostRuntimeActivityState;
  activeCount: number;
}>;
type HostRuntimeActivityPublication = Readonly<{
  state: HostRuntimeActivityState;
  activeCount: number;
}>;

type AgentRuntimeActivitySnapshot = HostRuntimeActivitySnapshot;
type ExecutionRunsActivitySnapshot = HostRuntimeActivitySnapshot;

type AgentRuntimeBinding = Readonly<{
  observeEvent(event: AgentSessionRuntimeEventV1): Promise<void>;
  revoke(): Promise<void>;
}>;
type AgentRuntimeActivitySubscriber = (
  handler: (event: AgentSessionRuntimeEventV1) => void,
) => () => void;

type ExecutionRunsBinding = Readonly<{
  observeSnapshot(snapshot: ExecutionRunsActivitySnapshot): Promise<void>;
  revoke(): Promise<void>;
}>;

export type HostRuntimeActivityProjection = Readonly<{
  bindAgentRuntime(options: Readonly<{ applicability: 'supported' }>): AgentRuntimeBinding;
  bindExecutionRuns(): ExecutionRunsBinding;
  reofferCurrentSnapshot(): Promise<void>;
  notifyRuntimeDetached(): void;
  notifyTransportDisconnected(): void;
  dispose(): void;
}>;

export function resolveAgentRuntimeActivitySubscriber(params: Readonly<{
  applicability: RuntimeActivityApplicability;
  subscribeAgentSessionRuntimeEvents?: AgentRuntimeActivitySubscriber;
}>): AgentRuntimeActivitySubscriber | null {
  if (params.applicability !== 'supported') return null;
  if (!params.subscribeAgentSessionRuntimeEvents) {
    throw new Error('Supported Runtime Activity requires an activated canonical agent-runtime producer');
  }
  return params.subscribeAgentSessionRuntimeEvents;
}

const IDLE: HostRuntimeActivitySnapshot = Object.freeze({
  state: 'idle',
  activeCount: 0,
});
const UNKNOWN: HostRuntimeActivitySnapshot = Object.freeze({
  state: 'unknown',
  activeCount: 0,
});

export function createInitialHostRuntimeActivityMutation(params: Readonly<{
  sessionId: string;
  agentRuntimeApplicability: RuntimeActivityApplicability;
  observedAt?: number;
}>): RegisteredSessionStateFieldMutationV1 {
  const applicability = params.agentRuntimeApplicability;
  const snapshot = applicability !== 'not_applicable' ? UNKNOWN : IDLE;
  return createRegisteredSessionStateFieldMutation({
    sessionId: params.sessionId,
    fieldId: 'runtime.activity',
    deliveryClass: 'durable_best_effort',
    source: 'runtime',
    observedAt: params.observedAt,
    op: { kind: 'set', value: toPublication(snapshot) },
  });
}

function validateSnapshot(
  snapshot: HostRuntimeActivitySnapshot,
  slot: 'agentRuntime' | 'executionRuns',
): void {
  if (!Number.isSafeInteger(snapshot.activeCount)
    || snapshot.activeCount < 0
    || snapshot.activeCount > SESSION_RUNTIME_ACTIVITY_SLOT_ACTIVE_COUNT_MAX) {
    throw new RangeError(`${slot} Runtime Activity count is outside the fixed-slot bound`);
  }
  if (snapshot.state === 'active') {
    if (snapshot.activeCount === 0) {
      throw new Error(`${slot} active Runtime Activity requires a positive count`);
    }
  } else if (snapshot.activeCount !== 0) {
    throw new Error(`${slot} idle/unknown Runtime Activity requires zero count`);
  }
}

function aggregate(
  agentRuntime: AgentRuntimeActivitySnapshot,
  executionRuns: ExecutionRunsActivitySnapshot,
): HostRuntimeActivitySnapshot {
  const active = [agentRuntime, executionRuns].filter((snapshot) => snapshot.state === 'active');
  if (active.length > 0) {
    const activeCount = active.reduce((count, snapshot) => count + snapshot.activeCount, 0);
    if (!Number.isSafeInteger(activeCount) || activeCount > SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX) {
      throw new RangeError('Aggregated Runtime Activity count exceeds the public bound');
    }
    return Object.freeze({ state: 'active', activeCount });
  }
  return agentRuntime.state === 'unknown' || executionRuns.state === 'unknown'
    ? UNKNOWN
    : IDLE;
}

function toPublication(snapshot: HostRuntimeActivitySnapshot): HostRuntimeActivityPublication {
  return Object.freeze({
    state: snapshot.state,
    activeCount: snapshot.activeCount,
  });
}

function equalPublication(
  left: HostRuntimeActivityPublication,
  right: HostRuntimeActivityPublication,
): boolean {
  return left.state === right.state && left.activeCount === right.activeCount;
}

export function createHostRuntimeActivityProjection(options: Readonly<{
  sessionId: string;
  agentRuntimeApplicability: RuntimeActivityApplicability;
  enqueueRegisteredSessionStateFieldMutation(
    mutation: RegisteredSessionStateFieldMutationV1,
  ): void | Promise<void>;
  onFireAndForgetPublicationError?(error: unknown): void;
}>): HostRuntimeActivityProjection {
  const initialAgentRuntimeApplicability = options.agentRuntimeApplicability;
  let agentRuntime: AgentRuntimeActivitySnapshot = initialAgentRuntimeApplicability === 'not_applicable'
    ? { state: 'idle', activeCount: 0 }
    : { state: 'unknown', activeCount: 0 };
  let executionRuns: ExecutionRunsActivitySnapshot = { state: 'idle', activeCount: 0 };
  let acceptedSnapshot: HostRuntimeActivityPublication | null = null;
  let desiredPublication: Readonly<{
    id: number;
    snapshot: HostRuntimeActivityPublication;
    result: Promise<void>;
  }> | null = null;
  let nextPublicationId = 0;
  let hasScheduledPublication = false;
  let runtimeBinding = 0;
  let executionRunsBinding = 0;
  let disposed = false;
  let publicationTail = Promise.resolve();

  const enqueueSnapshot = (snapshot: HostRuntimeActivityPublication): void | Promise<void> =>
    options.enqueueRegisteredSessionStateFieldMutation(
      createRegisteredSessionStateFieldMutation({
        sessionId: options.sessionId,
        fieldId: 'runtime.activity',
        deliveryClass: 'durable_best_effort',
        source: 'runtime',
        op: { kind: 'set', value: snapshot },
      }),
    );

  const publishCurrentSnapshot = (force: boolean): Promise<void> => {
    if (disposed) return publicationTail;
    const next = aggregate(agentRuntime, executionRuns);
    const publication = toPublication(next);
    if (!force && desiredPublication && equalPublication(desiredPublication.snapshot, publication)) {
      return desiredPublication.result;
    }
    if (!force && !desiredPublication && acceptedSnapshot && equalPublication(acceptedSnapshot, publication)) {
      return publicationTail;
    }

    const id = ++nextPublicationId;
    const enqueue = hasScheduledPublication
      ? publicationTail.then(() => enqueueSnapshot(publication))
      : Promise.resolve(enqueueSnapshot(publication));
    hasScheduledPublication = true;
    const result = enqueue
      .then(() => {
        acceptedSnapshot = publication;
      });
    publicationTail = result.catch(() => undefined);
    desiredPublication = Object.freeze({ id, snapshot: publication, result });
    void result.then(
      () => {
        if (desiredPublication?.id === id) desiredPublication = null;
      },
      () => {
        if (desiredPublication?.id === id) desiredPublication = null;
      },
    );
    return result;
  };

  const publishIfChanged = (): Promise<void> => publishCurrentSnapshot(false);

  const observeFireAndForgetPublication = (publication: Promise<void>): void => {
    void publication
      .catch((error: unknown) => options.onFireAndForgetPublicationError?.(error))
      .catch(() => undefined);
  };

  observeFireAndForgetPublication(publishIfChanged());

  const reportAgentRuntimeSnapshot = async (snapshot: AgentRuntimeActivitySnapshot): Promise<void> => {
    if (disposed) return;
    validateSnapshot(snapshot, 'agentRuntime');
    agentRuntime = Object.freeze({ ...snapshot });
    await publishIfChanged();
  };

  return Object.freeze({
    bindAgentRuntime(bindingOptions) {
      const binding = ++runtimeBinding;
      void bindingOptions;
      agentRuntime = { state: 'idle', activeCount: 0 };
      observeFireAndForgetPublication(publishIfChanged());
      return Object.freeze({
        async observeEvent(event: AgentSessionRuntimeEventV1) {
          if (
            disposed
            || binding !== runtimeBinding
            || event.sessionId !== options.sessionId
            || event.kind !== 'runtime-activity-snapshot'
          ) return;
          await reportAgentRuntimeSnapshot({
            state: event.state,
            activeCount: event.activeCount,
          });
        },
        async revoke() {
          if (disposed || binding !== runtimeBinding) return;
          runtimeBinding += 1;
          agentRuntime = { state: 'idle', activeCount: 0 };
          await publishIfChanged();
        },
      });
    },
    bindExecutionRuns() {
      const binding = ++executionRunsBinding;
      return Object.freeze({
        async observeSnapshot(snapshot: ExecutionRunsActivitySnapshot) {
          if (disposed || binding !== executionRunsBinding) return;
          validateSnapshot(snapshot, 'executionRuns');
          executionRuns = Object.freeze({ ...snapshot });
          await publishIfChanged();
        },
        async revoke() {
          if (disposed || binding !== executionRunsBinding) return;
          executionRunsBinding += 1;
          executionRuns = { state: 'idle', activeCount: 0 };
          await publishIfChanged();
        },
      });
    },
    reofferCurrentSnapshot() {
      return publishCurrentSnapshot(true);
    },
    notifyRuntimeDetached() {
      // Detachment is subscription lifecycle only; it is not Activity evidence.
    },
    notifyTransportDisconnected() {
      // Generic transport loss is not Activity evidence.
    },
    dispose() {
      disposed = true;
      runtimeBinding += 1;
      executionRunsBinding += 1;
    },
  });
}
