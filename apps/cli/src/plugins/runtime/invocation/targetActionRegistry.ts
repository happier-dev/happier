import type { PluginServices } from '@happier-dev/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { readTargetActionDiagnosticConfidentiality } from './diagnostics';
import { runTracedExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';

import { ActionOperationProgressV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import type { ActionEnvironmentApprovalScopeAdmissionV1 } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createPluginActionInvocation, pluginActionRequiresPresentUserIntent, pluginActionDeclarationIsReadOnlyForInput } from '@happier-dev/protocol/plugins/actions/invocation';
import { PluginHostAccessRequestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import type { PluginActionPresentUserGatePolicy, PluginActionInputParser } from '@happier-dev/protocol';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type {
    ActionOperationDeclarationV1,
    MessageActionAvailableSnapshotV1,
    PluginActionAvailabilityV2,
    PluginActionConfirmationV2,
    PluginActionDangerLevelV2,
    PluginMachineMaterializationRefV1,
    PluginSourceCustodyV1,
    TargetActionApprovalReplayPlacementV1,
} from '@happier-dev/protocol';

import {
    PluginError,
    type JsonValue,
    type PluginActionOperationProgressUpdateV1,
    type PluginInvocationCaller,
    type PluginInvocationContext,
    type Disposable,
} from '@happier-dev/plugin-sdk';
import type { PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import { readActionSessionTargetOperands } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import {
    type ActionHandler,
    type PluginActionHandlerInvocation,
} from '@happier-dev/plugin-sdk/actions';
import {
    type PluginInvocationSurface,
} from '@happier-dev/plugin-sdk/interactions';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import {
    createTargetActionExecutor,
    fingerprintTargetActionPolicy,
    projectTargetActionFailure,
    type TargetActionExecutionResult,
    type ResolvedTargetAction,
    type TargetActionCurrentIntentRequest,
    type TargetActionCurrentIntentResult,
} from './actionExecutor';
import type { TargetActionAuthorizationFacts } from '../policy/evaluate';
import type {
    ResolveTargetActionHostBinding,
    TargetActionHostAccessRequest,
} from '../hostAccess/resolve';
import { fingerprintPluginHostAccessRequest } from '../hostAccess/scope';
import type {
    BeginPluginInvocationDiagnosticScope,
    CreatePluginInvocationServices,
    PluginExternalActionContext,
    PluginInvocationServiceBinding,
    ManagedBootstrapCredentialInvocationBinding,
    ManagedNativeCredentialInvocationBinding,
} from './services/types';
import { createPluginInvocationPresentation } from './services/interactions';
import { readReviewedSharedSaveAdmission } from './sharedSaveAdmission';
import type { PluginSharedSaveAdmission } from '../context/secrets';
import {
    createPluginInvocationLifetime,
    type PluginInvocationLifetime,
} from './lifetime';
import {
    resolveInvocationContributionPolicyFacts,
    resolveTargetActionAvailability,
    type ContributionPolicyFacts,
    type TargetActionPolicyDecision,
} from '../policy/evaluate';
import {
    createHostSessionPresentationOwner,
    type HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
    return Array.isArray(value);
}

export type TargetActionDefinition = Readonly<{
    id: string;
    dangerLevel: PluginActionDangerLevelV2;
    readOnly?: import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2['readOnly'];
    approvalScope?: import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2['approvalScope'];
    sessionTarget?: import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2['sessionTarget'];
    scopes: readonly string[];
    surfaces: readonly string[];
    inputSchema?: object;
    secretInputPaths?: readonly string[];
    secretInputLabels?: Readonly<Record<string, string>>;
    resultSchema?: object;
    hostAccessRequests?: readonly TargetActionHostAccessRequest[];
    availability?: PluginActionAvailabilityV2 | null;
    confirmation?: PluginActionConfirmationV2;
    confirmationWhen?: PluginActionPresentUserGatePolicy['confirmationWhen'];
    operation?: ActionOperationDeclarationV1;
}>;

/**
 * Invocation-bound bridge to the daemon's canonical operation runner. The
 * runner owns start and terminal state; this registry can only forward
 * plugin-authored progress while the handler remains unsettled.
 */
export type TargetActionOperationProgressPort = Readonly<{
    update(progress: PluginActionOperationProgressUpdateV1): void;
}>;

export type TargetActionInvocationRegistration = Readonly<{
    family?: string;
    pluginId: string;
    pluginVersion: string;
    /** Process-local target occurrence, projected by the runtime owner. */
    occurrenceId: PluginRuntimeOccurrenceId;
    /** Durable source custody stamped by the runtime owner. */
    sourceCustody?: PluginSourceCustodyV1;
    localId: string;
    definition: TargetActionDefinition;
    inputParser?: PluginActionInputParser;
    resultParser?: PluginActionInputParser;
    handler: ActionHandler<JsonValue, JsonValue | void>;
    observeRead?: PluginActionReadObserver;
}>;

export type TargetActionInvocationResult = TargetActionExecutionResult;

type TargetActionPreDispatchResult = Readonly<{
    status: 'unavailable' | 'invalid';
    code: string;
    message: string;
}>;

type TargetActionConnectedAccountOperationBinding = Readonly<{
    exactPurposeBindingSubjectId: string;
    dispose(): void;
}>;

export type InvokeTargetActionParams = Readonly<{
    /** Host-private sink captured from an admitted Domain's controller and receiver. */
    machineConnectorSecrets?: PluginServices['machineConnectorSecrets'];
    pluginId: string;
    localId: string;
    input: unknown;
    surface: PluginInvocationSurface;
    /** Actual host invocation origin, distinct from the target capability surface. */
    invocationSurface?: PluginInvocationSurface;
    /** Captured at the host ingress independently of its presentation surface. */
    invocationAuthority?: ActionRequiredAuthority;
    /** Host-stamped provenance for a plugin-to-plugin edge. */
    caller?: PluginInvocationCaller;
    initiatingActionCaller?: import('@happier-dev/protocol/actions').ActionCaller;
    startedBy?: import('@happier-dev/protocol').WorkflowRunStartedByV1;
    /** Host-private external API authority; never projected into plugin context. */
    externalActionContext?: PluginExternalActionContext;
    /** Original host-admitted source, distinct from immediate plugin capability identity. */
    approvalContext?: import('@happier-dev/protocol').ActionExecutorContext;
    /**
     * Exact target-occurrence fact from an admitted targeted operation. It is
     * private Action-dispatch evidence, not a caller assertion or SDK input.
     */
    expectedAdmittedTargetOccurrence?: Readonly<{
        pluginId: string;
        occurrenceId: string;
    }>;
    /**
     * Daemon ingress revalidates a mounted caller's live machine context at
     * the last owner-controlled point before the target handler can effect.
     * This is request-scoped evidence, never persisted caller authority.
     */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    /** Untrusted transient settlement from the mounted UI ingress only. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Bounded whole-message disclosure stamped by the ingress host. */
    messageAction?: MessageActionAvailableSnapshotV1;
    sessionId?: string;
    signal?: AbortSignal;
    requiredReadOnly?: true;
    resourceSessionId?: string;
    /** Host-private subscription sink; never authored Action input. */
    readObservation?: Readonly<{ authorityPurpose?: string; invalidate(): void; retire?(): void; accept(subscription: Disposable): void }>;
    facts?: ContributionPolicyFacts;
    requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
    /** Host-stamped durable target for exact API approval replay. */
    replayPlacement?: TargetActionApprovalReplayPlacementV1;
    /** Revalidate a durable approval against current policy before execution. */
    requireCurrentIntent?: true;
    /** Current host Action-settings enablement for this exact qualified target Action. */
    isEnabledByActionSettings?: () => boolean;
    /** Current host Action-settings policy for this exact qualified target Action. */
    isApprovalRequiredByActionSettings?: (manifestDefault: boolean, input?: unknown,
        environmentAdmission?: ActionEnvironmentApprovalScopeAdmissionV1) => boolean;
    resolveEnvironmentApprovalScope?: ActionExecutorDeps['resolveEnvironmentApprovalScope'];
    /** Present only when the daemon operation runner already owns this invocation. */
    operationProgress?: TargetActionOperationProgressPort;
    /** Host-private custody admission; never projected into plugin context. */
    beforeHandlerInvocation?: () => Promise<void>;
    /** Live host-owned managed credential lease, never selected by plugin code. */
    exactPurposeBindingSubjectId?: string;
    /** Host-only streaming observer for an admitted managed native Exec role. */
    execOutputObserver?: (output: import('@happier-dev/plugin-sdk/exec').PluginProcessOutput) => void;
    execInvocationTimeoutMs?: number | null;
    /** Host-private exact admitted row material; never projected into SDK context. */
    managedBootstrapCredential?: ManagedBootstrapCredentialInvocationBinding;
    managedNativeCredentials?: ManagedNativeCredentialInvocationBinding;
    /** Host-private cleanup retention for an issued, custody-admitted managed acquire. */
    retainHandlerResultAfterCancellation?: true;
}>;

export type TargetActionInvocationPreparation = Readonly<
    | { kind: 'settled'; result: TargetActionInvocationResult }
    | {
        kind: 'ready';
        run(options?: Readonly<{
            operationProgress?: TargetActionOperationProgressPort;
        }>): Promise<TargetActionInvocationResult>;
    }
>;

function projectPluginOperationProgress(
    update: PluginActionOperationProgressUpdateV1,
): PluginActionOperationProgressUpdateV1 {
    const hasCurrent = update.current !== undefined;
    const hasTotal = update.total !== undefined;
    const hasPhase = update.phase !== undefined;
    if (hasCurrent || hasTotal) {
        if (!hasCurrent || !hasTotal) {
            throw new TypeError('Determinate operation progress requires current and total');
        }
        const candidate = {
            kind: 'determinate' as const,
            current: update.current,
            total: update.total,
            ...(update.label === undefined ? {} : { label: update.label }),
        };
        const parsed = ActionOperationProgressV1Schema.safeParse(candidate);
        if (!parsed.success || parsed.data.kind !== 'determinate') {
            throw new TypeError('Invalid determinate operation progress');
        }
        return Object.freeze({
            current: parsed.data.current,
            total: parsed.data.total,
            ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
        });
    }
    if (hasPhase) {
        if (update.label === undefined) {
            throw new TypeError('Phase operation progress requires a label');
        }
        const parsed = ActionOperationProgressV1Schema.safeParse({
            kind: 'phase',
            phase: update.phase,
            label: update.label,
        });
        if (!parsed.success || parsed.data.kind !== 'phase') {
            throw new TypeError('Invalid phase operation progress');
        }
        return Object.freeze({ phase: parsed.data.phase, label: parsed.data.label });
    }
    const parsed = ActionOperationProgressV1Schema.safeParse({
        kind: 'indeterminate',
        ...(update.label === undefined ? {} : { label: update.label }),
    });
    if (!parsed.success) throw new TypeError('Invalid indeterminate operation progress');
    return Object.freeze(parsed.data.label === undefined ? {} : { label: parsed.data.label });
}

function actionKey(pluginId: string, localId: string): string {
    return `${pluginId}\u0000${localId}`;
}

function unavailable(code: string, message: string): TargetActionInvocationResult {
    return Object.freeze({
        status: 'unavailable',
        code,
        message,
        actionHandlerInvocation: 'notStarted',
    });
}

export function createTargetActionInvocationRegistry(params: Readonly<{
    actions: readonly TargetActionInvocationRegistration[];
    expectedActions?: readonly Readonly<{ pluginId: string; localId: string }>[];
    readActions?: () => readonly TargetActionInvocationRegistration[];
    resolveEnvironmentApprovalScope?: ActionExecutorDeps['resolveEnvironmentApprovalScope'];
    resolveAuthorizationFacts: (action: ResolvedTargetAction) => TargetActionAuthorizationFacts;
    evaluateCatalogPolicy?: (params: Readonly<{
        pluginId: string;
        localId: string;
    }>) => TargetActionPolicyDecision;
    /**
     * The runtime final-policy owner supplies this read-only projection. The
     * invocation registry only delegates; it does not derive policy facts.
     */
    resolvePresentUserGatePolicy?: (
        pluginId: string,
        localId: string,
    ) => PluginActionPresentUserGatePolicy | null;
    resolveHostBinding: ResolveTargetActionHostBinding;
    createServices: CreatePluginInvocationServices;
    /** Join the host's exact demand before synchronous invocation services are exposed, including warm Actions. */
    prepareInvocationServices?(input: Readonly<{ pluginId: string; localId: string }>): Promise<void>;
    beginDiagnosticScope?: BeginPluginInvocationDiagnosticScope;
    redactDiagnosticText?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
        value: string,
    ) => string;
    completeDiagnosticScope?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
    ) => void;
    /**
     * Host-private current materialization for the exact target invocation.
     * It is the sole source for restamping a plugin-to-plugin caller edge.
     */
    resolveCurrentPluginMaterializationRef?(pluginId: string): PluginMachineMaterializationRefV1 | null;
    /** Canonical process-local occurrence authority for final Action admission. */
    readCurrentPluginOccurrenceId?(pluginId: string): string | null;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
    /**
     * Host-owned Action-form recheck. It runs after canonical
     * input-schema admission and immediately before the target handler.
     */
    revalidateActionFormInput?(input: Readonly<{
        pluginId: string;
        localId: string;
        input: unknown;
        sessionId?: string;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<TargetActionPreDispatchResult | null>;
    /**
     * Host-private binding for this one admitted target-Action correlation.
     * It is deliberately neither a occurrenceId nor a background-service lease.
     */
    bindConnectedAccountActionOperation?(input: Readonly<{
        pluginId: string;
        localId: string;
        input: unknown;
        correlationId: string;
        signal: AbortSignal;
        isCurrent(): boolean;
        recordOperationCredentialUse?: import('@happier-dev/protocol').ActionExecutorContext['recordOperationCredentialUse'];
    }>): Promise<TargetActionConnectedAccountOperationBinding | TargetActionPreDispatchResult | null>;
}>): Readonly<{
    expects(pluginId: string, localId: string): boolean;
    has(pluginId: string, localId: string): boolean;
    evaluateCatalogPolicy(pluginId: string, localId: string): TargetActionPolicyDecision;
    resolvePresentUserGatePolicy?(
        pluginId: string,
        localId: string,
    ): PluginActionPresentUserGatePolicy | null;
    prepare(params: InvokeTargetActionParams): Promise<TargetActionInvocationPreparation>;
    invoke(params: InvokeTargetActionParams): Promise<TargetActionInvocationResult>;
    refresh(): void;
    dispose(): void;
}> {
    const registryController = new AbortController();
    type IndexedAction = Readonly<{
        registration: TargetActionInvocationRegistration;
        invocation: ReturnType<typeof createPluginActionInvocation>;
        /** The exact retirement signal this entry's invocation was prepared against. */
        registrySignal: AbortSignal;
        isCurrent(): boolean;
    }>;

    /**
     * Preparing an invocation compiles the Action's input and result JSON Schemas, which builds a
     * schema compiler and generates a validator for each. When activation publishes new facts,
     * `refresh()` re-indexes every Action, so recompiling an unchanged Action occurrence wastes
     * preparation even when another plugin is the one that changed.
     *
     * `createPluginActionInvocation` reads only the ids, the two schemas and the registry
     * signal. When all of those are the identical values the previous entry was prepared from,
     * a recompilation can only reproduce the validators it already holds.
     */
    function canReusePreparedInvocation(
        previous: IndexedAction,
        registration: TargetActionInvocationRegistration,
        registrySignal: AbortSignal,
    ): boolean {
        return previous.registrySignal === registrySignal
            && previous.registration.pluginId === registration.pluginId
            && previous.registration.localId === registration.localId
            && previous.registration.occurrenceId === registration.occurrenceId
            && previous.registration.definition.inputSchema === registration.definition.inputSchema
            && previous.registration.definition.resultSchema === registration.definition.resultSchema
            && previous.registration.inputParser === registration.inputParser
            && previous.registration.resultParser === registration.resultParser;
    }

    function buildIndex(
        registrations: readonly TargetActionInvocationRegistration[],
        previous: ReadonlyMap<string, IndexedAction> = new Map(),
    ): ReadonlyMap<string, IndexedAction> {
        const next = new Map<string, IndexedAction>();
        for (const registration of registrations) {
            if (registration.family !== undefined && registration.family !== 'actions') {
                throw new Error(`Target invocation registration has wrong family '${registration.family}'`);
            }
            if (registration.localId !== registration.definition.id) {
                throw new Error(`Target action publication id '${registration.localId}' does not match manifest id '${registration.definition.id}'`);
            }
            const key = actionKey(registration.pluginId, registration.localId);
            if (next.has(key)) throw new Error(`Duplicate target action '${registration.pluginId}/actions/${registration.localId}'`);
            const definition: TargetActionDefinition = Object.freeze({
                id: registration.definition.id,
                dangerLevel: registration.definition.dangerLevel,
                ...(registration.definition.approvalScope === undefined ? {} : { approvalScope: registration.definition.approvalScope }),
                ...(registration.definition.readOnly === undefined ? {} : { readOnly: registration.definition.readOnly }),
                ...(registration.definition.sessionTarget === undefined ? {} : { sessionTarget: registration.definition.sessionTarget }),
                scopes: Object.freeze([...registration.definition.scopes]),
                surfaces: Object.freeze([...registration.definition.surfaces]),
                ...(registration.definition.confirmation === undefined
                    ? {}
                    : { confirmation: registration.definition.confirmation }),
                ...(registration.definition.confirmationWhen === undefined
                    ? {}
                    : { confirmationWhen: registration.definition.confirmationWhen }),
                ...(registration.definition.hostAccessRequests === undefined
                    ? {}
                    : {
                        hostAccessRequests: Object.freeze(registration.definition.hostAccessRequests.map((entry) => Object.freeze({
                            request: PluginHostAccessRequestV2Schema.parse(entry.request),
                            required: entry.required,
                        }))),
                    }),
                ...(registration.definition.inputSchema === undefined ? {} : { inputSchema: registration.definition.inputSchema }),
                secretInputPaths: Object.freeze([...(registration.definition.secretInputPaths ?? [])]),
                ...(registration.definition.secretInputLabels === undefined ? {} : {
                    secretInputLabels: Object.freeze({ ...registration.definition.secretInputLabels }),
                }),
                ...(registration.definition.resultSchema === undefined ? {} : { resultSchema: registration.definition.resultSchema }),
                ...(registration.definition.availability === undefined ? {} : { availability: registration.definition.availability }),
                ...(registration.definition.operation === undefined
                    ? {}
                    : { operation: Object.freeze({ ...registration.definition.operation }) }),
            });
            const storedRegistration = Object.freeze({ ...registration, definition });
            const isRegistrationCurrent = () => (
                !registryController.signal.aborted
                && actionsByKey.get(key)?.registration.occurrenceId === registration.occurrenceId
                && (registration.occurrenceId === undefined
                    || params.readCurrentPluginOccurrenceId?.(registration.pluginId) === registration.occurrenceId)
            );
            const registrySignal = registryController.signal;
            const reusable = previous.get(key);
            const invocation = reusable
                && canReusePreparedInvocation(reusable, storedRegistration, registrySignal)
                ? reusable.invocation
                : createPluginActionInvocation({
                    pluginId: registration.pluginId,
                    localId: registration.localId,
                    ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
                    ...(registration.inputParser === undefined ? {} : { inputParser: registration.inputParser }),
                    ...(definition.resultSchema === undefined ? {} : { resultSchema: definition.resultSchema }),
                    ...(registration.resultParser === undefined ? {} : { resultParser: registration.resultParser }),
                    occurrenceSignal: registrySignal,
                    isCurrent: isRegistrationCurrent,
                });
            next.set(key, Object.freeze({
                registration: storedRegistration,
                invocation,
                registrySignal,
                isCurrent: isRegistrationCurrent,
            }));
        }
        return next;
    }

    let actionsByKey = buildIndex(params.actions);
    const expectedActionKeys = new Set([
        ...params.actions.map((registration) => actionKey(registration.pluginId, registration.localId)),
        ...(params.expectedActions ?? []).map((expected) => actionKey(expected.pluginId, expected.localId)),
    ]);

    const isExpectedAdmittedTargetCurrent = async (
        expected: NonNullable<InvokeTargetActionParams['expectedAdmittedTargetOccurrence']>,
        caller: PluginInvocationCaller | undefined,
    ): Promise<boolean> => {
        if (caller?.kind !== 'plugin' || caller.pluginId !== expected.pluginId) {
            return false;
        }
        try {
            return params.readCurrentPluginOccurrenceId?.(expected.pluginId)
                === expected.occurrenceId;
        } catch {
            return false;
        }
    };

    async function invokeHandler(
        indexed: IndexedAction,
        preparedInput: Extract<ReturnType<IndexedAction['invocation']['prepare']>, { kind: 'ready' }>,
        invocation: InvokeTargetActionParams,
        serviceBinding: PluginInvocationServiceBinding,
        correlationId: string,
        lifetime: PluginInvocationLifetime,
        sharedSaveAdmission?: PluginSharedSaveAdmission,
    ): Promise<TargetActionInvocationResult> {
        const { registration } = indexed;
        let actionHandlerInvocation: PluginActionHandlerInvocation | undefined = 'notStarted';
        const operationProgress = registration.definition.operation
            ? invocation.operationProgress
            : undefined;
        let operationSettled = false;
        const invokePrepared = invocation.readObservation ? preparedInput.observe : preparedInput.invoke;
        const result = await invokePrepared({
            ...(invocation.signal ? { signal: invocation.signal } : {}),
            ...(invocation.retainHandlerResultAfterCancellation
                ? { retainHandlerResultAfterCancellation: () => actionHandlerInvocation === undefined }
                : {}),
            ...(params.revalidateActionFormInput
                ? {
                    preDispatch: ({ input, signal }) => (
                        params.revalidateActionFormInput!({
                            pluginId: registration.pluginId,
                            localId: registration.localId,
                            input,
                            ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                            signal,
                            isCurrent: indexed.isCurrent,
                        })
                    ),
                }
                : {}),
            handler: async ({ input, qualifiedId, signal }) => {
                const abortContext = () => {
                    lifetime.settleContext();
                };
                signal.addEventListener('abort', abortContext, { once: true });
                if (signal.aborted) abortContext();
                const currentSession = invocation.sessionId
                    ? params.resolveCurrentSessionUi?.(invocation.sessionId) ?? null
                    : null;
                // Only managed source custody carries the retained immutable
                // package occurrenceId used to qualify Session presentation
                // keys. Live invocation currentness remains occurrence-owned.
                const presentationOwner = invocation.sessionId && registration.sourceCustody?.kind === 'managed'
                    ? createHostSessionPresentationOwner({
                        pluginId: registration.pluginId,
                        contributionId: registration.localId,
                        generationId: registration.sourceCustody.immutableGenerationId,
                        invocationId: correlationId,
                    })
                    : undefined;
                const messageAction = invocation.messageAction
                    ? Object.freeze({ ...invocation.messageAction })
                    : undefined;
                let observedAuthorityRetired = false;
                const retireObservedRead = () => {
                    if (observedAuthorityRetired) return;
                    observedAuthorityRetired = true;
                    if (invocation.readObservation?.retire) invocation.readObservation.retire();
                    else invocation.readObservation?.invalidate();
                };
                const retireReadObservation = () => {
                    if (lifetime.signal.aborted || !indexed.isCurrent()) return;
                    retireObservedRead();
                    lifetime.settleContext();
                };
                const seed = Object.freeze({
                    ...(invocation.machineConnectorSecrets ? { machineConnectorSecrets: invocation.machineConnectorSecrets } : {}),
                    ...(sharedSaveAdmission ? { sharedSaveAdmission } : {}),
                    plugin: Object.freeze({ id: registration.pluginId, version: registration.pluginVersion }),
                    contribution: Object.freeze({ id: registration.localId, qualifiedId }),
                    occurrenceId: registration.occurrenceId,
                    ...(registration.sourceCustody === undefined
                        ? {}
                        : { sourceCustody: registration.sourceCustody }),
                    correlationId,
                    surface: invocation.surface,
                    ...(invocation.caller ? { caller: invocation.caller } : {}),
                    ...(invocation.initiatingActionCaller ? { initiatingActionCaller: invocation.initiatingActionCaller } : {}),
                    ...(invocation.startedBy ? { startedBy: invocation.startedBy } : {}),
                    ...(invocation.externalActionContext
                        ? { externalActionContext: invocation.externalActionContext }
                        : {}),
                    ...(invocation.approvalContext ? { approvalContext: invocation.approvalContext } : {}),
                    ...(invocation.selectedActionInputCarrier
                        ? { selectedActionInputCarrier: invocation.selectedActionInputCarrier }
                        : {}),
                    ...(invocation.isMountedCallerCurrent
                        ? { isMountedCallerCurrent: invocation.isMountedCallerCurrent }
                        : {}),
                    ...(params.resolveCurrentPluginMaterializationRef
                        ? {
                            resolveCurrentPluginMaterializationRef: () => (
                                params.resolveCurrentPluginMaterializationRef!(
                                    registration.pluginId,
                                )
                            ),
                        }
                        : {}),
                    ...(invocation.sessionId ? { session: Object.freeze({ id: invocation.sessionId }) } : {}),
                    ...(messageAction ? { messageAction } : {}),
                    ...(currentSession ? { currentSession } : {}),
                    signal: lifetime.signal,
                    redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                    isOccurrenceCurrent: indexed.isCurrent,
                    retainCleanup: lifetime.retainCleanup,
                    ...(invocation.readObservation ? { retireReadObservation } : {}),
                    ...(invocation.managedBootstrapCredential
                        ? { managedBootstrapCredential: invocation.managedBootstrapCredential }
                        : {}),
                    ...(invocation.managedNativeCredentials
                        ? { managedNativeCredentials: invocation.managedNativeCredentials }
                        : {}),
                });
                let connectedAccountOperationBinding:
                    | TargetActionConnectedAccountOperationBinding
                    | null = null;
                const disposeConnectedAccountOperationBinding = () => {
                    const binding = connectedAccountOperationBinding;
                    connectedAccountOperationBinding = null;
                    binding?.dispose();
                };
                const abortConnectedAccountOperationBinding = () => {
                    disposeConnectedAccountOperationBinding();
                };
                signal.addEventListener(
                    'abort',
                    abortConnectedAccountOperationBinding,
                    { once: true },
                );
                try {
                    await runTracedExternalActionInnerStage('contributed.services.prepare', () =>
                        params.prepareInvocationServices?.({
                            pluginId: registration.pluginId,
                            localId: registration.localId,
                        }), { invocationId: correlationId });
                    if (params.prepareInvocationServices) {
                        if (signal.aborted || lifetime.signal.aborted || !indexed.isCurrent()) {
                            throw new PluginError({
                                code: 'plugin_action_generation_retired',
                                message: 'Plugin action retired during service preparation',
                            });
                        }
                    }
                    // Currentness was admitted in `prepare` and re-checked once
                    // immediately before this handler (the executor `invoke`
                    // callback). Admitted work now runs under its captured
                    // lease; only cancellation stops it.
                    const operationResult = await runTracedExternalActionInnerStage('contributed.connected_account.bind', async () => invocation.exactPurposeBindingSubjectId === undefined
                        ? await params.bindConnectedAccountActionOperation?.({
                        pluginId: registration.pluginId,
                        localId: registration.localId,
                        input,
                        correlationId,
                        ...(seed.approvalContext?.recordOperationCredentialUse
                            ? { recordOperationCredentialUse: seed.approvalContext.recordOperationCredentialUse }
                            : {}),
                        signal: lifetime.signal,
                        isCurrent: () => (
                            !signal.aborted
                            && !lifetime.signal.aborted
                            && indexed.isCurrent()
                        ),
                        })
                        : null, { invocationId: correlationId });
                    if (operationResult && 'status' in operationResult) {
                        throw new PluginError({
                            code: operationResult.code,
                            message: operationResult.message,
                        });
                    }
                    connectedAccountOperationBinding = operationResult ?? null;
                    if (signal.aborted || lifetime.signal.aborted) {
                        throw new PluginError({
                            code: 'plugin_action_generation_retired',
                            message: 'Plugin action operation retired before dispatch',
                        });
                    }
                    const exactPurposeBindingSubjectId = invocation.exactPurposeBindingSubjectId
                        ?? connectedAccountOperationBinding?.exactPurposeBindingSubjectId;
                    const effectiveServiceBinding = exactPurposeBindingSubjectId !== undefined
                        || invocation.execOutputObserver !== undefined || invocation.execInvocationTimeoutMs !== undefined
                        ? Object.freeze({
                            ...serviceBinding,
                            ...(exactPurposeBindingSubjectId === undefined ? {} : { exactPurposeBindingSubjectId }),
                            ...(invocation.execOutputObserver === undefined ? {} : { execOutputObserver: invocation.execOutputObserver }),
                            ...(invocation.execInvocationTimeoutMs === undefined ? {} : { execInvocationTimeoutMs: invocation.execInvocationTimeoutMs }),
                        })
                        : serviceBinding;
                    const services = params.createServices(seed, effectiveServiceBinding);
                    const context: PluginInvocationContext = Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: seed.surface,
                        invokedAtMs: lifetime.invokedAtMs,
                        invocationId: seed.correlationId,
                        ...(seed.caller ? { caller: seed.caller } : {}),
                        ...(seed.session ? { session: seed.session } : {}),
                        ...(seed.messageAction ? { messageAction: seed.messageAction } : {}),
                        ...(registration.definition.operation?.progress === 'reported' && operationProgress
                            ? {
                                operation: Object.freeze({
                                    update: (progress: PluginActionOperationProgressUpdateV1): void => {
                                        if (operationSettled || lifetime.signal.aborted) return;
                                        operationProgress.update(projectPluginOperationProgress(progress));
                                    },
                                }),
                            }
                            : {}),
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession,
                            signal: seed.signal,
                            isOccurrenceCurrent: seed.isOccurrenceCurrent,
                            ...(presentationOwner ? { presentationOwner } : {}),
                        }),
                    });
                    if (invocation.beforeHandlerInvocation) {
                        await invocation.beforeHandlerInvocation();
                        // The custody transition awaits transport. Retirement during that
                        // wait still forbids the plugin effect, even if the server accepted
                        // the transition and must now recover an ambiguous started lease.
                        if (signal.aborted || lifetime.signal.aborted || !indexed.isCurrent()) {
                            throw new PluginError({
                                code: 'plugin_action_generation_retired',
                                message: 'Plugin action retired during custody admission',
                            });
                        }
                    }
                    actionHandlerInvocation = undefined;
                    if (invocation.readObservation) {
                        const observer = registration.observeRead;
                        if (!observer && !invocation.readObservation.authorityPurpose) throw new PluginError({ code: 'plugin_action_read_observation_unavailable', message: 'The read Action has no dependency observer' });
                        const invalidation = Object.freeze(Object.assign(() => {
                            if (!lifetime.signal.aborted && indexed.isCurrent()) invocation.readObservation?.invalidate();
                        }, { retire: retireReadObservation }));
                        const subscription = invocation.readObservation.authorityPurpose
                            ? context.services.connectedAccounts.watch(invocation.readObservation.authorityPurpose, () => {})
                            : await observer!(input, invalidation, context);
                        if (!subscription || typeof subscription.dispose !== 'function') {
                            throw new PluginError({ code: 'plugin_action_read_observation_invalid', message: 'The read Action returned an invalid dependency observer' });
                        }
                        if (lifetime.signal.aborted || !indexed.isCurrent()) {
                            await subscription.dispose();
                            throw new PluginError({ code: 'plugin_action_generation_retired', message: 'Observed Action authority retired during attachment' });
                        }
                        let disposed = false;
                        let cleanup: void | Promise<void>;
                        const onAbort = () => {
                            void Promise.resolve(dispose()).catch(() => {});
                            // A target can retire while its caller Resource remains
                            // demanded. Its authority must be re-read, not silently kept.
                            retireObservedRead();
                        };
                        const dispose = () => {
                            if (disposed) return cleanup;
                            disposed = true;
                            lifetime.signal.removeEventListener('abort', onAbort);
                            try { cleanup = subscription.dispose(); }
                            catch (error) { cleanup = Promise.reject(error); }
                            // Abort cleanup cannot replace the admitted read fact;
                            // the invocation's existing private-cleanup owner retains it.
                            if (cleanup) void cleanup.catch(() => {});
                            return cleanup;
                        };
                        lifetime.retainCleanup({ async dispose() { await dispose(); } });
                        lifetime.signal.addEventListener('abort', onAbort, { once: true });
                        if (lifetime.signal.aborted || !indexed.isCurrent()) dispose();
                        invocation.readObservation.accept(Object.freeze({ dispose }));
                        return null;
                    }
                    return await runTracedExternalActionInnerStage('contributed.handler', () =>
                        registration.handler(input, context), { invocationId: correlationId });
                } finally {
                    signal.removeEventListener(
                        'abort',
                        abortConnectedAccountOperationBinding,
                    );
                    if (invocation.readObservation && !lifetime.signal.aborted) {
                        // Its exact purpose selection belongs to the observed
                        // dependency lifetime, not only observer installation.
                        lifetime.retainCleanup({ async dispose() { disposeConnectedAccountOperationBinding(); } });
                    } else disposeConnectedAccountOperationBinding();
                    signal.removeEventListener('abort', abortContext);
                    if (!invocation.readObservation) lifetime.settleContext();
                }
            },
        });
        operationSettled = true;
        if (result.status === 'executed' || actionHandlerInvocation === undefined) {
            return result;
        }
        return Object.freeze({
            ...result,
            actionHandlerInvocation,
        });
    }

    return Object.freeze({
        expects(pluginId, localId) {
            return expectedActionKeys.has(actionKey(pluginId, localId));
        },
        has(pluginId, localId) {
            return actionsByKey.has(actionKey(pluginId, localId));
        },
        evaluateCatalogPolicy(pluginId, localId) {
            return params.evaluateCatalogPolicy?.({ pluginId, localId }) ?? Object.freeze({
                outcome: 'unavailable',
                code: 'plugin_action_authorization_unavailable',
                requiresCurrentIntent: false,
            });
        },
        ...(params.resolvePresentUserGatePolicy
            ? {
                resolvePresentUserGatePolicy(pluginId: string, localId: string) {
                    return params.resolvePresentUserGatePolicy!(pluginId, localId);
                },
            }
            : {}),
        async prepare(invocation: InvokeTargetActionParams): Promise<TargetActionInvocationPreparation> {
            const key = actionKey(invocation.pluginId, invocation.localId);
            const indexed = actionsByKey.get(key);
            if (!indexed) return Object.freeze({
                kind: 'settled' as const,
                result: unavailable('plugin_action_handler_missing', 'No committed target action registration exists'),
            });
            if (registryController.signal.aborted) {
                return Object.freeze({
                    kind: 'settled' as const,
                    result: unavailable('plugin_action_generation_retired', 'Plugin action occurrence is no longer current'),
                });
            }
            if (!indexed.isCurrent()) return Object.freeze({
                kind: 'settled' as const,
                result: unavailable('plugin_action_generation_retired', 'Plugin action occurrence is no longer current'),
            });
            let operationProgress = invocation.operationProgress;
            let sharedSaveAdmission: PluginSharedSaveAdmission | undefined;
            let correlationId: string = randomUUID();
            const lifetime = createPluginInvocationLifetime(AbortSignal.any([
                registryController.signal,
                ...(invocation.signal ? [invocation.signal] : []),
            ]));
            let diagnosticScope = Object.freeze({
                pluginId: indexed.registration.pluginId,
                occurrenceId: indexed.registration.occurrenceId,
                correlationId,
            });
            const beginDiagnosticScope = (input: JsonValue) => params.beginDiagnosticScope?.(
                diagnosticScope, lifetime.redactionLifetimeSignal, input,
                indexed.registration.definition.secretInputPaths ?? [],
            );
            const complete = async (): Promise<void> => {
                try {
                    params.completeDiagnosticScope?.(diagnosticScope);
                } catch {
                    // Diagnostic lease cleanup cannot replace the action result.
                } finally {
                    await lifetime.complete();
                }
            };
            // Declaration-owned confidential operands must be enrolled before an
            // executable parser can quote rejected raw input in its diagnostics.
            const rawInput = AgentRuntimeJsonValueV1Schema.safeParse(invocation.input);
            // Retain path evidence even when normalization consumes the operand.
            // It belongs to this invocation, independent of approval correlation.
            const rawDiagnosticConfidentiality = rawInput.success
                ? readTargetActionDiagnosticConfidentiality(rawInput.data, indexed.registration.definition.secretInputPaths ?? [])
                : undefined;
            if (rawInput.success) beginDiagnosticScope(rawInput.data);
            // The same normalized value is disclosed, fingerprinted and dispatched.
            // Durable replay must not run a transforming executable parser again.
            const preparedInput = indexed.invocation.prepare(invocation.input, {
                ...(invocation.signal ? { signal: invocation.signal } : {}),
                ...(invocation.requireCurrentIntent === true ? { inputAlreadyNormalized: true as const } : {}),
            });
            if (preparedInput.kind === 'settled') {
                try {
                    return Object.freeze({ kind: 'settled' as const,
                        result: projectTargetActionFailure({ ...preparedInput.result, actionHandlerInvocation: 'notStarted' }, params.redactDiagnosticText
                            ? value => params.redactDiagnosticText!(diagnosticScope, value) : undefined,
                            rawInput.success ? { input: rawInput.data, secretInputPaths: indexed.registration.definition.secretInputPaths ?? [] } : undefined) });
                } finally { await complete(); }
            }
            if (invocation.readObservation && !invocation.readObservation.authorityPurpose && !indexed.registration.observeRead) {
                await complete();
                return Object.freeze({ kind: 'settled' as const, result: {
                    ...unavailable('plugin_action_read_observation_unavailable', 'The read Action has no dependency observer'),
                    actionHandlerInvocation: 'notStarted' as const,
                } });
            }
            if ((invocation.requiredReadOnly || invocation.readObservation)
                && !pluginActionDeclarationIsReadOnlyForInput(indexed.registration.definition, preparedInput.input)) {
                await complete();
                return Object.freeze({ kind: 'settled' as const,
                    result: { ...unavailable('plugin_action_read_only_required', 'This Resource requires an explicitly declared read operand'), actionHandlerInvocation: 'notStarted' as const } });
            }
            if (invocation.resourceSessionId && indexed.registration.definition.sessionTarget
                && preparedInput.input !== null && typeof preparedInput.input === 'object' && !isJsonArray(preparedInput.input)) {
                const operands = readActionSessionTargetOperands(preparedInput.input, indexed.registration.definition.sessionTarget.field);
                if (operands.some(operand => operand.value !== invocation.resourceSessionId)) {
                    await complete();
                    return Object.freeze({ kind: 'settled' as const, result: {
                        ...unavailable('plugin_action_resource_session_mismatch', 'Resource reads retain their exact host-stamped Session'),
                        actionHandlerInvocation: 'notStarted' as const,
                    } });
                }
            }
            if (invocation.readObservation && indexed.registration.definition.sessionTarget
                && preparedInput.input !== null && typeof preparedInput.input === 'object' && !isJsonArray(preparedInput.input)) {
                const operands = readActionSessionTargetOperands(preparedInput.input, indexed.registration.definition.sessionTarget.field);
                if (operands.some(operand => {
                    try { return typeof normalizeSessionTargetV1(operand.value) !== 'string'; }
                    catch { return true; }
                })) {
                    await complete();
                    return Object.freeze({ kind: 'settled' as const, result: {
                        ...unavailable('plugin_action_read_observation_session_unresolved', 'Read observation requires exact host-resolved Session operands'),
                        actionHandlerInvocation: 'notStarted' as const,
                    } });
                }
            }
            beginDiagnosticScope(preparedInput.input);
            let environmentAdmission: ActionEnvironmentApprovalScopeAdmissionV1 | undefined;
            if (indexed.registration.definition.approvalScope === 'environment') {
                const resolveScope = invocation.resolveEnvironmentApprovalScope ?? params.resolveEnvironmentApprovalScope;
                try {
                    const admitted = resolveScope ? await resolveScope({
                        actionId: formatQualifiedPluginActionId({ pluginId: invocation.pluginId, localId: invocation.localId }),
                        input: preparedInput.input,
                        context: { ...invocation.approvalContext, signal: lifetime.signal },
                        phase: invocation.requireCurrentIntent ? 'replay' : 'prepare',
                    }) : { ok: false as const, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
                    if ('errorCode' in admitted) {
                        await complete();
                        return Object.freeze({ kind: 'settled' as const, result: {
                            status: 'failed' as const, code: admitted.errorCode, message: admitted.error,
                            actionHandlerInvocation: 'notStarted' as const,
                        } });
                    }
                    environmentAdmission = admitted;
                } catch {
                    await complete();
                    return Object.freeze({ kind: 'settled' as const, result: {
                        status: 'failed' as const, code: 'deployment_unavailable', message: 'deployment_unavailable',
                        actionHandlerInvocation: 'notStarted' as const,
                    } });
                }
            }
            const resolveCurrentAction = (): ResolvedTargetAction | null => {
                const current = actionsByKey.get(key);
                if (!current) return null;
                const { registration } = current;
                if (!registration.sourceCustody) return null;
                const availability = resolveTargetActionAvailability({
                    availability: registration.definition.availability ?? undefined,
                    facts: resolveInvocationContributionPolicyFacts({
                        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                        facts: invocation.facts,
                    }),
                });
                let approvalRequiredByActionSettings: boolean | undefined;
                try {
                    approvalRequiredByActionSettings = invocation
                        .isApprovalRequiredByActionSettings?.(pluginActionRequiresPresentUserIntent(
                            registration.definition,
                            invocation.invocationSurface ?? invocation.surface,
                            preparedInput.input,
                            invocation.invocationAuthority,
                        ), preparedInput.input, environmentAdmission);
                } catch {
                    // A failed host settings re-read cannot authorize a plugin Action.
                    approvalRequiredByActionSettings = true;
                }
                const action = {
                    qualifiedId: `${registration.pluginId}/actions/${registration.localId}`,
                    pluginId: registration.pluginId, localId: registration.localId,
                    occurrenceId: registration.occurrenceId, dangerLevel: registration.definition.dangerLevel,
                    ...(registration.definition.confirmationWhen === undefined ? {} : { confirmationWhen: registration.definition.confirmationWhen }),
                    sourceCustody: registration.sourceCustody,
                    scopes: registration.definition.scopes, surfaces: registration.definition.surfaces,
                    ...(registration.definition.confirmation === undefined
                        ? {}
                        : { confirmation: registration.definition.confirmation }),
                    ...(approvalRequiredByActionSettings === undefined
                        ? {}
                        : { approvalRequiredByActionSettings }),
                    hostAccess: (registration.definition.hostAccessRequests ?? []).map(({ request, required }) => ({
                        id: request.id,
                        required,
                        status: 'unavailable' as const,
                        code: 'plugin_host_access_context_unavailable',
                        requestFingerprint: fingerprintPluginHostAccessRequest(request),
                    })),
                    ...(availability ? { availability } : {}),
                    input: preparedInput.input,
                    secretInputPaths: registration.definition.secretInputPaths ?? [],
                    ...(registration.definition.secretInputLabels === undefined ? {} : {
                        secretInputLabels: registration.definition.secretInputLabels,
                    }),
                    pluginVersion: registration.pluginVersion,
                    ...(registration.definition.inputSchema === undefined ? {} : { inputSchema: registration.definition.inputSchema }),
                };
                return Object.freeze({ ...action, policyFingerprint: fingerprintTargetActionPolicy(action) });
            };
            const executor = createTargetActionExecutor({
                rawDiagnosticConfidentiality,
                resolve: resolveCurrentAction,
                resolveAuthorizationFacts: params.resolveAuthorizationFacts,
                resolveHostBinding: async (action) => await params.resolveHostBinding(action, {
                    hostAccessRequests: actionsByKey.get(key)?.registration.definition.hostAccessRequests ?? [],
                    surface: invocation.surface,
                    ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                    ...(invocation.signal ? { signal: invocation.signal } : {}),
                }),
                invoke: async (action, args, serviceBinding) => {
                    const current = actionsByKey.get(key);
                    if (!current || !indexed.isCurrent() || current.invocation !== indexed.invocation) {
                        return unavailable('plugin_action_generation_retired', 'Plugin action occurrence is no longer current');
                    }
                    try {
                        if (invocation.isEnabledByActionSettings?.() === false) {
                            return unavailable(
                                'plugin_action_unavailable',
                                'Plugin action is disabled by Action settings',
                            );
                        }
                    } catch {
                        return unavailable(
                            'plugin_action_unavailable',
                            'Plugin action settings are unavailable',
                        );
                    }
                    if (invocation.isMountedCallerCurrent) {
                        let mountedCallerCurrent = false;
                        try {
                            mountedCallerCurrent = await invocation.isMountedCallerCurrent();
                        } catch {
                            // The live machine context is external/currentness
                            // evidence. A failed re-read cannot authorize an
                            // already-mounted caller to reach a target handler.
                        }
                        if (!mountedCallerCurrent) {
                            return unavailable(
                                'plugin_mounted_caller_unavailable',
                                'Mounted plugin caller is no longer current',
                            );
                        }
                    }
                    if (
                        invocation.expectedAdmittedTargetOccurrence
                        && !(await isExpectedAdmittedTargetCurrent(
                            invocation.expectedAdmittedTargetOccurrence,
                            invocation.caller,
                        ))
                    ) {
                        return unavailable(
                            'plugin_action_generation_retired',
                            'Admitted target occurrence is no longer current',
                        );
                    }
                    const recordOperationCredentialUse = args.recordOperationCredentialUse;
                    return await invokeHandler(
                        current,
                        preparedInput,
                        Object.freeze({
                            ...invocation,
                            ...(recordOperationCredentialUse ? { approvalContext: {
                                ...invocation.approvalContext,
                                recordOperationCredentialUse: (use: ActionOperationCredentialUseV1) => {
                                    recordOperationCredentialUse(use);
                                    invocation.approvalContext?.recordOperationCredentialUse?.(use);
                                },
                            } } : {}),
                            ...(operationProgress ? { operationProgress } : {}),
                        }),
                        serviceBinding,
                        correlationId,
                        lifetime,
                        sharedSaveAdmission,
                    );
                },
                ...(params.redactDiagnosticText
                    ? {
                        redactFailureText: (_action, value) => params.redactDiagnosticText!(
                            diagnosticScope,
                            value,
                        ),
                    }
                    : {}),
            });
            const prepared = await executor.prepare({
                    pluginId: invocation.pluginId, localId: invocation.localId, input: preparedInput.input,
                    surface: invocation.surface,
                    ...(invocation.invocationSurface ? { invocationSurface: invocation.invocationSurface } : {}),
                    ...(invocation.invocationAuthority === undefined ? {} : { invocationAuthority: invocation.invocationAuthority }),
                    ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                    signal: lifetime.signal,
                    ...(invocation.replayPlacement ? { replayPlacement: invocation.replayPlacement } : {}),
                    ...(invocation.requireCurrentIntent === true ? { requireCurrentIntent: true as const } : {}),
                    ...(invocation.requestCurrentIntent ? {
                        requestCurrentIntent: async (request: TargetActionCurrentIntentRequest) => {
                            const reviewedSave = readReviewedSharedSaveAdmission(request.action.input, () => {
                                if (lifetime.signal.aborted || !indexed.isCurrent()) {
                                    throw new PluginError({ code: 'plugin_action_generation_retired', message: 'Shared save Action authority retired' });
                                }
                            });
                            const result = await invocation.requestCurrentIntent!(request);
                            sharedSaveAdmission = result.status === 'approved' && result.fingerprint === request.fingerprint
                                ? reviewedSave : undefined;
                            if (result.status === 'approved' && result.fingerprint === request.fingerprint
                                && result.artifactId !== undefined) {
                                // Approval custody, not this preparation attempt, owns replay identity.
                                const previousDiagnosticScope = diagnosticScope;
                                correlationId = result.artifactId;
                                diagnosticScope = Object.freeze({ ...diagnosticScope, correlationId });
                                if (correlationId !== previousDiagnosticScope.correlationId) {
                                    if (rawInput.success) beginDiagnosticScope(rawInput.data);
                                    beginDiagnosticScope(preparedInput.input);
                                    params.completeDiagnosticScope?.(previousDiagnosticScope);
                                }
                            }
                            return result;
                        },
                    } : {}),
            });
            if (prepared.kind === 'settled') {
                await complete();
                return prepared;
            }
            let runPromise: Promise<TargetActionInvocationResult> | null = null;
            return Object.freeze({
                kind: 'ready' as const,
                run(options?: Readonly<{
                    operationProgress?: TargetActionOperationProgressPort;
                }>): Promise<TargetActionInvocationResult> {
                    if (runPromise) return runPromise;
                    operationProgress = options?.operationProgress ?? operationProgress;
                    runPromise = prepared.run().then(async result => {
                        try {
                            if (invocation.readObservation && result.status === 'executed' && !lifetime.signal.aborted) {
                                // A successful observation retains target-owned services until
                                // its Resource demand or the target occurrence retires.
                                lifetime.signal.addEventListener('abort', () => { void complete().catch(() => {}); }, { once: true });
                            } else await complete();
                        } catch (error) {
                            // An issued, validated native fact remains true
                            // when releasing its private local lease fails.
                            if (!invocation.retainHandlerResultAfterCancellation || result.status !== 'executed') throw error;
                            logger.warn('Plugin invocation private cleanup failed', {
                                code: 'plugin_invocation_private_cleanup_failed',
                                pluginId: diagnosticScope.pluginId,
                                occurrenceId: diagnosticScope.occurrenceId,
                                correlationId: diagnosticScope.correlationId,
                            });
                        }
                        return result;
                    }, async error => {
                        await complete();
                        throw error;
                    });
                    return runPromise;
                },
            });
        },
        async invoke(invocation): Promise<TargetActionInvocationResult> {
            const prepared = await (this as Readonly<{
                prepare(input: InvokeTargetActionParams): Promise<TargetActionInvocationPreparation>;
            }>).prepare(invocation);
            return prepared.kind === 'settled'
                ? prepared.result
                : await prepared.run({
                    ...(invocation.operationProgress
                        ? { operationProgress: invocation.operationProgress }
                        : {}),
                });
        },
        refresh() {
            if (registryController.signal.aborted || !params.readActions) return;
            const next = buildIndex(params.readActions(), actionsByKey);
            for (const key of next.keys()) expectedActionKeys.add(key);
            actionsByKey = next;
        },
        dispose() {
            if (!registryController.signal.aborted) {
                registryController.abort(new PluginError({
                    code: 'plugin_action_generation_retired',
                    message: 'Plugin action occurrence retired',
                }));
            }
        },
    });
}
