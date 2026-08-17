import {
    AutomationEventFilterV1Schema,
    AutomationRunExecutionRecipeV1Schema,
    AutomationRunExecutionTargetV1Schema,
    AutomationV3PluginEventDefinitionCreateRequestSchema,
    AutomationV3PluginEventDefinitionPatchRequestSchema,
    ExecutionRunDetachedStartRequestV1Schema,
    PluginMachineExecutionOriginV1Schema,
    arePluginMachineExecutionOriginsEqual,
    type AcpConfigOptionOverridesV1,
    type AutomationEventFilterV1,
    type AutomationRunExecutionRecipeV1,
    type AutomationRunExecutionTargetV1,
    type AutomationV3AssignmentInput,
    type AutomationV3PluginEventDefinitionCreateRequest,
    type AutomationV3PluginEventDefinitionPatchRequest,
    type BackendTargetRefV2,
    type ConnectedServiceBindingsV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type ExecutionRunDetachedStartRequestV1,
    type PluginEventAutomationSetupResultV1,
    type PluginMachineExecutionOriginV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

import { validatePluginEventAutomationSetupResult } from './pluginEventAutomationSetupResult';

export type PluginEventAutomationAuthoringDraft = Readonly<{
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    expectedEventImmutableGenerationId: string;
    setupActionRef: Readonly<{ pluginId: string; localId: string }>;
    expectedSetupActionImmutableGenerationId: string;
    source: PluginEventAutomationSetupResultV1;
    watcherOrigin: PluginMachineExecutionOriginV1;
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

function sameContributionIdentity(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameWatcherOrigin(
    left: PluginMachineExecutionOriginV1,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return arePluginMachineExecutionOriginsEqual(left, right);
}

function supportsCheckpointedPull(
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): boolean {
    return eligibleEvent.event.automation.source.supportedObservationTransports.includes('checkpointedPull');
}

function isExactEligibleEventForDraft(
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    draft: PluginEventAutomationAuthoringDraft,
): boolean {
    const setupActionRef = eligibleEvent.event.automation.source.setupActionRef;
    return supportsCheckpointedPull(eligibleEvent)
        && sameContributionIdentity(eligibleEvent.event.identity, draft.eventRef)
        && eligibleEvent.event.immutableGenerationId === draft.expectedEventImmutableGenerationId
        && sameContributionIdentity(eligibleEvent.setupAction.identity, draft.setupActionRef)
        && eligibleEvent.setupAction.immutableGenerationId === draft.expectedSetupActionImmutableGenerationId
        && setupActionRef !== undefined
        && sameContributionIdentity(setupActionRef, eligibleEvent.setupAction.identity)
        && eligibleEvent.setupAction.identity.pluginId === eligibleEvent.event.identity.pluginId
        && validatePluginEventAutomationSetupResult({
            eligibleEvent,
            result: draft.source,
        }).kind === 'available';
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
    filter: AutomationEventFilterV1 | null;
    maximumObservationAgeMs: number | null;
}>): PluginEventAutomationAuthoringDraft | null {
    if (!supportsCheckpointedPull(params.eligibleEvent)) return null;
    const setupActionRef = params.eligibleEvent.event.automation.source.setupActionRef;
    if (
        setupActionRef === undefined
        || !sameContributionIdentity(setupActionRef, params.eligibleEvent.setupAction.identity)
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
    target: AutomationRunExecutionTargetV1;
}>): AutomationRunExecutionRecipeV1 | null {
    const target = AutomationRunExecutionTargetV1Schema.safeParse(params.target);
    if (!target.success) return null;
    const recipe = AutomationRunExecutionRecipeV1Schema.safeParse({
        v: 1,
        templateVersion: params.templateVersion,
        template: {
            t: 'plain',
            v: {
                v: 1,
                prompt: params.prompt,
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
    assignments: readonly AutomationV3AssignmentInput[];
}>): AutomationV3PluginEventDefinitionCreateRequest | null {
    const eligibleEvent = resolveCurrentPluginEventAutomationEligibleEvent({
        eligibleEvents: params.eligibleEvents,
        draft: params.draft,
    });
    const watcherOrigin = PluginMachineExecutionOriginV1Schema.safeParse(params.watcherOrigin);
    const executionRecipe = AutomationRunExecutionRecipeV1Schema.safeParse(params.executionRecipe);
    if (
        !eligibleEvent
        || !watcherOrigin.success
        || !sameWatcherOrigin(params.draft.watcherOrigin, watcherOrigin.data)
        || watcherOrigin.data.materializationRef.pluginId !== eligibleEvent.event.identity.pluginId
        || !executionRecipe.success
    ) {
        return null;
    }

    const request = AutomationV3PluginEventDefinitionCreateRequestSchema.safeParse({
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
            observationTransport: {
                kind: 'checkpointedPull',
                watcherMaterializationRef: watcherOrigin.data.materializationRef,
            },
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
    assignments: readonly AutomationV3AssignmentInput[];
}>): AutomationV3PluginEventDefinitionPatchRequest | null {
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
    const patch = AutomationV3PluginEventDefinitionPatchRequestSchema.safeParse({
        ...createRequest,
        expectedTemplateVersion: params.expectedTemplateVersion,
    });
    return patch.success ? patch.data : null;
}
