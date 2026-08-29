import { randomBytes as nodeRandomBytes } from 'node:crypto';

import axios from 'axios';

import {
  AutomationEventActionHttpPathsV1,
  AutomationEventActionHttpRequestSchemasV1,
  AutomationEventActionOutputSchemasV1,
  AutomationEventAdmitHttpRequestV1Schema,
  AutomationEventAdmitHttpResultV1Schema,
  AutomationEventAdmitInputV1Schema,
  AutomationEventAdmitResultV1Schema,
  AutomationEventSourceStatusReportV1Schema,
  AutomationEventSourcesListInputV1Schema,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginMachineMaterializationRefV1Schema,
  type ActionExecutorDeps,
  type AutomationEventActionHttpCallerV1,
  type AutomationEventActionHttpRequestByIdV1,
  type AutomationEventAdmitHttpRequestV1,
  type AutomationEventAdmitItemResultV1,
  type AutomationEventAdmitResultV1,
  type AutomationAccountCurrentnessWitnessV1,
  type AutomationEventActionIdV1,
  type AutomationEventSourceStatusReportV1,
  type AutomationEventSourcesListInputV1,
  type AutomationEventSourcesListTransportV1,
  type PluginMachineMaterializationRefV1,
  type PluginWebhookInvocationReferenceV1,
} from '@happier-dev/protocol';

import { fetchChangesAccountId } from '@/api/changes';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import {
  createPluginActionCallerCurrentnessCheck,
  type RevalidatePluginActionCallerMaterialization,
  type RevalidatePluginActionCallerImmutableGeneration,
} from '@/plugins/runtime/invocation/services/actionCaller';
import {
  admissionKey as automationEventAdmissionSelectorKey,
  type AutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSet';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import {
  invalidateCurrentPluginWebhookAutomationAdmissionResultV1,
  readCurrentPluginWebhookInvocationReferenceV1,
  readCurrentPluginWebhookInvocationSignalV1,
  recordCurrentPluginWebhookAutomationAdmissionResultV1,
} from '../webhooks/pluginWebhookInvocationReference';

type ExecuteAutomationEventAction = NonNullable<ActionExecutorDeps['automationEventAction']>;

const INSTALLED_AUTOMATION_EVENT_ACTION_PRODUCERS_V1: ReadonlySet<AutomationEventActionIdV1> = new Set([
  'automation.event.sources.list',
  'automation.event.admit',
  'automation.event.source.status.report',
]);

/**
 * Resolves the one generation-local adopted set that owns Event definitions
 * for an exact host-stamped caller. The resolver holds no definitions itself.
 */
export type ResolveAutomationEventAdoptedDefinitionSetV1 = (
  caller: PluginMachineMaterializationRefV1,
  immutableGenerationId: string,
  transport: AutomationEventSourcesListTransportV1,
) => AutomationEventAdoptedDefinitionSetV1 | null;

export type AutomationEventActionTransport = Readonly<{
  execute<TActionId extends AutomationEventActionIdV1>(
    actionId: TActionId,
    request: AutomationEventActionHttpRequestByIdV1[TActionId],
    signal?: AbortSignal,
  ): Promise<unknown>;
}>;

function failure(
  errorCode: string,
  error: string = errorCode,
): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error };
}

function readCurrentCatalogStatus(input: AutomationEventSourceStatusReportV1): Readonly<{
  revision: string;
  transport: AutomationEventSourcesListTransportV1;
}> | null {
  if (
    input.kind !== 'catalogReconciliation'
    || input.state !== 'current'
    || input.adoptedRevision !== input.observedRevision
  ) return null;
  return {
    revision: input.observedRevision,
    // The catalog scope kinds are exactly the source-list transports.
    transport: { kind: input.scope.kind },
  };
}

function isSameAutomationEventAdmissionCaller(
  left: AutomationEventActionHttpCallerV1,
  right: AutomationEventActionHttpCallerV1,
): boolean {
  return left.pluginId === right.pluginId
    && left.contributionLocalId === right.contributionLocalId
    && left.immutableGenerationId === right.immutableGenerationId
    && left.materialization.pluginId === right.materialization.pluginId
    && left.materialization.machineId === right.materialization.machineId
    && left.materialization.materializationId === right.materialization.materializationId;
}

function readAdmissionRequestSelectors(
  request: AutomationEventAdmitHttpRequestV1,
): ReadonlyArray<Readonly<{
  automationId: string;
  triggerId: string;
  triggerRevision: number;
  sourceSelectorId: string;
}>> {
  return 'input' in request
    ? request.input.definitions
    : request.hostEvidence.definitions.map((definition) => ({
      automationId: definition.automationId,
      triggerId: definition.triggerId,
      triggerRevision: definition.triggerRevision,
      sourceSelectorId: definition.sourceSelectorId,
    }));
}

function isSameAdmissionSelector(
  left: Readonly<{ automationId: string; triggerId: string; triggerRevision: number; sourceSelectorId: string }>,
  right: Readonly<{ automationId: string; triggerId: string; triggerRevision: number; sourceSelectorId: string }>,
): boolean {
  return left.automationId === right.automationId
    && left.triggerId === right.triggerId
    && left.triggerRevision === right.triggerRevision
    && left.sourceSelectorId === right.sourceSelectorId;
}

function createDefaultTransport(credentials: StoredCredentials): AutomationEventActionTransport {
  return Object.freeze({
    async execute(actionId, request, signal) {
      const path = AutomationEventActionHttpPathsV1[actionId];
      // E2 owns the strict HTTP request boundary. Sign and post the exact
      // normalized object it was given; transports never reconstruct a body
      // from raw Event semantics.
      const body = AutomationEventActionHttpRequestSchemasV1[actionId].parse(request);
      const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
        method: 'POST',
        path,
        body,
      });
      if (!publisherHeader) {
        return failure('automation_event_publisher_proof_unavailable');
      }
      signal?.throwIfAborted();
      const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${credentials.token}`,
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
        ...(signal ? { signal } : {}),
      });
      // Admission alone has a private server continuation that E2 consumes
      // before projecting the public Action result back to the plugin.
      return actionId === 'automation.event.admit'
        ? AutomationEventAdmitHttpResultV1Schema.parse(response.data)
        : AutomationEventActionOutputSchemasV1[actionId].parse(response.data);
    },
  });
}

/**
 * CLI binding for plugin-authored Automation Event Actions. Account, Machine,
 * and installation identity are supplied by authenticated transport; the
 * plugin can neither choose nor override those host-owned facts in Action input.
 */
export function createAutomationEventActionExecutor(params: Readonly<{
  credentials: StoredCredentials;
  transport?: AutomationEventActionTransport;
  revalidateCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  /** Rechecks the exact host-stamped admitted bytes; it never substitutes one. */
  revalidateCallerImmutableGeneration?: RevalidatePluginActionCallerImmutableGeneration;
  resolveAccountId?: (signal?: AbortSignal) => Promise<string>;
  resolveAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  randomBytes?: (length: number) => Uint8Array;
}>): ExecuteAutomationEventAction {
  const transport = params.transport ?? createDefaultTransport(params.credentials);
  const revalidateCallerMaterialization = params.revalidateCallerMaterialization;
  const revalidateCallerImmutableGeneration = params.revalidateCallerImmutableGeneration;
  const resolveAccountId = params.resolveAccountId
    ?? (async (signal?: AbortSignal) => await fetchChangesAccountId({
      token: params.credentials.token,
      ...(signal ? { signal } : {}),
    }));
  const randomBytes = params.randomBytes ?? nodeRandomBytes;

  return async (args) => {
    const admissionFailure = (errorCode: string, error?: string) => {
      if (args.actionId === 'automation.event.admit') {
        invalidateCurrentPluginWebhookAutomationAdmissionResultV1();
      }
      return failure(errorCode, error);
    };
    if (!INSTALLED_AUTOMATION_EVENT_ACTION_PRODUCERS_V1.has(args.actionId)) {
      return failure('unsupported_action', `unsupported_action:${args.actionId}`);
    }
    if (args.caller.kind !== 'plugin') {
      return admissionFailure('automation_event_caller_materialization_unavailable');
    }
    const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
      args.caller.materialization,
    );
    if (!materialization.success || materialization.data.pluginId !== args.caller.pluginId) {
      return admissionFailure('automation_event_caller_materialization_unavailable');
    }
    if (!revalidateCallerMaterialization) {
      return admissionFailure('automation_event_caller_materialization_unavailable');
    }
    const immutableGenerationId = args.caller.immutableGenerationId;
    // Every current Event operation is bound to the exact admitted immutable
    // generation. There is no released unstamped Event SDK contract to retain.
    if (immutableGenerationId === undefined) {
      return admissionFailure('automation_event_caller_generation_unavailable');
    }
    if (!revalidateCallerImmutableGeneration) {
      return admissionFailure('automation_event_caller_generation_unavailable');
    }
    const revalidateCaller = createPluginActionCallerCurrentnessCheck({
      caller: {
        pluginId: args.caller.pluginId,
        immutableGenerationId,
        materialization: materialization.data,
      },
      revalidateMaterialization: revalidateCallerMaterialization,
      ...(revalidateCallerImmutableGeneration
        ? { revalidateImmutableGeneration: revalidateCallerImmutableGeneration }
        : {}),
    });
    const initialCallerCurrentness = await revalidateCaller();
    if (initialCallerCurrentness.kind === 'materializationUnavailable') {
      return admissionFailure('automation_event_caller_materialization_unavailable');
    }
    if (initialCallerCurrentness.kind === 'generationUnavailable') {
      return admissionFailure('automation_event_caller_generation_unavailable');
    }
    const webhookInvocationSignal = args.actionId === 'automation.event.admit'
      ? readCurrentPluginWebhookInvocationSignalV1()
      : null;
    const webhookInvocationReference = args.actionId === 'automation.event.admit'
      ? readCurrentPluginWebhookInvocationReferenceV1()
      : null;
    if (webhookInvocationSignal !== null && webhookInvocationReference === null) {
      return admissionFailure('automation_event_host_evidence_unavailable');
    }
    const signal = args.signal && webhookInvocationSignal
      ? AbortSignal.any([args.signal, webhookInvocationSignal])
      : args.signal ?? webhookInvocationSignal ?? new AbortController().signal;
    const parsedStatusInput = args.actionId === 'automation.event.source.status.report'
      ? AutomationEventSourceStatusReportV1Schema.safeParse(args.input)
      : null;
    const currentCatalogStatus = parsedStatusInput?.success
      ? readCurrentCatalogStatus(parsedStatusInput.data)
      : null;
    let sourceListInput: AutomationEventSourcesListInputV1 | null = null;
    let sourceListWebhookInvocationReference: PluginWebhookInvocationReferenceV1 | null = null;
    if (args.actionId === 'automation.event.sources.list') {
      const parsed = AutomationEventSourcesListInputV1Schema.safeParse(args.input);
      if (!parsed.success) return failure('automation_event_adopted_definitions_unavailable');
      sourceListInput = parsed.data;
      if (sourceListInput.transport.kind === 'durablePush') {
        sourceListWebhookInvocationReference = readCurrentPluginWebhookInvocationReferenceV1();
        // A durable Event producer has no Action-controlled endpoint identity.
        // It can list sources only inside the generic worker's current claimed
        // delivery context, which the host keeps private through this call.
        if (!sourceListWebhookInvocationReference) {
          return failure('automation_event_adopted_definitions_unavailable');
        }
      }
    }
    const adoptedTransport = args.actionId === 'automation.event.sources.list'
      ? sourceListInput?.transport ?? null
      : args.actionId === 'automation.event.admit'
        ? (webhookInvocationReference
          ? { kind: 'durablePush' as const }
          // Watcher-scope admits (checkpointed pull and session socket) carry
          // no caller-selectable transport; the owning adopted set is resolved
          // by deterministic selector membership in the admit branch below.
          : null)
        : currentCatalogStatus?.transport ?? null;
    let adoptedDefinitionSet: AutomationEventAdoptedDefinitionSetV1 | null = null;
    if (adoptedTransport !== null) {
      try {
        adoptedDefinitionSet = params.resolveAdoptedDefinitionSet?.(
          materialization.data,
          immutableGenerationId,
          adoptedTransport,
        ) ?? null;
      } catch {
        adoptedDefinitionSet = null;
      }
      if (!adoptedDefinitionSet) {
        return admissionFailure('automation_event_adopted_definitions_unavailable');
      }
    }

    if (currentCatalogStatus !== null) {
      let projection: ReturnType<AutomationEventAdoptedDefinitionSetV1['readPublicProjection']>;
      try {
        projection = adoptedDefinitionSet?.readPublicProjection() ?? { kind: 'initializing' };
      } catch {
        return failure('automation_event_adopted_definitions_unavailable');
      }
      if (
        projection.kind !== 'available'
        || projection.revision !== currentCatalogStatus.revision
      ) return failure('automation_event_adopted_definitions_unavailable');
    }

    if (args.actionId === 'automation.event.sources.list') {
      if (!adoptedDefinitionSet || !sourceListInput) {
        return failure('automation_event_adopted_definitions_unavailable');
      }
      let accountId: string;
      try {
        accountId = await resolveAccountId(signal);
      } catch {
        return failure('automation_event_adopted_definitions_unavailable');
      }
      let result;
      try {
        result = await adoptedDefinitionSet.listPublicProjection({
          accountId,
          input: sourceListInput,
          ...(sourceListWebhookInvocationReference === null
            ? {}
            : { webhookInvocationReference: sourceListWebhookInvocationReference }),
          signal,
        });
      } catch {
        return failure('automation_event_adopted_definitions_unavailable');
      }
      return result.kind === 'unavailable'
        ? failure('automation_event_adopted_definitions_unavailable')
        : result;
    }

    const caller: AutomationEventActionHttpCallerV1 = {
      pluginId: args.caller.pluginId,
      ...(args.caller.contributionLocalId
        ? { contributionLocalId: args.caller.contributionLocalId }
        : {}),
      immutableGenerationId,
      materialization: materialization.data,
    };
    let admissionInput: ReturnType<typeof AutomationEventAdmitInputV1Schema.safeParse> | null = null;
    let admissionAccountId: string | null = null;
    if (args.actionId === 'automation.event.admit') {
      admissionInput = AutomationEventAdmitInputV1Schema.safeParse(args.input);
      if (!admissionInput.success) return admissionFailure('automation_event_host_evidence_unavailable');
      if (adoptedDefinitionSet === null) {
        // Exactly one watcher-scope generation-local adopted set can contain
        // the requested selectors: a trigger persists exactly one observation
        // transport. Membership in an available projection decides whenever it
        // can; only when no projection can decide does the fixed watcher order
        // fall back to the checkpointed-pull owner, whose prepareAdmission is
        // the exact membership validator either way.
        const selectorKeys = new Set(admissionInput.data.definitions.map(automationEventAdmissionSelectorKey));
        const watcherCandidates: AutomationEventAdoptedDefinitionSetV1[] = [];
        let resolved: AutomationEventAdoptedDefinitionSetV1 | null = null;
        for (const watcherTransport of [
          { kind: 'checkpointedPull' } as const,
          { kind: 'socket' } as const,
        ]) {
          const candidate = params.resolveAdoptedDefinitionSet?.(
            materialization.data,
            immutableGenerationId,
            watcherTransport,
          ) ?? null;
          if (!candidate) continue;
          watcherCandidates.push(candidate);
          let projection: ReturnType<AutomationEventAdoptedDefinitionSetV1['readPublicProjection']>;
          try {
            projection = candidate.readPublicProjection();
          } catch {
            return admissionFailure('automation_event_adopted_definitions_unavailable');
          }
          if (projection.kind !== 'available') continue;
          const definitionKeys = new Set(projection.definitions.map((definition) => automationEventAdmissionSelectorKey({
            automationId: definition.automationId,
            triggerId: definition.triggerId,
            triggerRevision: definition.triggerRevision,
            sourceSelectorId: definition.sourceSelectorId,
          })));
          if (![...selectorKeys].every((key) => definitionKeys.has(key))) continue;
          if (resolved !== null) return admissionFailure('automation_event_host_evidence_unavailable');
          resolved = candidate;
        }
        adoptedDefinitionSet = resolved
          ?? watcherCandidates[0]
          ?? null;
      }
      if (!adoptedDefinitionSet) {
        return admissionFailure('automation_event_host_evidence_unavailable');
      }
      let accountId: string;
      try {
        accountId = await resolveAccountId(signal);
      } catch {
        return admissionFailure('automation_event_host_evidence_unavailable');
      }
      admissionAccountId = accountId;
    }
    try {
      const transportSignal = args.signal || webhookInvocationSignal ? signal : undefined;
      const executeTransport = <TActionId extends AutomationEventActionIdV1>(
        actionId: TActionId,
        request: AutomationEventActionHttpRequestByIdV1[TActionId],
      ): Promise<unknown> => transportSignal === undefined
        ? transport.execute(actionId, request)
        : transport.execute(actionId, request, transportSignal);
      if (args.actionId === 'automation.event.admit') {
        if (!adoptedDefinitionSet || !admissionInput?.success || admissionAccountId === null) {
          return admissionFailure('automation_event_host_evidence_unavailable');
        }
        // A provider may legitimately name the same definition more than once
        // in one admission — the public input schema allows it and a batched
        // observation naturally produces it. Group identical selectors here,
        // admit each distinct one exactly once, and expand its outcome back to
        // every original position. This is the one place that decision is
        // made: downstream preparation and the server's own grouping both see
        // a deduplicated, positionally faithful request.
        const requestedDefinitions = admissionInput.data.definitions;
        const preparedGroupByPosition: number[] = [];
        const preparedDefinitions: typeof requestedDefinitions[number][] = [];
        const preparedGroupIndexByKey = new Map<string, number>();
        for (const selector of requestedDefinitions) {
          const key = automationEventAdmissionSelectorKey(selector);
          let group = preparedGroupIndexByKey.get(key);
          if (group === undefined) {
            group = preparedDefinitions.length;
            preparedGroupIndexByKey.set(key, group);
            preparedDefinitions.push(selector);
          }
          preparedGroupByPosition.push(group);
        }
        const preparedInput = preparedDefinitions.length === requestedDefinitions.length
          ? admissionInput.data
          : { ...admissionInput.data, definitions: preparedDefinitions };
        const mergedResults: AutomationEventAdmitItemResultV1[] = [];
        const appendUnavailableTail = () => {
          mergedResults.push(...Array.from(
            { length: preparedInput.definitions.length - mergedResults.length },
            (): AutomationEventAdmitItemResultV1 => ({
              kind: 'blocked',
              reason: 'temporarilyUnavailable',
              checkpointSafe: false,
            }),
          ));
        };
        let prepared;
        try {
          prepared = await adoptedDefinitionSet.prepareAdmission({
            caller,
            input: preparedInput,
            accountId: admissionAccountId,
            randomBytes,
            signal,
          }) ?? null;
        } catch {
          prepared = null;
        }
        if (prepared === null) {
          return admissionFailure('automation_event_host_evidence_unavailable');
        }

        let successorAccountCurrentness: AutomationAccountCurrentnessWitnessV1 | undefined;
        while (mergedResults.length < preparedInput.definitions.length) {
          if (signal.aborted) {
            appendUnavailableTail();
            break;
          }
          let next;
          try {
            next = await prepared.next(successorAccountCurrentness);
          } catch {
            appendUnavailableTail();
            break;
          }
          if (next.done) {
            appendUnavailableTail();
            break;
          }
          const request = AutomationEventAdmitHttpRequestV1Schema.safeParse(next.value);
          const selectors = request.success ? readAdmissionRequestSelectors(request.data) : null;
          const expectedSelectors = selectors === null
            ? null
            : preparedInput.definitions.slice(
              mergedResults.length,
              mergedResults.length + selectors.length,
            );
          if (
            !request.success
            || !isSameAutomationEventAdmissionCaller(request.data.caller, caller)
            || selectors === null
            || selectors.length === 0
            || expectedSelectors === null
            || selectors.length !== expectedSelectors.length
            || !selectors.every((selector, index) => {
              const expected = expectedSelectors[index];
              return expected !== undefined && isSameAdmissionSelector(selector, expected);
            })
          ) {
            appendUnavailableTail();
            break;
          }
          // Every complete request gets a fresh exact-caller check immediately
          // before transport. A stale caller cannot substitute newer authority.
          const finalCallerCurrentness = await revalidateCaller();
          if (finalCallerCurrentness.kind !== 'current') {
            appendUnavailableTail();
            break;
          }
          if (signal.aborted) {
            appendUnavailableTail();
            break;
          }
          let callResult: ReturnType<typeof AutomationEventAdmitHttpResultV1Schema.safeParse>;
          try {
            callResult = AutomationEventAdmitHttpResultV1Schema.safeParse(
              await executeTransport('automation.event.admit', request.data),
            );
          } catch {
            // Earlier calls are already durable/rejoinable. Preserve their
            // exact outcomes and expose only the current unsent suffix as
            // retryable checkpoint-unsafe results.
            appendUnavailableTail();
            break;
          }
          if (!callResult.success || callResult.data.results.length !== selectors.length) {
            appendUnavailableTail();
            break;
          }
          mergedResults.push(...callResult.data.results);
          if (callResult.data.continuation.kind === 'stopped') {
            appendUnavailableTail();
            break;
          }
          successorAccountCurrentness = callResult.data.continuation.accountCurrentness;
        }
        const orderedResults = preparedGroupByPosition.map((group) => {
          const result = mergedResults[group];
          if (result === undefined) {
            throw new Error('Automation Event admission result mapping is incomplete');
          }
          return result;
        });
        const result: AutomationEventAdmitResultV1 = AutomationEventAdmitResultV1Schema.parse({
          results: orderedResults,
        });
        recordCurrentPluginWebhookAutomationAdmissionResultV1({ input: admissionInput.data, result });
        return result;
      }
      // Recheck after local projection work and immediately before the one
      // non-admission outward server write.
      const finalCallerCurrentness = await revalidateCaller();
      if (finalCallerCurrentness.kind === 'materializationUnavailable') {
        return admissionFailure('automation_event_caller_materialization_unavailable');
      }
      if (finalCallerCurrentness.kind === 'generationUnavailable') {
        return admissionFailure('automation_event_caller_generation_unavailable');
      }
      const request = AutomationEventActionHttpRequestSchemasV1[
        'automation.event.source.status.report'
      ].parse({
        v: 1,
        caller,
        input: parsedStatusInput?.success ? parsedStatusInput.data : args.input,
      });
      const result = await executeTransport('automation.event.source.status.report', request);
      return result;
    } catch (error) {
      if (args.actionId === 'automation.event.admit') {
        invalidateCurrentPluginWebhookAutomationAdmissionResultV1();
      }
      throw error;
    }
  };
}
