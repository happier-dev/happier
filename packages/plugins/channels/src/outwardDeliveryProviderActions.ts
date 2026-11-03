import type {
  ConversationDeliveryInputV1,
  ConversationDeliveryReconcileInputV1,
  ConversationDeliveryReplyContextV1,
  ConversationDeliveryResultV1,
} from '@happier-dev/channels-protocol/v1';
import {
  ConversationBindingTargetV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryReconcileInputV1Schema,
  ConversationDeliveryResultV1Schema,
  countConversationTextUnits,
} from '@happier-dev/channels-protocol/v1';
import { sha256 } from '@noble/hashes/sha256';
import type { TargetedContributionsService } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  isPluginActionHandlerInvocationNotStartedAdvisory,
  type AdmittedTargetedOperationExecutionHandle,
  type ActionsService,
  type PluginMachineExecutionRoutingV1,
} from '@happier-dev/plugin-sdk/actions';
import { isConversationDeliveryAutomaticTerminal } from './deliveryCustody.js';
import { encodeUnpaddedBase64Url } from './privateRowIdentity.js';
import { ConversationProviderContributionNotCurrentError, readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import { getConversationConnectionExecutionRouting } from './connectionLifecycle.js';
import type {
  ConversationSessionProjectionBinding,
  ConversationSessionProjectionSource,
} from './sessionProjection.js';
import { createConversationSessionProjectionFrontierRowId } from './sessionProjection.js';
import {
  type ChannelStateCollection,
  type StoredCollectionRow,
  type ConversationOutwardDeliveryProviderInvocationResult,
  loadConversationAccountLocalBindingPolicyModule,
  deriveConversationOutwardDeliveryCustodyId,
  hasRetainedConversationOutwardDeliveryContent,
  readConnectionFacts,
  readBindingFacts,
  checkConversationOutwardDeliveryRouteCurrentness,
  normalizeConversationOutwardDeliveryCurrentnessResult,
  isConversationOutwardDeliveryPreEffectSuppression,
  redriveConversationOutwardDelivery,
  deliverConversationOutwardDelivery,
  reconcileConversationOutwardDeliveryAttempt,
  type ConversationOutwardDeliveryAuthority,
  type ConversationOutwardDeliveryCurrentnessResult,
  type ConversationOutwardDeliveryRecord,
  type ConversationOutwardDeliveryStore,
  type ConversationOutwardDeliveryObligation,
  type ConversationOutboundTextLimit,
  type ConversationOutwardDeliveryResult,
  type ConversationOutwardDeliveryRecoveryResult,
} from './outwardDelivery.js';

type ConversationAccountLocalBindingPolicyModule = Awaited<ReturnType<typeof loadConversationAccountLocalBindingPolicyModule>>;

type ConversationOutwardDeliveryProviderActionInvocation = Readonly<{
  action: AdmittedTargetedOperationExecutionHandle<JsonValue, ConversationDeliveryResultV1>;
  input: ConversationDeliveryInputV1 | ConversationDeliveryReconcileInputV1;
  expectedExecutionRouting: PluginMachineExecutionRoutingV1;
  outboundTextLimit?: ConversationOutboundTextLimit;
}>;

type ConversationOutwardDeliveryProviderActionBoundary = Readonly<{
  authority: ConversationOutwardDeliveryAuthority;
  invoke(signal: AbortSignal): Promise<ConversationOutwardDeliveryProviderInvocationResult>;
}>;

/**
 * Builds the provider Action input from the same connection snapshot that just
 * passed canonical route currentness. The raw provider config remains opaque
 * to Channels but is admitted by the public provider Action schema before
 * dispatch. No provider callback can choose a target or origin itself.
 */
async function prepareConversationOutwardDeliveryProviderActionInvocation(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  record: ConversationOutwardDeliveryRecord;
  signal: AbortSignal;
  operation: 'deliver' | 'reconcile';
}>): Promise<
  | Readonly<{ kind: 'ready'; invocation: ConversationOutwardDeliveryProviderActionInvocation }>
  | ConversationOutwardDeliveryCurrentnessResult
> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  }
  const currentness = await checkConversationOutwardDeliveryRouteCurrentness({
    stateCollection: input.stateCollection,
    signal: input.signal,
    obligation: input.record.obligation,
    requireBindingRevision: false,
  });
  if (currentness.kind !== 'current') return normalizeConversationOutwardDeliveryCurrentnessResult(currentness);
  const provider = currentness.connection.providerAction;
  const contribution = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: input.targetedContributions,
      signal: input.signal,
    },
    providerPluginId: provider.providerPluginId,
    providerContributionSelection: provider.providerContributionSelection,
  }).catch((error: unknown) => {
    if (error instanceof ConversationProviderContributionNotCurrentError) return null;
    throw error;
  });
  if (contribution === null) return { kind: 'suppressed', reason: 'providerGenerationRetired' };
  const action = input.operation === 'deliver'
    ? contribution.operations.messageDeliver
    : contribution.operations.deliveryReconcile;
  if (action === undefined) return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  const providerConnection = {
    v: 1,
    connectionId: input.record.obligation.connectionId,
    providerConnectionKey: provider.providerConnectionKey,
    providerConfigVersion: provider.providerConfigVersion,
    providerConfig: provider.providerConfig,
    credentialRef: currentness.connection.credentialRef,
  };
  const actionInput = input.operation === 'deliver'
    ? ConversationDeliveryInputV1Schema.safeParse({
      ...providerConnection,
      endpoint: input.record.obligation.endpoint,
      content: input.record.obligation.content,
      ...(input.record.obligation.newThread === undefined ? {} : { newThread: input.record.obligation.newThread }),
      deliveryKey: input.record.obligation.deliveryKey,
      ...(input.record.obligation.replyContext === undefined
        ? {}
        : { replyContext: input.record.obligation.replyContext }),
      mentionPolicy: input.record.obligation.mentionPolicy,
      linkPreviewPolicy: input.record.obligation.linkPreviewPolicy,
    })
    : ConversationDeliveryReconcileInputV1Schema.safeParse({
      ...providerConnection,
      endpoint: input.record.obligation.endpoint,
      deliveryKey: input.record.obligation.deliveryKey,
    });
  if (!actionInput.success) return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  return {
    kind: 'ready',
    invocation: {
      action,
      input: actionInput.data,
      expectedExecutionRouting: getConversationConnectionExecutionRouting(currentness.connection.transportOrigin, provider.providerPluginId),
      ...(currentness.connection.outboundTextLimit === undefined
        ? {} : { outboundTextLimit: currentness.connection.outboundTextLimit }),
    },
  };
}

/**
 * One splitter for fresh delivery and redrive; providers never split again.
 * The native-limit formatting contract preserves unit counts, so this measure
 * includes the eventual provider rendering and mention suppression as well.
 */
function splitConversationOutboundText(text: string, limit: ConversationOutboundTextLimit): readonly string[] | null {
  type Fence = { start: number; bodyStart: number; closeStart: number; end: number; opener: string; marker: string; fits: boolean; closed: boolean };
  const fences: Fence[] = [];
  let open: Omit<Fence, 'closeStart' | 'end' | 'fits' | 'closed'> | undefined;
  for (const line of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm)) {
    const marker = line[1]!;
    const info = line[2]!;
    if (open) {
      if (marker[0] !== open.marker[0] || marker.length < open.marker.length || info.trim()) continue;
      // The newline following a closing fence is prose separation, not part
      // of the block. A block exactly at the native ceiling still fits whole.
      const end = line.index + line[0].replace(/\r?\n$/, '').length;
      fences.push({ ...open, closeStart: line.index, end, closed: true,
        fits: countConversationTextUnits(text.slice(open.start, end), limit.unit) <= limit.maximum });
      open = undefined;
    } else if (marker[0] !== '`' || !info.includes('`')) {
      open = { start: line.index, bodyStart: line.index + line[0].length,
        opener: line[0].replace(/\r?\n$/, '') + '\n', marker };
    }
  }
  if (open) fences.push({ ...open, closeStart: text.length, end: text.length, fits: false, closed: false });

  // Keep original whitespace. These ranks are preferences, never truncation.
  const ranks = new Map<number, number>();
  for (const boundary of text.matchAll(/((?:\r?\n[\t ]*){2,})|(\r?\n)|([^\S\r\n]+)/g)) {
    ranks.set(boundary.index + boundary[0].length, boundary[1] ? 3 : boundary[2] ? 2 : 1);
  }
  let fenceIndex = 0;
  const points = Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), ({ segment, index }) => {
    const end = index + segment.length;
    while (fences[fenceIndex] && (fences[fenceIndex]!.end < end
      || (fences[fenceIndex]!.end === end && fences[fenceIndex]!.closed))) fenceIndex++;
    const fence = fences[fenceIndex];
    return { end, segment, units: countConversationTextUnits(segment, limit.unit),
      fence: fence && fence.start < end ? fence : undefined };
  });
  const chunks: string[] = [];
  let start = 0;
  let first = 0;
  let prefix = '';
  while (first < points.length) {
    let units = countConversationTextUnits(prefix, limit.unit);
    let selected: { index: number; suffix: string; fence: Fence | undefined; rank: number } | undefined;
    for (let index = first; index < points.length; index++) {
      const point = points[index]!;
      units += point.units;
      if (units > limit.maximum) break;
      const fence = point.fence;
      // A fitting block is atomic. Even a long block's opening/closing lines
      // remain atomic; only its body may be continued in another message.
      if (fence && (fence.fits || point.end <= fence.bodyStart
        || (fence.closed && point.end >= fence.closeStart))) continue;
      const suffix = fence ? `${point.segment.endsWith('\n') ? '' : '\n'}${fence.marker}` : '';
      if (units + countConversationTextUnits(suffix, limit.unit) > limit.maximum) continue;
      const rank = point.end === text.length ? 4 : ranks.get(point.end) ?? 0;
      if (selected === undefined || rank >= selected.rank) selected = { index, suffix, fence, rank };
    }
    if (selected === undefined) return null;
    const end = points[selected.index]!.end;
    chunks.push(prefix + text.slice(start, end) + selected.suffix);
    prefix = selected.fence?.opener ?? '';
    start = end;
    first = selected.index + 1;
  }
  return chunks;
}

function createConversationOutwardDeliveryProviderActionBoundary(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  operation: 'deliver' | 'reconcile';
}>): ConversationOutwardDeliveryProviderActionBoundary {
  let invocation: ConversationOutwardDeliveryProviderActionInvocation | undefined;
  let record: ConversationOutwardDeliveryRecord | undefined;
  return {
    authority: {
      async checkCurrentness(check) {
        invocation = undefined;
        record = check.record;
        const prepared = await prepareConversationOutwardDeliveryProviderActionInvocation({
          stateCollection: input.stateCollection,
          targetedContributions: input.targetedContributions,
          record: check.record,
          signal: check.signal,
          operation: input.operation,
        });
        if (prepared.kind !== 'ready') return prepared;
        invocation = prepared.invocation;
        return { kind: 'current' };
      },
    },
    async invoke(signal) {
      let current = invocation;
      const currentRecord = record;
      if (current === undefined || currentRecord === undefined) return { kind: 'outcomeUnknown', code: 'providerInvocationUnavailable' };
      const invoke = async (
        target: ConversationOutwardDeliveryProviderActionInvocation,
        actionInput: typeof target.input,
      ): Promise<ConversationDeliveryResultV1> => {
        try {
          const execution = await input.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
            target.action, actionInput, { signal, expectedExecutionRouting: target.expectedExecutionRouting },
          );
          // The host checks routing before the effect and exact invocation currentness afterward.
          const result = ConversationDeliveryResultV1Schema.safeParse(execution.result);
          return result.success ? result.data : { kind: 'outcomeUnknown', code: 'providerResultInvalid' };
        } catch (error) {
          // A missing delivery handler proves no send started. A missing
          // reconciliation handler says nothing about the earlier send.
          return input.operation === 'deliver' && isPluginActionHandlerInvocationNotStartedAdvisory(error)
            ? { kind: 'notDelivered', retry: 'safe', code: 'submissionNotStarted' }
            : { kind: 'outcomeUnknown', code: 'providerInvocationFailed' };
        }
      };
      const limit = current.outboundTextLimit;
      if (!('content' in current.input) || limit === undefined
        || countConversationTextUnits(current.input.content.text, limit.unit) <= limit.maximum) {
        return await invoke(current, current.input);
      }
      const content = current.input.content;
      const chunks = splitConversationOutboundText(content.text, limit);
      if (chunks === null) return { kind: 'notDelivered', retry: 'never', code: 'contentUnrepresentable' };
      const providerMessageIds: string[] = [];
      for (const [index, text] of chunks.entries()) {
        if (signal.aborted) return index === 0
          ? { kind: 'suppressedBeforeProviderEffect', reason: 'cancelled' }
          : { kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false };
        if (index > 0) {
          // Each later native message is a new effect. Reuse the same Account
          // and provider currentness owner, retaining any accepted evidence.
          const prepared = await prepareConversationOutwardDeliveryProviderActionInvocation({
            ...input, record: currentRecord, signal,
          }).catch(() => null);
          if (prepared === null || prepared.kind !== 'ready' || signal.aborted) {
            return { kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false };
          }
          current = prepared.invocation;
        }
        // Provider idempotency (such as Discord nonces) must distinguish chunks.
        // Hash the complete custody key so every allowed key remains bounded.
        const deliveryKey = `channels:chunk:v1:${encodeUnpaddedBase64Url(sha256(new TextEncoder().encode(
          JSON.stringify([current.input.deliveryKey, index]),
        )))}`;
        const result = await invoke(current, { ...current.input,
          content: { ...content, text }, deliveryKey, chunkIndex: index,
        });
        if (result.kind === 'delivered') {
          providerMessageIds.push(...result.providerMessageIds);
          continue;
        }
        if (result.kind === 'outcomeUnknown') return { ...result,
          providerMessageIds: [...providerMessageIds, ...(result.providerMessageIds ?? [])],
        };
        if (result.kind === 'partial') return { ...result,
          providerMessageIds: [...providerMessageIds, ...result.providerMessageIds], failedChunk: index,
        };
        return index === 0 ? result
          : { kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false };
      }
      return { kind: 'delivered', providerMessageIds };
    },
  };
}

/**
 * Executes an already-admitted custody row through the one provider Action
 * boundary. It retains the exact persisted obligation and cannot synthesize a
 * delivery key, route, or fallback send on restart.
 */
export async function redriveConversationOutwardDeliveryThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return isConversationDeliveryAutomaticTerminal(input.record.custody)
      ? { kind: 'settled', custody: input.record.custody }
      : { kind: 'notAttempted', reason: 'invalidRow' };
  }
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'deliver',
  });
  return await redriveConversationOutwardDelivery({
    store: input.store,
    record: input.record,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    deliver: async ({ signal }) => await boundary.invoke(signal),
  });
}

/** Fresh source producers share the exact provider Action/currentness boundary. */
export async function deliverConversationOutwardDeliveryThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  obligation: ConversationOutwardDeliveryObligation;
  outboundTextLimit?: ConversationOutboundTextLimit;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'deliver',
  });
  return await deliverConversationOutwardDelivery({
    store: input.store,
    obligation: input.obligation,
    outboundTextLimit: input.outboundTextLimit,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    deliver: async ({ signal }) => await boundary.invoke(signal),
  });
}

/**
 * The Session projection source reaches custody only here. It re-reads the
 * current binding to construct the binding-scoped authority arm, derives the
 * bounded external delivery key from the incumbent opaque custody identity,
 * and then enters the same provider/currentness path as every other source.
 */
export async function deliverConversationSessionProjectionOutwardDelivery(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  binding: ConversationSessionProjectionBinding;
  frontierRowRevision: number;
  source: ConversationSessionProjectionSource;
  content: string;
  replyContext?: ConversationDeliveryReplyContextV1;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  try {
    accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
  } catch {
    return { kind: 'notAttempted', reason: 'custodyUnavailable' };
  }
  let bindingRow: StoredCollectionRow | null;
  try {
    bindingRow = await input.stateCollection.get(input.binding.bindingId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (bindingRow === null) return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  const binding = readBindingFacts({
    accountLocalBindingPolicy,
    row: bindingRow,
    bindingId: input.binding.bindingId,
  });
  const target = binding === null
    ? { success: false as const }
    : ConversationBindingTargetV1Schema.safeParse(binding.target);
  if (binding === null
    || !target.success
    || target.data.kind !== 'session'
    || binding.connectionId !== input.binding.connectionId
    || target.data.sessionId !== input.binding.target.sessionId
    || target.data.sessionId !== input.source.sessionId
    || target.data.policy.deliveryMode !== input.binding.target.deliveryMode
    || !binding.enabled
    || binding.deletionState !== 'none'
    || binding.linkPreviewPolicy === undefined) {
    return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  }
  let connectionRow: StoredCollectionRow | null;
  try {
    connectionRow = await input.stateCollection.get(binding.connectionId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (connectionRow === null) return { kind: 'notAttempted', reason: 'connectionUnavailable' };
  const connection = readConnectionFacts({
    accountLocalBindingPolicy,
    row: connectionRow,
    connectionId: binding.connectionId,
  });
  if (connection === null) {
    return { kind: 'notAttempted', reason: 'connectionCorrupt' };
  }
  // Content reads may outlive unlink and reattach of this deterministic ID.
  // The existing frontier revision admits this page without rejecting harmless
  // binding edits. Work admitted here may finish across a later unlink.
  try {
    const frontier = await input.stateCollection.get(createConversationSessionProjectionFrontierRowId(input.binding.bindingId), {
      signal: input.signal,
    });
    if (frontier === null || frontier.revision !== input.frontierRowRevision) {
      return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
    }
  } catch {
    return { kind: 'notAttempted', reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable' };
  }
  const provisional: ConversationOutwardDeliveryObligation = {
    connectionId: binding.connectionId,
    bindingId: input.binding.bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: connection.authorityEpoch,
      bindingRevision: binding.revision,
      bindingAuthorityEpoch: binding.authorityEpoch,
    },
    source: input.source,
    endpoint: binding.endpoint,
    content: { text: input.content },
    ...(input.replyContext === undefined ? {} : { replyContext: input.replyContext }),
    // The persistent identity deliberately excludes this derived public key.
    deliveryKey: 'channels:delivery:v1:pending',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: binding.linkPreviewPolicy,
  };
  const custodyId = await deriveConversationOutwardDeliveryCustodyId({
    routingIdentityKey: connection.routingIdentityKey,
    obligation: provisional,
  });
  if (custodyId === null) return { kind: 'notAttempted', reason: 'connectionCorrupt' };
  return await deliverConversationOutwardDeliveryThroughProviderAction({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    store: input.store,
    obligation: {
      ...provisional,
      deliveryKey: `channels:delivery:v1:${custodyId}`,
    },
    outboundTextLimit: connection.outboundTextLimit,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
  });
}

/**
 * Reconciles one retained attempt through its owning provider Action. Like
 * redrive, this has no provider-specific recovery path outside the canonical
 * custody state machine; an unavailable optional reconciliation settles as
 * outcome-unknown rather than issuing a second message delivery.
 */
export async function reconcileConversationOutwardDeliveryAttemptThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  recoveryAttemptId: string;
  staleAfterMs: number;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryRecoveryResult> {
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'reconcile',
  });
  return await reconcileConversationOutwardDeliveryAttempt({
    store: input.store,
    record: input.record,
    recoveryAttemptId: input.recoveryAttemptId,
    staleAfterMs: input.staleAfterMs,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    reconcile: async ({ signal }) => {
      const invocation = await boundary.invoke(signal);
      // Recovery follows an earlier attempting send. Even when this optional
      // reconciliation Action cannot start, that prior provider effect remains
      // ambiguous and must not be rewritten as a no-effect suppression.
      return isConversationOutwardDeliveryPreEffectSuppression(invocation)
        ? { kind: 'outcomeUnknown' }
        : invocation;
    },
  });
}

