import {
    AutomationEventFilterV1Schema,
    AutomationTriggerDefinitionInputSchema,
    arePluginMachineExecutionOriginsEqual,
    PluginMachineExecutionOriginV1Schema,
    PluginWebhookEndpointIdV1Schema,
    type AutomationEventFilterV1,
    type AutomationPluginEventDefinitionTriggerInput,
    type AutomationPluginEventObservationTransportInput,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type PluginEventAutomationSetupResultV1,
    type PluginMachineExecutionOriginV1,
    type PluginWebhookEndpointIdV1,
} from '@happier-dev/protocol';

import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    arePluginContributionIdentitiesEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

import { PLUGIN_EVENT_AUTOMATION_WEBHOOK_ENDPOINT_SETUP_V1 } from './pluginEventAutomationWebhookEndpoint';
import { validatePluginEventAutomationSetupResult } from './pluginEventAutomationSetupResult';

/**
 * The one observation transport this draft was authored for. The pull arm
 * needs nothing beyond the selected origin; the push arm carries only the
 * endpoint identity returned by the canonical webhook endpoint owner, because
 * the endpoint materialization and routing source instance are re-derived
 * from the same origin and setup result the request is built from.
 */
export type PluginEventAutomationObservationDraft =
    | Readonly<{ kind: 'checkpointedPull' }>
    | Readonly<{ kind: 'durablePush'; webhookEndpointId: PluginWebhookEndpointIdV1 }>;

export type PluginEventAutomationAuthoringDraft = Readonly<{
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    expectedEventImmutableGenerationId: string;
    setupActionRef: Readonly<{ pluginId: string; localId: string }>;
    expectedSetupActionImmutableGenerationId: string;
    source: PluginEventAutomationSetupResultV1;
    /**
     * The selected plugin execution origin. It is the checkpointed-pull
     * watcher and, for durable push, the endpoint target materialization —
     * one machine selection, never two competing ones.
     */
    watcherOrigin: PluginMachineExecutionOriginV1;
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
 * Durable push additionally requires the declared webhook contribution, which
 * the Automation writer resolves server-side from this same declaration.
 */
export function supportsPluginEventAutomationObservationTransport(
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    kind: PluginEventAutomationObservationDraft['kind'],
): boolean {
    const source = eligibleEvent.event.automation.source;
    return source.supportedObservationTransports.includes(kind)
        && (kind !== 'durablePush' || source.webhookContributionRef !== undefined);
}

function isExactEligibleEventForDraft(
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    draft: PluginEventAutomationAuthoringDraft,
): boolean {
    const setupActionRef = eligibleEvent.event.automation.source.setupActionRef;
    return supportsPluginEventAutomationObservationTransport(eligibleEvent, draft.observation.kind)
        && arePluginContributionIdentitiesEqual(eligibleEvent.event.identity, draft.eventRef)
        && eligibleEvent.event.immutableGenerationId === draft.expectedEventImmutableGenerationId
        && arePluginContributionIdentitiesEqual(eligibleEvent.setupAction.identity, draft.setupActionRef)
        && eligibleEvent.setupAction.immutableGenerationId === draft.expectedSetupActionImmutableGenerationId
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
    origin: PluginMachineExecutionOriginV1,
): AutomationPluginEventObservationTransportInput {
    return draft.observation.kind === 'checkpointedPull'
        ? { kind: 'checkpointedPull', watcherMaterializationRef: origin.materializationRef }
        : {
            kind: 'durablePush',
            webhookEndpointId: draft.observation.webhookEndpointId,
            endpointMaterializationRef: origin.materializationRef,
            webhookRoutingSourceInstanceId: draft.source.sourceInstanceId,
            setup: PLUGIN_EVENT_AUTOMATION_WEBHOOK_ENDPOINT_SETUP_V1,
        };
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
    const filter = params.filter === null
        ? { success: true as const, data: null }
        : AutomationEventFilterV1Schema.safeParse(params.filter);
    const maximumObservationAgeMs = parseMaximumObservationAgeMs(params.maximumObservationAgeMs);
    if (
        source.kind !== 'available'
        || !watcherOrigin.success
        || watcherOrigin.data.materializationRef.pluginId !== params.eligibleEvent.event.identity.pluginId
        || !filter.success
        || (params.maximumObservationAgeMs !== null && maximumObservationAgeMs === null)
    ) {
        return null;
    }

    return Object.freeze({
        eventRef: Object.freeze({ ...params.eligibleEvent.event.identity }),
        expectedEventImmutableGenerationId: params.eligibleEvent.event.immutableGenerationId,
        setupActionRef: Object.freeze({ ...params.eligibleEvent.setupAction.identity }),
        expectedSetupActionImmutableGenerationId: params.eligibleEvent.setupAction.immutableGenerationId,
        source: source.result,
        watcherOrigin: watcherOrigin.data,
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
}>): AutomationPluginEventDefinitionTriggerInput | null {
    const eligibleEvent = resolveCurrentPluginEventAutomationEligibleEvent({
        eligibleEvents: params.eligibleEvents,
        draft: params.draft,
    });
    const watcherOrigin = PluginMachineExecutionOriginV1Schema.safeParse(params.watcherOrigin);
    if (
        !eligibleEvent
        || !watcherOrigin.success
        || !arePluginMachineExecutionOriginsEqual(params.draft.watcherOrigin, watcherOrigin.data)
        || watcherOrigin.data.materializationRef.pluginId !== eligibleEvent.event.identity.pluginId
    ) {
        return null;
    }
    const trigger = AutomationTriggerDefinitionInputSchema.safeParse({
            kind: 'pluginEvent',
            enabled: true,
            eventRef: eligibleEvent.event.identity,
            sourceInstanceId: params.draft.source.sourceInstanceId,
            sourceContractVersion: params.draft.source.sourceContractVersion,
            sourceConfig: params.draft.source.sourceConfig,
            displayLabel: params.draft.source.displayLabel,
            observationTransport: buildObservationTransportInput(params.draft, watcherOrigin.data),
            filter: params.draft.filter,
            maximumObservationAgeMs: params.draft.maximumObservationAgeMs,
    });
    return trigger.success && trigger.data.kind === 'pluginEvent' ? trigger.data : null;
}
