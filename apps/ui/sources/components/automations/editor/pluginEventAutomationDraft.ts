import {
    AutomationEventFilterV1Schema,
    AutomationRunExecutionRecipeV1Schema,
    AutomationRunExecutionTargetV1Schema,
    AutomationPluginEventDefinitionCreateRequestSchema,
    AutomationPluginEventDefinitionPatchRequestSchema,
    ExecutionRunDetachedStartRequestV1Schema,
    PluginMachineExecutionOriginV1Schema,
    PluginWebhookEndpointIdV1Schema,
    type AcpConfigOptionOverridesV1,
    type AutomationEventFilterV1,
    type AutomationRunExecutionRecipeV1,
    type AutomationRunExecutionTargetV1,
    type AutomationAssignmentInput,
    type AutomationPluginEventDefinitionCreateRequest,
    type AutomationPluginEventDefinitionPatchRequest,
    type AutomationPluginEventObservationTransportInput,
    type BackendTargetRefV2,
    type ConnectedServiceBindingsV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type ExecutionRunDetachedStartRequestV1,
    type MentionRefV1,
    type PluginEventAutomationSetupResultV1,
    type PluginMachineExecutionOriginV1,
    type PluginWebhookEndpointIdV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    arePluginContributionIdentitiesEqual,
    arePluginMachineExecutionOriginsCurrent,
} from '@/components/automations/pluginEventAutomationCurrentness';

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
     * catalog, so setup-captured catalog facts cannot authorize a later V3
     * request.
     */
    resolveFreshWatcherOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
}>;

/**
 * The direct-detail CAS fact supplied by the Event editor. It carries no
 * private trigger content: the incumbent Automation writer re-reads and
 * validates that detail immediately before it issues a V3 patch.
 */
export type PluginEventAutomationEditTarget = Readonly<{
    automationId: string;
    expectedTemplateVersion: number;
}>;

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
 * persisted new-session authoring draft: the incumbent V3 Automation writer
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

/**
 * Creates the only plain-Account Event recipe shape. The canonical target is
 * supplied explicitly so an Event authoring surface cannot silently turn an
 * existing Session or detached execution Run into a new Session spawn. E2EE
 * callers fail closed before reaching this builder.
 */
export function buildPlainPluginEventAutomationExecutionRecipe(params: Readonly<{
    templateVersion: number;
    prompt: string;
    /**
     * The composer references picked beside this prompt, in the same
     * identity-only shape an interactive send persists. The Protocol template
     * owner readmits them against the rendered program at dispatch, so this
     * writer stores exactly what the composer produced.
     */
    mentions?: readonly MentionRefV1[];
    target: AutomationRunExecutionTargetV1;
}>): AutomationRunExecutionRecipeV1 | null {
    const target = AutomationRunExecutionTargetV1Schema.safeParse(params.target);
    if (!target.success) return null;
    const mentions = params.mentions ?? [];
    const recipe = AutomationRunExecutionRecipeV1Schema.safeParse({
        v: 1,
        templateVersion: params.templateVersion,
        template: {
            t: 'plain',
            v: {
                v: 1,
                prompt: params.prompt,
                ...(mentions.length > 0 ? { mentions: [...mentions] } : {}),
            },
        },
        triggerEvidence: null,
        target: target.data,
    });
    return recipe.success ? recipe.data : null;
}

/**
 * Projects the shared New Session backend/model/configuration controls into
 * the strict detached task request retained by an Event definition. Prompt,
 * resume, replay, and bootstrap fields are intentionally absent: the one
 * Automation Run materializer supplies the rendered prompt at dispatch.
 */
export function buildPluginEventAutomationDetachedExecutionRunRequest(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    permissionMode: 'no_tools' | 'read_only';
    modelSelection?: SessionModelSelectionV1 | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    profileId?: string | null;
    profileGenerationId?: string | null;
}>): ExecutionRunDetachedStartRequestV1 | null {
    if (!params.backendTarget) return null;
    const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
    const profileGenerationId = typeof params.profileGenerationId === 'string'
        ? params.profileGenerationId.trim()
        : '';
    const request = ExecutionRunDetachedStartRequestV1Schema.safeParse({
        intent: 'task',
        backendTarget: params.backendTarget,
        permissionMode: params.permissionMode,
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        ...(params.modelSelection?.ref ? { modelSelection: params.modelSelection.ref } : {}),
        ...(params.sessionConfigOptionOverrides ? {
            sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        } : {}),
        ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
        ...(profileId ? { profileId } : {}),
        ...(profileGenerationId ? { profileGenerationId } : {}),
    });
    return request.success ? request.data : null;
}

/**
 * Builds exactly the incumbent strict V3 create body. Caller-provided watcher
 * freshness must have been resolved by the existing Availability/
 * Administration owner immediately before this point.
 */
export function buildPluginEventAutomationDefinitionCreateRequest(params: Readonly<{
    name: string;
    description: string | null;
    enabled: boolean;
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    draft: PluginEventAutomationAuthoringDraft;
    watcherOrigin: PluginMachineExecutionOriginV1;
    executionRecipe: AutomationRunExecutionRecipeV1;
    assignments: readonly AutomationAssignmentInput[];
}>): AutomationPluginEventDefinitionCreateRequest | null {
    const eligibleEvent = resolveCurrentPluginEventAutomationEligibleEvent({
        eligibleEvents: params.eligibleEvents,
        draft: params.draft,
    });
    const watcherOrigin = PluginMachineExecutionOriginV1Schema.safeParse(params.watcherOrigin);
    const executionRecipe = AutomationRunExecutionRecipeV1Schema.safeParse(params.executionRecipe);
    if (
        !eligibleEvent
        || !watcherOrigin.success
        || !arePluginMachineExecutionOriginsCurrent(params.draft.watcherOrigin, watcherOrigin.data)
        || watcherOrigin.data.materializationRef.pluginId !== eligibleEvent.event.identity.pluginId
        || !executionRecipe.success
    ) {
        return null;
    }

    const request = AutomationPluginEventDefinitionCreateRequestSchema.safeParse({
        name: params.name,
        description: params.description,
        enabled: params.enabled,
        trigger: {
            kind: 'pluginEvent',
            eventRef: eligibleEvent.event.identity,
            sourceInstanceId: params.draft.source.sourceInstanceId,
            sourceContractVersion: params.draft.source.sourceContractVersion,
            sourceConfig: params.draft.source.sourceConfig,
            displayLabel: params.draft.source.displayLabel,
            observationTransport: buildObservationTransportInput(params.draft, watcherOrigin.data),
            filter: params.draft.filter,
            maximumObservationAgeMs: params.draft.maximumObservationAgeMs,
        },
        executionRecipe: executionRecipe.data,
        assignments: [...params.assignments],
    });
    return request.success ? request.data : null;
}

/**
 * Full Event replacement requests are only valid at the exact next definition
 * revision. The caller supplies the direct-detail CAS version; the server
 * remains the final compare-and-swap authority.
 */
export function buildPluginEventAutomationDefinitionPatchRequest(params: Readonly<{
    expectedTemplateVersion: number;
    name: string;
    description: string | null;
    enabled: boolean;
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    draft: PluginEventAutomationAuthoringDraft;
    watcherOrigin: PluginMachineExecutionOriginV1;
    executionRecipe: AutomationRunExecutionRecipeV1;
    assignments: readonly AutomationAssignmentInput[];
}>): AutomationPluginEventDefinitionPatchRequest | null {
    if (
        !Number.isSafeInteger(params.expectedTemplateVersion)
        || params.expectedTemplateVersion < 0
    ) {
        return null;
    }
    const nextTemplateVersion = params.expectedTemplateVersion + 1;
    if (
        !Number.isSafeInteger(nextTemplateVersion)
        || params.executionRecipe.templateVersion !== nextTemplateVersion
    ) {
        return null;
    }
    const createRequest = buildPluginEventAutomationDefinitionCreateRequest({
        name: params.name,
        description: params.description,
        enabled: params.enabled,
        eligibleEvents: params.eligibleEvents,
        draft: params.draft,
        watcherOrigin: params.watcherOrigin,
        executionRecipe: params.executionRecipe,
        assignments: params.assignments,
    });
    if (!createRequest) return null;
    const patch = AutomationPluginEventDefinitionPatchRequestSchema.safeParse({
        ...createRequest,
        expectedTemplateVersion: params.expectedTemplateVersion,
    });
    return patch.success ? patch.data : null;
}
