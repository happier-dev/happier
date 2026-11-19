import { AutomationEventFilterV1Schema, type AutomationEventFilterV1 } from '@happier-dev/protocol/automations/automationEventFilterV1';
import { AutomationTriggerDefinitionInputSchema, type AutomationPluginEventDefinitionTrigger, type AutomationPluginEventObservationTransportInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { arePluginMachineExecutionOriginsEqual, PluginMachineExecutionOriginV1Schema, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { PluginWebhookEndpointIdV1Schema, resolvePluginWebhookEndpointAuthoringSetupV1, type PluginWebhookEndpointAuthoringSetupV1, type PluginWebhookEndpointIdV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginEventAutomationSetupResultV1 } from '@happier-dev/protocol/automations/event-setup-result';

import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    arePluginContributionIdentitiesEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

import { validatePluginEventAutomationSetupResult } from './pluginEventAutomationSetupResult';
import { resolvePluginEventAutomationObserverMaterialization } from './pluginEventAutomationObservationBinding';

/**
 * The one observation transport this draft was authored for. The pull and
 * socket arms need nothing beyond the selected origin; the push arm carries
 * only the endpoint identity returned by the canonical webhook endpoint
 * owner, because the endpoint materialization and routing source instance
 * are re-derived from the same origin and setup result the request is built
 * from.
 */
export type PluginEventAutomationObservationDraft =
    | Readonly<{ kind: 'checkpointedPull' }>
    | Readonly<{ kind: 'socket' }>
    | Readonly<{ kind: 'durablePush'; webhookEndpointId: PluginWebhookEndpointIdV1 }>;

export type PluginEventAutomationAuthoringDraft = Readonly<{
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    expectedEventOccurrenceId: string;
    setupActionRef: Readonly<{ pluginId: string; localId: string }>;
    expectedSetupActionOccurrenceId: string;
    source: PluginEventAutomationSetupResultV1;
    /**
     * The selected plugin execution origin. It is the checkpointed-pull
     * watcher and, for durable push, the endpoint target materialization —
     * one machine selection, never two competing ones.
     */
    watcherOrigin: PluginMachineExecutionOriginV1;
    observerMaterializationRef: PluginMachineMaterializationRefV1;
    observation: PluginEventAutomationObservationDraft;
    filter: AutomationEventFilterV1 | null;
    maximumObservationAgeMs: number | null;
}>;

/**
 * The transient Event-composer value consumed by the incumbent new-session
 * Automation writer. It deliberately carries a freshness resolver rather
 * than treating the selected watcher materialization as durable/current.
 */
export type PluginEventAutomationCreateDraft = Readonly<{
    draft: PluginEventAutomationAuthoringDraft;
    /**
     * Re-resolves the Availability/Administration-owned execution target at
     * writer time. The writer uses its target to reload the canonical Event
     * catalog, so setup-captured catalog facts cannot authorize a later
     * request.
     */
    resolveFreshWatcherOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
}>;

/**
 * The direct-detail CAS fact supplied by the Event editor. It carries no
 * private trigger content: the incumbent Automation writer re-reads and
 * validates that detail immediately before it issues a strict patch.
 */

/**
 * The declared Event is the only authority on which transports it supports.
 * Durable push also consumes the registry's authorable webhook setup selection;
 * the Automation writer resolves the same declared contribution server-side.
 */
export function supportsPluginEventAutomationObservationTransport(
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    kind: PluginEventAutomationObservationDraft['kind'],
): boolean {
    const source = eligibleEvent.event.automation.source;
    return source.supportedObservationTransports.includes(kind)
        && (kind !== 'durablePush' || (source.webhookContributionRef !== undefined && eligibleEvent.webhookEndpointSetup !== undefined));
}

function isExactEligibleEventForDraft(
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    draft: PluginEventAutomationAuthoringDraft,
): boolean {
    const setupActionRef = eligibleEvent.event.automation.source.setupActionRef;
    return supportsPluginEventAutomationObservationTransport(eligibleEvent, draft.observation.kind)
        && arePluginContributionIdentitiesEqual(eligibleEvent.event.identity, draft.eventRef)
        && eligibleEvent.event.occurrenceId === draft.expectedEventOccurrenceId
        && arePluginContributionIdentitiesEqual(eligibleEvent.setupAction.identity, draft.setupActionRef)
        && eligibleEvent.setupAction.occurrenceId === draft.expectedSetupActionOccurrenceId
        && setupActionRef !== undefined
        && arePluginContributionIdentitiesEqual(setupActionRef, eligibleEvent.setupAction.identity)
        && eligibleEvent.setupAction.identity.pluginId === eligibleEvent.event.identity.pluginId
        && validatePluginEventAutomationSetupResult({
            eligibleEvent,
            result: draft.source,
        }).kind === 'available';
}

function normalizeObservationDraft(
    observation: PluginEventAutomationObservationDraft,
): PluginEventAutomationObservationDraft | null {
    if (observation.kind === 'checkpointedPull') return Object.freeze({ kind: 'checkpointedPull' });
    if (observation.kind === 'socket') return Object.freeze({ kind: 'socket' });
    const webhookEndpointId = PluginWebhookEndpointIdV1Schema.safeParse(observation.webhookEndpointId);
    return webhookEndpointId.success
        ? Object.freeze({ kind: 'durablePush', webhookEndpointId: webhookEndpointId.data })
        : null;
}

/**
 * Projects the authored transport into the strict writer input. Both arms
 * name the same selected origin, and the push arm reuses the setup result's
 * own source instance as the endpoint routing instance, so the request can
 * never disagree with the endpoint the composer ensured.
 */
function buildObservationTransportInput(
    draft: PluginEventAutomationAuthoringDraft,
    materializationRef: PluginMachineMaterializationRefV1,
    webhookEndpointSetup: PluginWebhookEndpointAuthoringSetupV1 | undefined,
): AutomationPluginEventObservationTransportInput | null {
    if (draft.observation.kind === 'checkpointedPull') {
        return { kind: 'checkpointedPull', watcherMaterializationRef: materializationRef };
    }
    if (draft.observation.kind === 'socket') {
        return { kind: 'socket', watcherMaterializationRef: materializationRef };
    }
    const setup = resolvePluginWebhookEndpointAuthoringSetupV1(webhookEndpointSetup, draft.source.sourceInstanceId);
    return setup ? {
        kind: 'durablePush',
        webhookEndpointId: draft.observation.webhookEndpointId,
        endpointMaterializationRef: materializationRef,
        webhookRoutingSourceInstanceId: draft.source.sourceInstanceId,
        setup,
    } : null;
}

function parseMaximumObservationAgeMs(value: unknown): number | null {
    if (value === null) return null;
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : null;
}

/**
 * Captures only transient composer facts. The source result never joins the
 * persisted new-session authoring draft: the incumbent Automation writer
 * is its sole durable consumer.
 */
export function createPluginEventAutomationAuthoringDraft(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    setupResult: unknown;
    watcherOrigin: PluginMachineExecutionOriginV1;
    observation: PluginEventAutomationObservationDraft;
    filter: AutomationEventFilterV1 | null;
    maximumObservationAgeMs: number | null;
}>): PluginEventAutomationAuthoringDraft | null {
    const observation = normalizeObservationDraft(params.observation);
    if (
        !observation
        || !supportsPluginEventAutomationObservationTransport(params.eligibleEvent, observation.kind)
    ) {
        return null;
    }
    const setupActionRef = params.eligibleEvent.event.automation.source.setupActionRef;
    if (
        setupActionRef === undefined
        || !arePluginContributionIdentitiesEqual(setupActionRef, params.eligibleEvent.setupAction.identity)
        || params.eligibleEvent.setupAction.identity.pluginId !== params.eligibleEvent.event.identity.pluginId
    ) {
        return null;
    }
    const source = validatePluginEventAutomationSetupResult({
        eligibleEvent: params.eligibleEvent,
        result: params.setupResult,
    });
    const watcherOrigin = PluginMachineExecutionOriginV1Schema.safeParse(params.watcherOrigin);
    const observerMaterializationRef = watcherOrigin.success
        ? resolvePluginEventAutomationObserverMaterialization(params.eligibleEvent, watcherOrigin.data) : null;
    const filter = params.filter === null
        ? { success: true as const, data: null }
        : AutomationEventFilterV1Schema.safeParse(params.filter);
    const maximumObservationAgeMs = parseMaximumObservationAgeMs(params.maximumObservationAgeMs);
    if (
        source.kind !== 'available'
        || !watcherOrigin.success
        || !observerMaterializationRef
        || !filter.success
        || (params.maximumObservationAgeMs !== null && maximumObservationAgeMs === null)
    ) {
        return null;
    }

    return Object.freeze({
        eventRef: Object.freeze({ ...params.eligibleEvent.event.identity }),
        expectedEventOccurrenceId: params.eligibleEvent.event.occurrenceId,
        setupActionRef: Object.freeze({ ...params.eligibleEvent.setupAction.identity }),
        expectedSetupActionOccurrenceId: params.eligibleEvent.setupAction.occurrenceId,
        source: source.result,
        watcherOrigin: watcherOrigin.data,
        observerMaterializationRef,
        observation,
        filter: filter.data,
        maximumObservationAgeMs,
    });
}

/**
 * Rechecks the cold Event catalog by qualified identity and immutable
 * generations. It never scans the generic Action catalog or looks up a local
 * id independently of the declared Event setup Action.
 */
export function resolveCurrentPluginEventAutomationEligibleEvent(params: Readonly<{
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    draft: PluginEventAutomationAuthoringDraft;
}>): DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null {
    const matches = params.eligibleEvents.filter((candidate) => (
        isExactEligibleEventForDraft(candidate, params.draft)
    ));
    return matches.length === 1 ? matches[0]! : null;
}

/** One strict projection serves the plural editor and definition writers. */
export function buildPluginEventAutomationTriggerInput(params: Readonly<{
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    draft: PluginEventAutomationAuthoringDraft;
    watcherOrigin: PluginMachineExecutionOriginV1;
}>): (AutomationPluginEventDefinitionTrigger & Readonly<{ enabled: boolean }>) | null {
    const eligibleEvent = resolveCurrentPluginEventAutomationEligibleEvent({
        eligibleEvents: params.eligibleEvents,
        draft: params.draft,
    });
    const watcherOrigin = PluginMachineExecutionOriginV1Schema.safeParse(params.watcherOrigin);
    const observerMaterializationRef = eligibleEvent && watcherOrigin.success
        ? resolvePluginEventAutomationObserverMaterialization(eligibleEvent, watcherOrigin.data) : null;
    if (
        !eligibleEvent
        || !watcherOrigin.success
        || !arePluginMachineExecutionOriginsEqual(params.draft.watcherOrigin, watcherOrigin.data)
        || !observerMaterializationRef
        || observerMaterializationRef.machineId !== params.draft.observerMaterializationRef.machineId
        || observerMaterializationRef.pluginId !== params.draft.observerMaterializationRef.pluginId
        || observerMaterializationRef.materializationId !== params.draft.observerMaterializationRef.materializationId
    ) {
        return null;
    }
    const observationTransport = buildObservationTransportInput(params.draft, observerMaterializationRef, eligibleEvent.webhookEndpointSetup);
    if (!observationTransport) return null;
    const trigger = AutomationTriggerDefinitionInputSchema.safeParse({
            kind: 'pluginEvent',
            enabled: true,
            eventRef: eligibleEvent.event.identity,
            sourceInstanceId: params.draft.source.sourceInstanceId,
            sourceContractVersion: params.draft.source.sourceContractVersion,
            sourceConfig: params.draft.source.sourceConfig,
            displayLabel: params.draft.source.displayLabel,
            observationTransport,
            filter: params.draft.filter,
            maximumObservationAgeMs: params.draft.maximumObservationAgeMs,
    });
    return trigger.success && trigger.data.kind === 'pluginEvent' && 'sourceInstanceId' in trigger.data ? trigger.data : null;
}
