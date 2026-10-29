import axios from '@/api/client/credentialAxios';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { followDeliveryMuteScopeKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { SessionFollowSourceOccurrenceRoutesResponseV1Schema, type SessionFollowSourceOccurrenceRoutesResponseV1,
  type SessionFollowDiscussionOccurrenceRoutesRequestV1, type SessionFollowRunRouteReleaseReasonV1,
  type SessionFollowRunOccurrenceRoutesQueryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { ExecutionRunOutputRefV1 } from '@happier-dev/protocol/reviews/reviewNarration';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { acquireRequesterAccountEncryptionCurrentness, type RunFollowAvailability } from '@/api/client/accountEncryptionCurrentnessObservation';

/** Host read inputs keep the protocol's Run identities without distributing a nested union at every caller. */
export type RunFollowRouteRead = Readonly<{ original: RunFollowOriginalV1 }>
  | Readonly<{ source: RunFollowOriginalV1['source']; outputRef?: ExecutionRunOutputRefV1 }>;
type RunRequest = Readonly<{ v: 1 }> & RunFollowRouteRead;
type DiscussionRequest = SessionFollowDiscussionOccurrenceRoutesRequestV1;
type Request = RunRequest | DiscussionRequest;
type Routes = Extract<SessionFollowSourceOccurrenceRoutesResponseV1, { ok: true }>;
type Availability = RunFollowAvailability | DiscussionRequest['source'];
type DispatchContext = Readonly<{ receiverSessionId?: string; personalOnly?: boolean }>;
type Demand = { request: Request; contexts: DispatchContext[]; unavailable: boolean; pending: Promise<Routes | null> | null;
  targetMachineId?: string; releaseReason?: SessionFollowRunRouteReleaseReasonV1 };

/** Account-lifetime non-Session source demand. Refusal is not a new publication. */
export function createAccountRunFollowRoutes(input: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; signal: AbortSignal; isCurrent: () => Promise<boolean>;
  subscribeAvailability?: (listener: (change: RunFollowAvailability) => void) => () => void;
}>) {
  const demands = new Map<string, Demand>();
  let disposed = false;
  let releaseAvailability: (() => void) | undefined;
  let dispatch: ((request: RunRequest, context: DispatchContext) => Promise<void>) | undefined;
  let dispatchDiscussion: ((source: DiscussionRequest['source']) => Promise<void>) | undefined;
  const current = async () => !disposed && !input.signal.aborted && await input.isCurrent();
  const sourceOf = (request: Request) => 'original' in request ? request.original.source : request.source;
  const keyOf = (request: Request) => JSON.stringify('original' in request ? { original: request.original }
    : { source: followDeliveryMuteScopeKeyV1({ kind: 'source', source: request.source }),
      ...('outputRef' in request && request.outputRef ? { outputRef: request.outputRef } : {}) });
  const matchesSource = (request: Request, change: Availability) => {
    const source = sourceOf(request);
    return source.kind === 'discussion' ? change.kind === 'reconnected'
      || change.kind === 'discussion' && source.discussionId === change.discussionId
      : source.kind === 'execution_run' && (change.kind === 'reconnected'
      || change.kind === 'machine' && ('sessionId' in source || source.machineId === change.machineId)
      || change.kind === 'execution_run' && sameStrictJsonValue(source, change));
  };
  const matchesTarget = (demand: Demand, change: Availability) => {
    const source = sourceOf(demand.request);
    if (change.kind !== 'machine' || source.kind !== 'execution_run') return true;
    const target = 'machineId' in source ? source.machineId : demand.targetMachineId;
    // A supported older server's fieldless refusal cannot identify a target.
    // Preserve that existing broad recovery without inventing a Machine.
    return target === undefined || target === change.machineId;
  };
  const releaseReason = (demand: Demand, change: Availability, reason?: SessionFollowRunRouteReleaseReasonV1): SessionFollowRunRouteReleaseReasonV1 | undefined => {
    const source = sourceOf(demand.request);
    if (source.kind !== 'execution_run') return undefined;
    if (reason) return reason;
    if (change.kind === 'reconnected') return 'account_reconnect';
    if (change.kind === 'execution_run') return 'exact_run';
    if (change.kind === 'machine') return 'machineId' in source || demand.targetMachineId !== undefined ? 'target_machine' : 'legacy_broad';
    return undefined;
  };
  const read = (request: Request, context: DispatchContext = {}, diagnostic?: SessionFollowRunRouteReleaseReasonV1): Promise<Routes | null> => {
    const key = keyOf(request);
    const demand: Demand = demands.get(key) ?? { request, contexts: [], unavailable: false, pending: null };
    if (!demand.contexts.some(previous => sameStrictJsonValue(previous, context))) demand.contexts.push(context);
    if (demand.unavailable) return Promise.resolve(null);
    if (demand.pending) {
      // Exact Discussion rechecks share unavailability, not successful answers
      // for a different message. Serialize distinct reads through this source.
      return sameStrictJsonValue(demand.request, request) ? demand.pending : demand.pending.then(() => read(request, context, diagnostic));
    }
    demand.request = request;
    const work = (async () => {
      if (!await current()) return null;
      // Workflow sources do not consume frontier availability. Discussion
      // source changes use C3's existing feed; connection recovery is shared.
      if (sourceOf(request).kind !== 'workflow_run' && !releaseAvailability) {
        releaseAvailability = input.subscribeAvailability?.(onAvailability);
      }
      const reason = diagnostic ?? demand.releaseReason;
      const params: SessionFollowRunOccurrenceRoutesQueryV1 | undefined = sourceOf(request).kind === 'execution_run'
        ? { includeTargetMachineId: 'true', ...(reason ? { releaseReason: reason } : {}) } : undefined;
      delete demand.releaseReason;
      const response = await axios.post(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes}`,
        request, { headers: { Authorization: `Bearer ${input.credentials.token}` },
          ...(params ? { params } : {}),
          signal: input.signal, validateStatus: () => true });
      if (!await current()) return null;
      const parsed = SessionFollowSourceOccurrenceRoutesResponseV1Schema.safeParse(response.data);
      demand.unavailable = response.status === 409 && parsed.success && !parsed.data.ok && parsed.data.error === 'source_unavailable'
        && sourceOf(request).kind !== 'workflow_run';
      demand.targetMachineId = demand.unavailable && parsed.success && !parsed.data.ok
        && 'targetMachineId' in parsed.data ? parsed.data.targetMachineId : undefined;
      return response.status === 200 && parsed.success && parsed.data.ok ? parsed.data : null;
    })().finally(() => {
      demand.pending = null;
      if (!demand.unavailable && demands.get(key) === demand) demands.delete(key);
    });
    demand.pending = work;
    demands.set(key, demand);
    return work;
  };
  const available = async (change: Availability, reason?: SessionFollowRunRouteReleaseReasonV1) => {
    const selected = [...demands].filter(([, demand]) => matchesSource(demand.request, change));
    await Promise.allSettled(selected.flatMap(([, demand]) => demand.pending ? [demand.pending] : []));
    const released: Demand[] = [];
    for (const [key, demand] of selected) if (demands.get(key) === demand && demand.unavailable && matchesTarget(demand, change)) {
      // Match after pending reads settle: a Session Run's refusal may be the
      // first fact identifying its target. Keep the reason on this same demand
      // until its next HTTP attempt, including explicit callers ignoring us.
      demand.unavailable = false;
      demand.releaseReason = releaseReason(demand, change, reason);
      released.push(demand);
    }
    return released;
  };
  const onAvailability = (change: RunFollowAvailability) => {
    // A push received during a read belongs after that read, not before its
    // refusal. The incumbent source event supplies demand; no retry is added.
    void (async () => {
      const selected = await available(change);
      if (!await current()) return;
      // Preserve the original caller's scope; sharing one fresh transport read
      // does not promote a personal catch-up into Session delivery.
      for (const demand of selected) if (await current()) {
        const request = demand.request;
        if ('original' in request) await Promise.all(demand.contexts.map(context => dispatch?.(request, context)));
        else if (request.source.kind === 'discussion') await dispatchDiscussion?.(request.source);
        else {
          const run: RunRequest = { v: 1, source: request.source,
            ...('outputRef' in request && request.outputRef ? { outputRef: request.outputRef } : {}) };
          await Promise.all(demand.contexts.map(context => dispatch?.(run, context)));
        }
      }
    })().catch(() => { if (!disposed && !input.signal.aborted) logger.warn('[Session Follow] Source availability dispatch unavailable'); });
  };
  return {
    read: async (request: RunRequest, context?: DispatchContext, diagnostic?: SessionFollowRunRouteReleaseReasonV1) => {
      const routes = await read(request, context, diagnostic);
      return routes && 'original' in routes ? routes : null;
    },
    readDiscussion: async (request: DiscussionRequest) => {
      const routes = await read(request);
      return routes && 'discussion' in routes ? routes.discussion : null;
    },
    available, bindDispatch: (listener: typeof dispatch) => { dispatch = listener; },
    bindDiscussionDispatch: (listener: typeof dispatchDiscussion) => { dispatchDiscussion = listener; },
    dispose: () => { disposed = true; demands.clear(); dispatch = undefined; dispatchDiscussion = undefined;
      releaseAvailability?.(); releaseAvailability = undefined; } };
}

/** Reuse the existing Account socket: no new poll or availability protocol. */
export function createObservedAccountRunFollowRoutes(input: Parameters<typeof createAccountRunFollowRoutes>[0] & Readonly<{ accountId: string }>) {
  let observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | undefined;
  const routes = createAccountRunFollowRoutes({ ...input, subscribeAvailability: listener => {
    observation ??= acquireRequesterAccountEncryptionCurrentness({ accountId: input.accountId, token: input.credentials.token,
      serverBaseUrl: input.serverHttpBaseUrl });
    return observation.subscribeRunFollowAvailability(listener);
  } });
  return { ...routes, dispose: () => { routes.dispose(); void observation?.dispose().catch(() => {
    logger.warn('[Session Follow] Run availability observation retirement unavailable');
  }); } };
}
