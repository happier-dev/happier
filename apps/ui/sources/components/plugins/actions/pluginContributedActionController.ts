import {
    DaemonPluginHostPresentedComposerCurrentIntentV1Schema,
    PluginActionPlacementV2Schema,
    PluginActionScopeV2Schema,
    PluginContributionIdentityV1Schema,
    QualifiedConnectedAccountRefSchema,
    buildQualifiedPluginContributionKey,
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    ActionInputHintsSchema,
    type ActionInputHints,
    type DaemonPluginHostPresentedComposerCurrentIntentV1,
    type MessageActionReferenceV1,
    type PluginActionPlacementV2,
    type PluginActionScopeV2,
} from '@happier-dev/protocol';
import {
    PluginUiJsonValueV1Schema,
    type CurrentUiContextSnapshotV1,
    type PluginUiSelectedActionInputForReconstructionV1,
    type PluginUiTargetedContributionOperationV1,
    type PluginUiTargetedContributionsV1,
    type PluginUiSelectActionInputRequestV1,
    type PluginUiSelectActionInputResultV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import {
    dispatchPluginSurfaceAction,
    type DispatchPluginSurfaceActionInput,
    type PluginSurfaceActionDispatchOutcome,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceHostPresentedActionInvocation,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginActionCurrentIntentHandler,
} from '@/components/plugins/surfaces/pluginSurfaceFeedback';
import {
    machinePluginActionFormConnectedAccountOptionsResolve,
    type MachinePluginActionFormConnectedAccountOptionsResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import { DEFAULT_INVOCATION_TIMEOUT_MS } from '@/components/appShell/plugins/pluginUiInvocationHost';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    resolvePluginProjectedActionPresentation,
    type PluginProjectedActionPresentation,
} from '@/sync/domains/plugins/ui/actionPresentation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { getPreferredLanguage } from '@/text';

import {
    createActionInputForm,
    type ActionInputForm,
    type ActionInputFormSubmitOutcome,
} from './actionInputForm';

/**
 * This controller adds only its local action identity around Protocol's
 * selection-free reconstruction input. The Protocol owner reconstructs the
 * selected Connected Account for every realm.
 */
type PluginContributedActionExactSubmittedInputResult = Readonly<{
    kind: 'submitted';
    action: Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>['action'];
}> & PluginUiSelectedActionInputForReconstructionV1;

/**
 * Replaces the one host-authorized dynamic marker with its bounded result.
 * An empty successful result remains distinguishable from an undeclared empty
 * static select, while the renderer stays unable to enumerate or re-resolve.
 */
function projectResolvedConnectedAccountOptions(
    field: ActionInputHints['fields'][number],
    options: NonNullable<ActionInputHints['fields'][number]['options']>,
) {
    const { connectedAccountOptions: _connectedAccountOptions, ...staticField } = field;
    return {
        ...staticField,
        options,
        ...(options.length === 0 ? { resolvedEmptyConnectedAccountOptions: true as const } : {}),
    };
}

/**
 * The host facts a concrete UI placement already owns. `expectedGeneration`
 * must agree with the current projected plugin generation; the caller cannot
 * use this controller to target an arbitrary retained projection.
 */
export type PluginContributedActionHostFacts = Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    expectedGeneration: string | number | null | undefined;
    /** Exact mounted targeted-contribution target; never derived from a contributor. */
    targetPluginId?: string | null;
    sessionId?: string | null;
    messageActionReference?: MessageActionReferenceV1;
    /**
     * The present-user Composer owner supplies one fresh snapshot only at
     * dispatch time. It is an intent witness, never a caller credential or a
     * durable capability.
     */
    currentComposerIntent?: () => DaemonPluginHostPresentedComposerCurrentIntentV1 | null;
    /**
     * The one CurrentUiContextProvider reader, borrowed only when a registered
     * client Action is dispatched. This generic controller never materializes a
     * second context owner or retained snapshot.
     */
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
    signal?: AbortSignal;
    /** Placement-local currentness (route/session/composer/unmount/account). */
    isCurrent?: () => boolean;
    /**
     * Optional placement-owned admission fence for one exact Action. The
     * controller remains the sole descriptor and dispatch owner; a concrete
     * host supplies this only when its selected projection carries stricter
     * per-Action currentness than the raw machine snapshot.
     */
    isActionCurrent?: (identity: Readonly<{ pluginId: string; localId: string }>) => boolean;
    /**
     * Captured Account lifetime for present-user forms. The controller borrows
     * its currentness and retirement only; it never receives Account data.
     */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>;

/** One atomic read of the host route facts and the normalized UI projection. */
export type PluginContributedActionCurrentSnapshot = Readonly<{
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    /**
     * The exact daemon V2 projection that supplied the fallback action map.
     * The Action presentation resolver reads its translation bundle only; it
     * never uses it to derive currentness, availability, or execution.
     */
    pluginUiProjection?: PluginUiProjectionModel | null;
    /**
     * Exact current raw V2 Action descriptor lookup. This controller carries
     * it unchanged to the canonical dispatcher; it never derives a target
     * from the legacy presentation projection or host facts.
     */
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    /**
     * The one cold-admitted contribution snapshot for the mounted target. It is
     * absent outside a target-scoped Host API surface; selection never falls back
     * to the generic projection when this fact is missing.
     */
    targetedContributions?: PluginUiTargetedContributionsV1 | null;
    host: PluginContributedActionHostFacts;
}>;

export type PluginContributedActionSelector = Readonly<{
    placement: PluginActionPlacementV2;
    scope: PluginActionScopeV2;
}>;

/**
 * A current, qualified UI Action. It carries presentation facts only: final
 * input validation and policy remain with the Action/daemon owners.
 */
type PluginContributedActionDescriptorBase = Readonly<{
    identity: Readonly<{ pluginId: string; localId: string }>;
    qualifiedActionId: string;
    title: string;
    description: string | null;
    /** Manifest Action icon slug; renderer boundaries accept only known local icons. */
    icon: string | null;
    /** Lower values appear first within one semantic placement. */
    priority: number;
    placement: PluginActionPlacementV2;
    /** Canonical Action-owned slash presentation, if this Action is picker-admitted. */
    slash: NonNullable<PluginProjectionAction['slash']> | null;
    /** The semantic scope that selected this presentation instance. */
    scope: PluginActionScopeV2;
    scopes: readonly PluginActionScopeV2[];
}>;

export type PluginContributedActionDescriptor =
    | (PluginContributedActionDescriptorBase & Readonly<{
        inputHints: ActionInputHints | null;
        kind: 'direct';
    }>)
    | (PluginContributedActionDescriptorBase & Readonly<{
        inputHints: ActionInputHints;
        kind: 'form';
    }>);

export type PluginContributedActionUnavailableOutcome = Readonly<{
    kind: 'unavailable';
    reason:
        | 'host_unavailable'
        | 'invalid_input'
        | 'submission_in_flight'
        | 'action_not_found'
        | 'action_ambiguous'
        | 'secret_input_unsupported'
        | 'connected_account_ambiguous'
        | 'invalid_draft';
}>;

export type PluginContributedActionStaleOutcome = Readonly<{
    kind: 'stale';
    reason: 'host_retired' | 'action_retired';
}>;

export type PluginContributedActionFormSubmitOutcome = ActionInputFormSubmitOutcome<
    PluginSurfaceActionDispatchOutcome,
    PluginContributedActionUnavailableOutcome['reason'],
    PluginContributedActionStaleOutcome['reason']
>;

/** A direct, already-structured Action invocation uses the same settlement union as forms. */
export type PluginContributedActionInvocationOutcome = PluginContributedActionFormSubmitOutcome;

/**
 * Ephemeral form state for a contributed Action. A consumer must call
 * `retire()` from its unmount/currentness cleanup; the session also clears on
 * cancel, signal abort, and before any terminal dispatch wait.
 */
export type PluginContributedActionForm = ActionInputForm<
    PluginSurfaceActionDispatchOutcome,
    PluginContributedActionUnavailableOutcome['reason'],
    PluginContributedActionStaleOutcome['reason']
> & Readonly<{
    action: PluginContributedActionDescriptor;
}>;

export type PluginContributedActionOpenOutcome =
    | Readonly<{
        kind: 'direct';
        action: PluginContributedActionDescriptor;
        outcome: PluginSurfaceActionDispatchOutcome;
    }>
    | Readonly<{
        kind: 'form';
        action: PluginContributedActionDescriptor;
        form: PluginContributedActionForm;
    }>
    | PluginContributedActionUnavailableOutcome
    | PluginContributedActionStaleOutcome;

type PluginContributedActionSelectionSubmitOutcome = Readonly<{ ok: true }>;

export type PluginContributedActionSelectionForm = ActionInputForm<
    PluginContributedActionSelectionSubmitOutcome,
    PluginContributedActionUnavailableOutcome['reason'],
    PluginContributedActionStaleOutcome['reason']
>;

/**
 * The shared no-invoke form settlement used by exact Action consumers. It
 * deliberately has no target-membership selection: only the Host API adapter
 * that revalidates an admitted target may publish that portable value.
 */
export type PluginContributedActionExactInputSelectionResult =
    | PluginContributedActionExactSubmittedInputResult
    | Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'cancelled' }>>;

type PluginContributedActionExactInputSelectionSettlement =
    | PluginContributedActionExactInputSelectionResult
    | PluginContributedActionUnavailableOutcome
    | PluginContributedActionStaleOutcome;

type PluginContributedActionExactInputSelectionPrimitiveOutcome =
    | Readonly<{
        kind: 'direct';
        result: PluginContributedActionExactInputSelectionResult;
    }>
    | Readonly<{
        kind: 'form';
        form: PluginContributedActionSelectionForm;
        result: Promise<PluginContributedActionExactInputSelectionSettlement>;
    }>
    | PluginContributedActionUnavailableOutcome
    | PluginContributedActionStaleOutcome;

export type PluginContributedActionExactInputSelectionOutcome =
    | Readonly<{
        kind: 'direct';
        result: PluginContributedActionExactInputSelectionResult;
    }>
    | Readonly<{
        kind: 'form';
        form: PluginContributedActionSelectionForm;
        result: Promise<
            PluginContributedActionExactInputSelectionResult
            | PluginContributedActionUnavailableOutcome
        >;
    }>
    | PluginContributedActionUnavailableOutcome;

/**
 * A targeted Host API settlement. The adapter owns the extra portable
 * selection only after it has revalidated the exact target and contributor.
 */
export type PluginContributedActionSelectionOutcome =
    | Readonly<{
        kind: 'direct';
        result: PluginUiSelectActionInputResultV1;
    }>
    | Readonly<{
        kind: 'form';
        form: PluginContributedActionSelectionForm;
        result: Promise<
            PluginUiSelectActionInputResultV1
            | PluginContributedActionUnavailableOutcome
            | PluginContributedActionStaleOutcome
        >;
    }>
    | PluginContributedActionUnavailableOutcome
    | PluginContributedActionStaleOutcome;

/** The canonical dispatcher is a boundary dependency, never a local executor. */
export type PluginContributedActionDispatch = (
    input: DispatchPluginSurfaceActionInput,
) => Promise<PluginSurfaceActionDispatchOutcome>;

export type PluginContributedActionConnectedAccountOptionsTransport = typeof machinePluginActionFormConnectedAccountOptionsResolve;

export type PluginContributedActionController = Readonly<{
    list(selector: PluginContributedActionSelector): readonly PluginContributedActionDescriptor[];
    /** Current session-scoped slash Actions for the incumbent composer picker. */
    listSlashCommands(): readonly PluginContributedActionDescriptor[];
    open(action: PluginContributedActionDescriptor): Promise<PluginContributedActionOpenOutcome>;
    /**
     * Checks a live capability reference embedded in an immutable host
     * presentation. It deliberately does not reinterpret any historical
     * label, placement, or input as a current Action descriptor.
     */
    isReferenceAvailable(action: Readonly<{ pluginId: string; localId: string }>): boolean;
    /**
     * Checks a session-scoped Action reference against the current session
     * Action catalog. Unlike historical transcript references, this requires
     * the action to remain session-scoped before it can become interactive.
     */
    isSessionReferenceAvailable(action: Readonly<{ pluginId: string; localId: string }>): boolean;
    /**
     * Dispatches an immutable, already-structured Action input through the
     * same canonical dispatcher as catalog Action controls. Current Action
     * availability and target identity are rechecked immediately before send.
     */
    invokeReference(
        action: Readonly<{ pluginId: string; localId: string }>,
        input: unknown,
    ): Promise<PluginContributedActionInvocationOutcome>;
    /**
     * Opens one current session-scoped Action reference.
     * Omitted input opens an admitted form or uses the canonical `null`
     * no-input sentinel; explicit input dispatches unchanged.
     */
    openSessionReference(
        action: Readonly<{ pluginId: string; localId: string }>,
        input?: unknown,
    ): Promise<PluginContributedActionOpenOutcome>;
}>;

export type PluginActionInputSelectionController = Readonly<{
    /** Presents one placement-independent plugin-surface Action input without invoking it. */
    selectActionInput(
        request: PluginUiSelectActionInputRequestV1,
    ): Promise<PluginContributedActionSelectionOutcome>;
}>;

/**
 * One exact, current plugin-surface Action input request. Unlike the Host API
 * adapter, this carries no target-contribution membership or caller identity:
 * its caller has already received an admitted qualified Action and immutable
 * generation from its owning catalog.
 */
export type PluginExactBoundActionInputRequest = Readonly<{
    action: Readonly<{ pluginId: string; localId: string }>;
    expectedImmutableGenerationId: string;
    draft?: Readonly<Record<string, unknown>>;
}>;

export type PluginExactBoundActionInputController = Readonly<{
    /** Presents normalized Action input only; it never reaches the dispatcher. */
    selectExactBoundActionInput(
        request: PluginExactBoundActionInputRequest,
    ): Promise<PluginContributedActionExactInputSelectionOutcome>;
}>;

type ResolvedCurrentAction = Readonly<{
    snapshot: PluginContributedActionCurrentSnapshot;
    identity: Readonly<{ pluginId: string; localId: string }>;
}>;

type ResolvedAction = ResolvedCurrentAction & Readonly<{
    descriptor: PluginContributedActionDescriptor;
}>;

type ResolvedFormAction = ResolvedCurrentAction & Readonly<{
    descriptor: Extract<PluginContributedActionDescriptor, Readonly<{ kind: 'form' }>>;
}>;

type ResolveActionResult<TResolved extends ResolvedCurrentAction = ResolvedAction> =
    | Readonly<{ kind: 'resolved'; value: TResolved }>
    | PluginContributedActionUnavailableOutcome
    | PluginContributedActionStaleOutcome;

function isResolvedFormAction(resolved: ResolvedAction): resolved is ResolvedFormAction {
    return resolved.descriptor.kind === 'form';
}

function readRequiredString(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function readExpectedGeneration(value: string | number | null | undefined): string | null {
    const normalized = typeof value === 'number'
        ? (Number.isFinite(value) ? String(value) : null)
        : readRequiredString(value);
    return normalized && normalized !== 'NaN' ? normalized : null;
}

function sameMessageActionReference(
    left: MessageActionReferenceV1 | undefined,
    right: MessageActionReferenceV1 | undefined,
): boolean {
    return left === right || (
        left !== undefined
        && right !== undefined
        && left.v === right.v
        && left.sessionId === right.sessionId
        && left.messageId === right.messageId
        && left.observedRevision === right.observedRevision
    );
}

function actionScopes(action: PluginProjectionAction): readonly PluginActionScopeV2[] {
    return action.scopes.flatMap((scope) => {
        const parsed = PluginActionScopeV2Schema.safeParse(scope);
        return parsed.success ? [parsed.data] : [];
    });
}

function actionPlacementBindings(
    action: PluginProjectionAction,
): readonly PluginActionPlacementV2[] {
    const bindings = Array.isArray(action.placementBindings) ? action.placementBindings : [];
    return bindings.flatMap((binding) => {
        const parsed = PluginActionPlacementV2Schema.safeParse(binding);
        return parsed.success ? [parsed.data] : [];
    });
}

function hasComposerSlashTokens(
    slash: NonNullable<PluginProjectionAction['slash']> | null,
): boolean {
    return slash?.tokens.some((token) => token.startsWith('/') && token.length > 1) === true;
}

function isSemanticComposerActionPlacement(
    placement: PluginActionPlacementV2 | undefined,
): boolean {
    return placement === 'composer.primary'
        || placement === 'composer.more'
        || placement === 'composer.slash';
}

function isSemanticActionPlacement(placement: PluginActionPlacementV2): boolean {
    return isSemanticComposerActionPlacement(placement) || placement === 'message.menu';
}

function sameSlashPresentation(
    left: NonNullable<PluginProjectionAction['slash']> | null,
    right: NonNullable<PluginProjectionAction['slash']> | null,
): boolean {
    if (left === null || right === null) return left === right;
    return left.tokens.length === right.tokens.length
        && left.tokens.every((token, index) => token === right.tokens[index]);
}

function actionPresentationForResolver(
    action: PluginProjectionAction,
): PluginProjectedActionPresentation {
    if (action.localizedPresentation) return action.localizedPresentation;
    return {
        title: action.title,
        ...(action.description === null ? {} : { description: action.description }),
        ...(action.inputHints === null ? {} : { inputHints: action.inputHints }),
    };
}

function descriptorForAction(params: Readonly<{
    pluginId: string;
    action: PluginProjectionAction;
    pluginUiProjection?: PluginUiProjectionModel | null;
    selector: PluginContributedActionSelector;
}>): PluginContributedActionDescriptor | null {
    const identity = PluginContributionIdentityV1Schema.safeParse({
        pluginId: params.pluginId,
        localId: params.action.id,
    });
    if (!identity.success) return null;
    const placementBindings = actionPlacementBindings(params.action);
    const scopes = actionScopes(params.action);
    if (
        params.action.available !== true
        || !params.action.surfaces.includes('ui')
        || !placementBindings.includes(params.selector.placement)
        || !scopes.includes(params.selector.scope)
    ) {
        return null;
    }
    const presentation = resolvePluginProjectedActionPresentation({
        pluginId: params.pluginId,
        presentation: actionPresentationForResolver(params.action),
        projection: params.pluginUiProjection,
        locale: getPreferredLanguage(),
    });
    const base = {
        identity: identity.data,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity.data),
        title: presentation.title,
        description: presentation.description,
        icon: params.action.icon,
        priority: params.action.priority ?? 0,
        placement: params.selector.placement,
        slash: params.action.slash ?? null,
        scope: params.selector.scope,
        scopes,
    };
    const inputHints = presentation.inputHints;
    return inputHints?.fields.length
        ? { ...base, inputHints, kind: 'form' }
        : { ...base, inputHints, kind: 'direct' };
}

function presentationForExactBoundAction(
    action: ExactBoundAction,
) {
    return resolvePluginProjectedActionPresentation({
        pluginId: action.identity.pluginId,
        presentation: actionPresentationForResolver(action.action),
        projection: action.snapshot.pluginUiProjection,
        locale: getPreferredLanguage(),
    });
}

/**
 * The one presentation order for every Action consumer. Metadata does not join
 * currentness identity, so an icon or priority refresh cannot invalidate an
 * already opened Action form.
 */
export function comparePluginContributedActionDescriptors(
    left: PluginContributedActionDescriptor,
    right: PluginContributedActionDescriptor,
): number {
    const priorityDifference = left.priority - right.priority;
    if (priorityDifference !== 0) return priorityDifference;
    return left.qualifiedActionId < right.qualifiedActionId
        ? -1
        : left.qualifiedActionId > right.qualifiedActionId
            ? 1
            : 0;
}

function sameDescriptor(
    left: PluginContributedActionDescriptor,
    right: PluginContributedActionDescriptor,
): boolean {
    return left.identity.pluginId === right.identity.pluginId
        && left.identity.localId === right.identity.localId
        && left.placement === right.placement
        && left.scope === right.scope
        && sameSlashPresentation(left.slash, right.slash);
}

type SelectionTarget = Readonly<{
    snapshot: PluginContributedActionCurrentSnapshot;
    targetedContributions: PluginUiTargetedContributionsV1;
    operation: PluginUiTargetedContributionOperationV1;
    plugin: PluginProjectionEntry;
    action: PluginProjectionAction;
    identity: Readonly<{ pluginId: string; localId: string }>;
}>;

type ExactBoundAction = Readonly<{
    snapshot: PluginContributedActionCurrentSnapshot;
    plugin: PluginProjectionEntry;
    action: PluginProjectionAction;
    identity: Readonly<{ pluginId: string; localId: string }>;
    expectedImmutableGenerationId: string;
}>;

function sameTargetedContributionOperation(
    left: PluginUiTargetedContributionOperationV1,
    right: PluginUiTargetedContributionOperationV1,
): boolean {
    return left.point.pointId === right.point.pointId
        && left.point.protocol.id === right.point.protocol.id
        && left.point.protocol.version === right.point.protocol.version
        && left.contributor.pluginId === right.contributor.pluginId
        && left.contributor.contributionId === right.contributor.contributionId
        && left.contributor.immutableGenerationId === right.contributor.immutableGenerationId
        && left.role === right.role
        && left.action.pluginId === right.action.pluginId
        && left.action.localId === right.action.localId;
}

function sameTargetedContributionTarget(
    left: PluginUiTargetedContributionsV1['target'],
    right: PluginUiTargetedContributionsV1['target'],
): boolean {
    return left.pluginId === right.pluginId
        && left.immutableGenerationId === right.immutableGenerationId;
}

function readPath(input: Readonly<Record<string, unknown>>, path: string): unknown {
    let current: unknown = input;
    for (const segment of path.split('.')) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Readonly<Record<string, unknown>>)[segment];
    }
    return current;
}

function deletePath(input: Readonly<Record<string, unknown>>, path: string): Readonly<Record<string, unknown>> {
    const segments = path.split('.');
    const remove = (value: unknown, index: number): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = value as Readonly<Record<string, unknown>>;
        const segment = segments[index]!;
        const output = { ...record };
        if (index === segments.length - 1) {
            delete output[segment];
        } else if (segment in output) {
            const child = remove(output[segment], index + 1);
            if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
                delete output[segment];
            } else {
                output[segment] = child;
            }
        }
        return output;
    };
    return remove(input, 0) as Readonly<Record<string, unknown>>;
}

function resolveInputSchemaLeaf(
    schema: NonNullable<PluginProjectionAction['inputSchema']>,
    path: string,
): NonNullable<PluginProjectionAction['inputSchema']> | null {
    let current = schema;
    for (const segment of path.split('.')) {
        if (current.type !== 'object') return null;
        const next = current.properties?.[segment];
        if (!next) return null;
        current = next;
    }
    return current;
}

function draftMatchesDeclaredNonSecretFields(params: Readonly<{
    draft: Readonly<Record<string, unknown>>;
    action: PluginProjectionAction;
}>): boolean {
    const schema = params.action.inputSchema;
    const fields = params.action.inputHints?.fields ?? [];
    if (!schema) return Object.keys(params.draft).length === 0;
    if (fields.length === 0) {
        try {
            return isValidPluginJsonSchemaValue(compilePluginJsonSchema(schema), params.draft);
        } catch {
            return false;
        }
    }
    const fieldsByPath = new Map(fields.map((field) => [field.path, field]));

    const visit = (value: unknown, path: string): boolean => {
        const field = fieldsByPath.get(path);
        if (field) {
            if (field.widget === 'secret' || field.connectedAccountOptions === true) return false;
            const leaf = resolveInputSchemaLeaf(schema, path);
            if (!leaf) return false;
            try {
                return isValidPluginJsonSchemaValue(compilePluginJsonSchema(leaf), value);
            } catch {
                return false;
            }
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const entries = Object.entries(value as Readonly<Record<string, unknown>>);
        if (entries.length === 0) return false;
        return entries.every(([key, child]) => visit(child, path ? `${path}.${key}` : key));
    };

    return Object.entries(params.draft).every(([key, value]) => visit(value, key));
}

/**
 * One host-owned action catalog/form/currentness seam. It consumes the
 * normalized projection and delegates all execution to the canonical surface
 * dispatcher, which stamps `executionSurface: 'ui'` and invokes daemon policy.
 */
export function createPluginContributedActionController(params: Readonly<{
    resolveCurrent: () => PluginContributedActionCurrentSnapshot | null;
    dispatch?: PluginContributedActionDispatch;
    resolveConnectedAccountOptions?: PluginContributedActionConnectedAccountOptionsTransport;
}>): PluginContributedActionController
    & PluginActionInputSelectionController
    & PluginExactBoundActionInputController {
    const dispatch = params.dispatch ?? dispatchPluginSurfaceAction;
    const resolveConnectedAccountOptions = params.resolveConnectedAccountOptions
        ?? machinePluginActionFormConnectedAccountOptionsResolve;

    function currentSnapshot(): PluginContributedActionCurrentSnapshot | null {
        try {
            return params.resolveCurrent();
        } catch {
            return null;
        }
    }

    function hostStatus(snapshot: PluginContributedActionCurrentSnapshot):
        | Readonly<{
            kind: 'ready';
            machineId: string | null;
            serverId: string | null;
            expectedGeneration: string;
            accountLifetime: ActiveServerAccountScopeLifetime | null;
        }>
        | PluginContributedActionUnavailableOutcome
        | PluginContributedActionStaleOutcome {
        const machineId = readRequiredString(snapshot.host.machineId);
        const expectedGeneration = readExpectedGeneration(snapshot.host.expectedGeneration);
        if (!expectedGeneration) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        if (
            snapshot.host.signal?.aborted
            || snapshot.host.isCurrent?.() === false
            || snapshot.host.accountLifetime?.isCurrent() === false
        ) {
            return { kind: 'stale', reason: 'host_retired' };
        }
        return {
            kind: 'ready',
            machineId,
            serverId: readRequiredString(snapshot.host.serverId) ?? null,
            expectedGeneration,
            accountLifetime: snapshot.host.accountLifetime ?? null,
        };
    }

    function isActionCurrent(
        snapshot: PluginContributedActionCurrentSnapshot,
        identity: Readonly<{ pluginId: string; localId: string }>,
    ): boolean {
        try {
            return snapshot.host.isActionCurrent?.(identity) !== false;
        } catch {
            return false;
        }
    }

    /**
     * The generic catalog owns placement, while the executable index owns
     * whether a client target has committed. Daemon and legacy descriptors
     * retain their established path; only a declared client Action joins the
     * exact registration reader.
     */
    function hasCurrentClientActionRegistration(
        snapshot: PluginContributedActionCurrentSnapshot,
        identity: Readonly<{ pluginId: string; localId: string }>,
    ): boolean {
        let projectedAction: ReturnType<NonNullable<PluginContributedActionCurrentSnapshot['resolveContributedAction']>>;
        try {
            projectedAction = snapshot.resolveContributedAction?.(identity) ?? null;
        } catch {
            return false;
        }
        if (!projectedAction || projectedAction.execution.target !== 'client') return true;
        const projectionGeneration = Number(readExpectedGeneration(snapshot.host.expectedGeneration));
        return Number.isSafeInteger(projectionGeneration)
            && projectionGeneration >= 0
            && resolvePluginUiClientActionRegistration({
                action: projectedAction,
                projectionGeneration,
                platform: resolvePluginUiClientExecutablePlatform(),
            }) !== null;
    }

    /**
     * A dynamic Account option response belongs to one exact host binding.
     * Matching Action metadata alone cannot move an account reference or an
     * opened form between machines, server scopes, Session/Message targets,
     * generations, or Account lifetimes.
     */
    function hasSameActionFormHostBinding(
        original: PluginContributedActionCurrentSnapshot,
        current: PluginContributedActionCurrentSnapshot,
    ): boolean {
        const originalHost = hostStatus(original);
        const currentHost = hostStatus(current);
        return originalHost.kind === 'ready'
            && currentHost.kind === 'ready'
            && originalHost.machineId === currentHost.machineId
            && originalHost.serverId === currentHost.serverId
            && originalHost.expectedGeneration === currentHost.expectedGeneration
            && originalHost.accountLifetime === currentHost.accountLifetime
            && readRequiredString(original.host.sessionId) === readRequiredString(current.host.sessionId)
            && sameMessageActionReference(
                original.host.messageActionReference,
                current.host.messageActionReference,
            );
    }

    function resolveAction(
        requested: PluginContributedActionDescriptor,
    ): ResolveActionResult {
        const snapshot = currentSnapshot();
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const plugin = snapshot.pluginProjectionById[requested.identity.pluginId];
        if (
            !plugin
            || plugin.pluginId !== requested.identity.pluginId
            || plugin.enabled !== true
            || plugin.generation === null
            || String(plugin.generation) !== host.expectedGeneration
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const action = plugin.actions.find((candidate) => candidate.id === requested.identity.localId);
        if (
            !action
            || !isActionCurrent(snapshot, requested.identity)
            || !hasCurrentClientActionRegistration(snapshot, requested.identity)
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const descriptor = descriptorForAction({
            pluginId: plugin.pluginId,
            action,
            pluginUiProjection: snapshot.pluginUiProjection,
            selector: {
                placement: requested.placement,
                scope: requested.scope,
            },
        });
        if (!descriptor || !sameDescriptor(requested, descriptor)) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        return { kind: 'resolved', value: { snapshot, descriptor, identity: descriptor.identity } };
    }

    function resolveFormAction(
        requested: PluginContributedActionDescriptor,
        originalSnapshot: PluginContributedActionCurrentSnapshot,
    ): ResolveActionResult {
        const current = resolveAction(requested);
        if (current.kind !== 'resolved') return current;
        return hasSameActionFormHostBinding(originalSnapshot, current.value.snapshot)
            ? current
            : { kind: 'stale', reason: 'host_retired' };
    }

    function resolveReference(
        requested: Readonly<{ pluginId: string; localId: string }>,
    ): ResolveActionResult<ResolvedCurrentAction> {
        const identity = PluginContributionIdentityV1Schema.safeParse(requested);
        if (!identity.success) return { kind: 'unavailable', reason: 'invalid_input' };
        const snapshot = currentSnapshot();
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const plugin = snapshot.pluginProjectionById[identity.data.pluginId];
        if (
            !plugin
            || plugin.pluginId !== identity.data.pluginId
            || plugin.enabled !== true
            || plugin.generation === null
            || String(plugin.generation) !== host.expectedGeneration
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const action = plugin.actions.find((candidate) => candidate.id === identity.data.localId);
        // Snapshot placement is immutable presentation, while this narrow
        // current check admits only an actually UI-available target. It never
        // replaces the snapshot's action reference with another declaration.
        if (
            !action
            || !isActionCurrent(snapshot, identity.data)
            || !hasCurrentClientActionRegistration(snapshot, identity.data)
            || action.available !== true
            || !action.surfaces.includes('ui')
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        return { kind: 'resolved', value: { snapshot, identity: identity.data } };
    }

    function resolveSessionReference(
        requested: Readonly<{ pluginId: string; localId: string }>,
    ): ResolveActionResult<ResolvedAction> {
        const reference = resolveReference(requested);
        if (reference.kind !== 'resolved') return reference;
        const plugin = reference.value.snapshot.pluginProjectionById[reference.value.identity.pluginId];
        const action = plugin?.actions.find((candidate) => candidate.id === reference.value.identity.localId);
        // A session-scoped Action control uses a non-semantic placement, not
        // a second Composer/Message presentation. Semantic declarations keep
        // their explicit consumer ownership even when an Action also appears
        // in a non-semantic session-scoped control.
        const placement = action?.placementBindings
            ? actionPlacementBindings(action).find((candidate) => !isSemanticActionPlacement(candidate))
            : undefined;
        if (!plugin || !action || !placement) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const descriptor = descriptorForAction({
            pluginId: plugin.pluginId,
            action,
            pluginUiProjection: reference.value.snapshot.pluginUiProjection,
            // Retain only the first non-semantic placement to reuse the
            // descriptor, form, and currentness owner. A semantic
            // Composer/Message binding must never acquire this generic
            // session-scoped control path.
            selector: { placement, scope: 'session' },
        });
        if (!descriptor) return { kind: 'stale', reason: 'action_retired' };
        return {
            kind: 'resolved',
            value: { ...reference.value, descriptor },
        };
    }

    /**
     * A host-presented Message intent is reserved for an Action with no legacy
     * presentation route. This predicate is shared by persisted references and
     * direct menu descriptors so a consumer cannot turn a mixed declaration
     * into a second daemon-admission path.
     */
    function isSemanticOnlyMessageMenuAction(resolved: ResolvedCurrentAction): boolean {
        const plugin = resolved.snapshot.pluginProjectionById[resolved.identity.pluginId];
        const action = plugin?.actions.find((candidate) => candidate.id === resolved.identity.localId);
        if (!action) return false;
        const placements = actionPlacementBindings(action);
        return placements.includes('message.menu')
            && !placements.some((placement) => !isSemanticActionPlacement(placement));
    }

    /**
     * Reference-only transcript actions retain their legacy route whenever an
     * Action declares one. A host-presented Message arm is reserved for an
     * explicit semantic-only `message.menu` declaration; otherwise a persisted
     * historical action would silently change daemon admission semantics.
     */
    function resolveMessageReferenceInvocationPlacement(
        resolved: ResolvedCurrentAction,
    ): PluginActionPlacementV2 | undefined {
        return isSemanticOnlyMessageMenuAction(resolved) ? 'message.menu' : undefined;
    }

    function resolveHostInvocation(params: Readonly<{
        resolved: ResolvedCurrentAction;
        placement?: PluginActionPlacementV2;
    }>):
        | Readonly<{ kind: 'resolved'; invocation?: PluginSurfaceHostPresentedActionInvocation }>
        | PluginContributedActionUnavailableOutcome
        | PluginContributedActionStaleOutcome {
        const snapshot = params.resolved.snapshot;
        const readCurrentComposerIntent = snapshot.host.currentComposerIntent;
        const messageActionReference = snapshot.host.messageActionReference;
        if (isSemanticComposerActionPlacement(params.placement)) {
            // The exact Composer placement, rather than incidental facts shared
            // by a Session host, decides whether a Composer intent is usable.
            // A detached or retired Composer control has no dispatch fallback.
            // A Composer control also cannot carry a persisted Message intent:
            // the strict daemon request treats that as an invalid mixed carrier.
            if (messageActionReference) {
                return { kind: 'unavailable', reason: 'host_unavailable' };
            }
            if (!readCurrentComposerIntent) return { kind: 'stale', reason: 'host_retired' };
            let intent: unknown;
            try {
                intent = readCurrentComposerIntent();
            } catch {
                intent = null;
            }
            const parsedIntent = DaemonPluginHostPresentedComposerCurrentIntentV1Schema.safeParse(intent);
            if (!parsedIntent.success) return { kind: 'stale', reason: 'host_retired' };
            return {
                kind: 'resolved',
                invocation: {
                    kind: 'hostPresentedComposer',
                    currentComposerIntent: parsedIntent.data,
                },
            };
        }
        if (params.placement === 'message.menu') {
            // Likewise, only the explicit message-menu projection can consume
            // the row's opaque current Message reference. Legacy presentation
            // routes retain their established no-arm compatibility behavior.
            if (!isSemanticOnlyMessageMenuAction(params.resolved)) return { kind: 'resolved' };
            if (!messageActionReference) return { kind: 'stale', reason: 'host_retired' };
            return {
                kind: 'resolved',
                invocation: {
                    kind: 'hostPresentedMessage',
                    currentMessageIntent: messageActionReference,
                },
            };
        }
        return { kind: 'resolved' };
    }

    async function dispatchResolvedAction(
        resolved: ResolvedCurrentAction,
        input: unknown,
        isCurrent: () => boolean,
        signal?: AbortSignal,
        placement?: PluginActionPlacementV2,
    ): Promise<PluginContributedActionInvocationOutcome> {
        const host = hostStatus(resolved.snapshot);
        if (host.kind !== 'ready') return host;
        const projectedAction = resolved.snapshot.resolveContributedAction?.(resolved.identity) ?? null;
        if (!projectedAction) return { kind: 'unavailable', reason: 'host_unavailable' };
        const executionTarget = projectedAction.execution.target;
        const projectionGeneration = Number(host.expectedGeneration);
        if (
            executionTarget === 'client'
            && (!Number.isSafeInteger(projectionGeneration) || projectionGeneration < 0)
        ) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        if (executionTarget === 'daemon' && !host.machineId) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        const transportInput = PluginUiJsonValueV1Schema.safeParse(input);
        if (!transportInput.success) {
            // This is only the JSON transport boundary. The Action schema still
            // performs final field validation at canonical dispatch.
            return { kind: 'unavailable', reason: 'invalid_input' };
        }
        const invocation = resolveHostInvocation({ resolved, placement });
        if (invocation.kind !== 'resolved') return invocation;
        const dispatchSignal = signal ?? resolved.snapshot.host.signal;
        const requestCurrentIntent = executionTarget === 'client' && projectedAction
            ? createPluginActionCurrentIntentHandler({
                requester: {
                    pluginId: resolved.identity.pluginId,
                    contributionId: resolved.identity.localId,
                    generationId: host.expectedGeneration,
                    invocationId: `ui-action:${host.expectedGeneration}`,
                },
                signal: dispatchSignal ?? new AbortController().signal,
                isCurrent,
            })
            : undefined;
        try {
            const outcome = await dispatch({
                // Catalog, Composer, and transcript host presentation never
                // fabricate a mounted plugin caller. The canonical dispatcher
                // receives only the current host intent carrier, if required.
                action: resolved.identity,
                input: transportInput.data,
                ...(resolved.snapshot.resolveContributedAction
                    ? { resolveContributedAction: resolved.snapshot.resolveContributedAction }
                    : {}),
                ...(executionTarget === 'client'
                    ? {
                        clientAction: {
                            projectionGeneration,
                            ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
                            ...(resolved.snapshot.host.readCurrentUiContext
                                ? { currentUiContext: resolved.snapshot.host.readCurrentUiContext }
                                : {}),
                            ...(readRequiredString(resolved.snapshot.host.sessionId)
                                ? { sessionId: readRequiredString(resolved.snapshot.host.sessionId)! }
                                : {}),
                        },
                    }
                    : {
                        contributedAction: {
                            machineId: host.machineId!,
                            serverId: readRequiredString(resolved.snapshot.host.serverId) ?? null,
                            expectedGeneration: host.expectedGeneration,
                            ...(readRequiredString(resolved.snapshot.host.sessionId)
                                ? { sessionId: readRequiredString(resolved.snapshot.host.sessionId)! }
                                : {}),
                            ...(invocation.invocation?.kind !== 'hostPresentedComposer'
                                && resolved.snapshot.host.messageActionReference
                                ? { messageActionReference: resolved.snapshot.host.messageActionReference }
                                : {}),
                        },
                    }),
                ...(invocation.invocation ? { invocation: invocation.invocation } : {}),
                ...(dispatchSignal ? { signal: dispatchSignal } : {}),
                isCurrent,
            });
            return { kind: 'settled', outcome };
        } catch {
            return {
                kind: 'settled',
                outcome: {
                    ok: false,
                    code: 'unavailable',
                    reason: 'plugin_contributed_action_dispatch_failed',
                },
            };
        }
    }

    function createForm(
        resolved: ResolvedAction,
        inputHints: ActionInputHints,
    ): PluginContributedActionForm {
        const form = createActionInputForm<
            PluginSurfaceActionDispatchOutcome,
            PluginContributedActionUnavailableOutcome['reason'],
            PluginContributedActionStaleOutcome['reason']
        >({
            presentation: {
                title: resolved.descriptor.title,
                description: resolved.descriptor.description,
                inputHints,
            },
            accountLifetime: resolved.snapshot.host.accountLifetime,
            deadlineMs: DEFAULT_INVOCATION_TIMEOUT_MS,
            ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
            isCurrent: () => resolveFormAction(
                resolved.descriptor,
                resolved.snapshot,
            ).kind === 'resolved',
            submissionInFlightReason: 'submission_in_flight',
            retiredReason: 'action_retired',
            submit: async (candidate, context) => {
                if (context.signal.aborted) {
                    return { kind: 'stale', reason: 'action_retired' };
                }
                const current = resolveFormAction(resolved.descriptor, resolved.snapshot);
                if (current.kind !== 'resolved') return current;
                const outcome = await dispatchResolvedAction(
                    current.value,
                    candidate,
                    () => resolveFormAction(
                        resolved.descriptor,
                        resolved.snapshot,
                    ).kind === 'resolved',
                    context.signal,
                    current.value.descriptor.placement,
                );
                // Dispatch owns settlement ordering. A presentation signal can
                // prevent admission before dispatch, but cannot relabel a
                // fulfilled canonical result observed afterward.
                return outcome;
            },
        });
        return { ...form, action: resolved.descriptor };
    }

    async function resolveFormConnectedAccountOptions(
        resolved: ResolvedFormAction,
    ): Promise<ActionInputHints | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome> {
        const dynamicFields = resolved.descriptor.inputHints.fields.filter((field) => (
            field.connectedAccountOptions === true
        ));
        if (dynamicFields.length === 0) return resolved.descriptor.inputHints;
        const host = hostStatus(resolved.snapshot);
        if (host.kind !== 'ready') return host;
        if (!host.machineId) return { kind: 'unavailable', reason: 'host_unavailable' };
        const optionsByPath = new Map<string, ActionInputHints['fields'][number]['options']>();
        for (const field of dynamicFields) {
            const result: MachinePluginActionFormConnectedAccountOptionsResult = await resolveConnectedAccountOptions(
                host.machineId,
                {
                    serverId: readRequiredString(resolved.snapshot.host.serverId) ?? null,
                    expectedGeneration: host.expectedGeneration,
                    qualifiedActionId: resolved.descriptor.qualifiedActionId,
                    fieldPath: field.path,
                    timeoutMs: DEFAULT_INVOCATION_TIMEOUT_MS,
                    ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
                },
            );
            const current = resolveFormAction(resolved.descriptor, resolved.snapshot);
            if (current.kind !== 'resolved') return current;
            if (!result.supported) {
                return { kind: 'unavailable', reason: 'host_unavailable' };
            }
            if (!result.result.ok) {
                return result.result.code === 'plugin_generation_stale'
                    ? { kind: 'stale', reason: 'action_retired' }
                    : { kind: 'unavailable', reason: 'host_unavailable' };
            }
            optionsByPath.set(field.path, result.result.options);
        }
        try {
            // This transient view is the exact host-produced option result for
            // this one form lifetime. It removes the dynamic marker so the
            // renderer cannot re-resolve, cache, or re-authorize accounts.
            return ActionInputHintsSchema.parse({
                ...resolved.descriptor.inputHints,
                fields: resolved.descriptor.inputHints.fields.map((field) => {
                    if (field.connectedAccountOptions !== true) return field;
                    return projectResolvedConnectedAccountOptions(
                        field,
                        optionsByPath.get(field.path) ?? [],
                    );
                }),
            });
        } catch {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
    }

    function resolveSelectionTarget(
        request: PluginUiSelectActionInputRequestV1,
    ): SelectionTarget | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome {
        // Literal host-owned selectors are resolved by their owning host route.
        // This controller is the targeted-contribution selection owner only, so
        // it must not reinterpret a host request as an executable Action.
        if (!('operation' in request)) return { kind: 'unavailable', reason: 'invalid_input' };
        const snapshot = currentSnapshot();
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const targetedContributions = snapshot.targetedContributions;
        const mountedTargetPluginId = readRequiredString(snapshot.host.targetPluginId);
        if (
            !targetedContributions
            || !mountedTargetPluginId
            || targetedContributions.target.pluginId !== mountedTargetPluginId
        ) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        const operation = request.operation;
        const point = targetedContributions.points.find((candidate) => (
            candidate.pointId === operation.point.pointId
        ));
        const protocol = point?.protocols.find((candidate) => (
            candidate.protocol.id === operation.point.protocol.id
            && candidate.protocol.version === operation.point.protocol.version
        ));
        if (!protocol) return { kind: 'unavailable', reason: 'action_not_found' };
        const admitted = protocol.contributions.some((contribution) => (
            contribution.contributor.pluginId === operation.contributor.pluginId
            && contribution.contributor.contributionId === operation.contributor.contributionId
            && contribution.contributor.immutableGenerationId === operation.contributor.immutableGenerationId
            && contribution.operations.some((candidate) => (
                sameTargetedContributionOperation(candidate, operation)
            ))
        ));
        if (!admitted) return { kind: 'unavailable', reason: 'action_not_found' };

        // The cold admission snapshot is the only Action-selection authority.
        // The normalized generic projection contributes current UI metadata for
        // that exact qualified Action only; it is never enumerated or used to
        // substitute a local id from another contributor.
        const plugin = snapshot.pluginProjectionById[operation.action.pluginId];
        if (!plugin || plugin.pluginId !== operation.action.pluginId || plugin.enabled !== true) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const identity = PluginContributionIdentityV1Schema.safeParse(operation.action);
        if (!identity.success) return { kind: 'unavailable', reason: 'invalid_input' };
        const action = plugin.actions.find((candidate) => candidate.id === operation.action.localId);
        if (
            !action
            || !hasCurrentClientActionRegistration(snapshot, identity.data)
            || action.available !== true
            || !action.surfaces.includes('plugin')
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        return {
            snapshot,
            targetedContributions,
            operation,
            plugin,
            action,
            identity: identity.data,
        };
    }

    function resolveCurrentSelection(
        request: PluginUiSelectActionInputRequestV1,
        original: SelectionTarget,
    ): SelectionTarget | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome {
        const current = resolveSelectionTarget(request);
        if ('kind' in current) {
            return current.reason === 'host_unavailable'
                ? current
                : { kind: 'stale', reason: 'action_retired' };
        }
        return sameTargetedContributionOperation(current.operation, original.operation)
            && sameTargetedContributionTarget(
                current.targetedContributions.target,
                original.targetedContributions.target,
            )
            && hasSameActionFormHostBinding(original.snapshot, current.snapshot)
            ? current
            : { kind: 'stale', reason: 'action_retired' };
    }

    /**
     * Resolves exactly one qualified plugin-surface Action and its committed
     * immutable generation. This is deliberately narrower than catalog
     * selection: it never enumerates another plugin or local-id candidate.
     */
    function resolveExactBoundAction(
        request: PluginExactBoundActionInputRequest,
    ): ExactBoundAction | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome {
        const identity = PluginContributionIdentityV1Schema.safeParse(request.action);
        const expectedImmutableGenerationId = readRequiredString(request.expectedImmutableGenerationId);
        if (!identity.success || !expectedImmutableGenerationId) {
            return { kind: 'unavailable', reason: 'invalid_input' };
        }
        const snapshot = currentSnapshot();
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const plugin = snapshot.pluginProjectionById[identity.data.pluginId];
        if (
            !plugin
            || plugin.pluginId !== identity.data.pluginId
            || plugin.enabled !== true
            || plugin.generation === null
            || String(plugin.generation) !== host.expectedGeneration
            || readRequiredString(plugin.immutableGenerationId) !== expectedImmutableGenerationId
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const action = plugin.actions.find((candidate) => candidate.id === identity.data.localId);
        if (
            !action
            || !hasCurrentClientActionRegistration(snapshot, identity.data)
            || action.available !== true
            || !action.surfaces.includes('plugin')
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        return {
            snapshot,
            plugin,
            action,
            identity: identity.data,
            expectedImmutableGenerationId,
        };
    }

    function resolveCurrentExactBoundAction(
        request: PluginExactBoundActionInputRequest,
        original: ExactBoundAction,
        isAdditionallyCurrent: () => boolean,
    ): ExactBoundAction | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome {
        const current = resolveExactBoundAction(request);
        if ('kind' in current) return current;
        let additionallyCurrent = false;
        try {
            additionallyCurrent = isAdditionallyCurrent();
        } catch {
            additionallyCurrent = false;
        }
        return current.identity.pluginId === original.identity.pluginId
            && current.identity.localId === original.identity.localId
            && current.expectedImmutableGenerationId === original.expectedImmutableGenerationId
            && hasSameActionFormHostBinding(original.snapshot, current.snapshot)
            && additionallyCurrent
            ? current
            : { kind: 'stale', reason: 'action_retired' };
    }

    async function resolveExactBoundConnectedAccountOptions(
        resolved: ExactBoundAction,
        inputHints: ActionInputHints,
        field: ActionInputHints['fields'][number],
        resolveCurrent: () => ExactBoundAction | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome,
    ): Promise<ActionInputHints | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome> {
        const host = hostStatus(resolved.snapshot);
        if (host.kind !== 'ready') return host;
        if (!host.machineId) return { kind: 'unavailable', reason: 'host_unavailable' };
        const result = await resolveConnectedAccountOptions(host.machineId, {
            serverId: host.serverId,
            expectedGeneration: host.expectedGeneration,
            qualifiedActionId: buildQualifiedPluginContributionKey(resolved.identity),
            fieldPath: field.path,
            ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
        });
        const current = resolveCurrent();
        if ('kind' in current) return current;
        if (!result.supported) return { kind: 'unavailable', reason: 'host_unavailable' };
        if (!result.result.ok) return result.result.code === 'plugin_generation_stale'
            ? { kind: 'stale', reason: 'action_retired' }
            : { kind: 'unavailable', reason: 'host_unavailable' };
        const options = result.result.options;
        try {
            return ActionInputHintsSchema.parse({
                ...inputHints,
                fields: inputHints.fields.map((candidate) => {
                    if (candidate.path !== field.path) return candidate;
                    return projectResolvedConnectedAccountOptions(candidate, options);
                }),
            });
        } catch {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
    }

    /**
     * The shared no-invoke form primitive. Targeted Host API membership is an
     * adapter-provided currentness condition; Automation calls this directly
     * with its resolved Event catalog entry.
     */
    async function selectExactBoundActionInputForm(
        request: PluginExactBoundActionInputRequest,
        isAdditionallyCurrent: () => boolean = () => true,
    ): Promise<PluginContributedActionExactInputSelectionPrimitiveOutcome> {
        const resolved = resolveExactBoundAction(request);
        if ('kind' in resolved) return resolved;
        const resolveCurrent = () => resolveCurrentExactBoundAction(
            request,
            resolved,
            isAdditionallyCurrent,
        );
        const presentation = presentationForExactBoundAction(resolved);
        const inputHints = presentation.inputHints;
        const fields = inputHints?.fields ?? [];
        if (fields.some((field) => field.widget === 'secret')) {
            return { kind: 'unavailable', reason: 'secret_input_unsupported' };
        }
        const accountFields = fields.filter((field) => field.connectedAccountOptions === true);
        if (accountFields.length > 1) {
            return { kind: 'unavailable', reason: 'connected_account_ambiguous' };
        }
        const draft = request.draft ?? {};
        if (!draftMatchesDeclaredNonSecretFields({ draft, action: resolved.action })) {
            return { kind: 'unavailable', reason: 'invalid_draft' };
        }
        if (!inputHints || fields.length === 0) {
            const parsedInput = PluginUiJsonValueV1Schema.safeParse(draft);
            const validatesDraft = parsedInput.success
                && parsedInput.data
                && !Array.isArray(parsedInput.data)
                && typeof parsedInput.data === 'object'
                && (
                    resolved.action.inputSchema == null
                    || isValidPluginJsonSchemaValue(
                        compilePluginJsonSchema(resolved.action.inputSchema),
                        parsedInput.data,
                    )
                );
            return validatesDraft
                ? {
                    kind: 'direct',
                    result: {
                        kind: 'submitted',
                        action: resolved.identity,
                        input: parsedInput.data as PluginContributedActionExactSubmittedInputResult['input'],
                        connectedAccount: { kind: 'none' },
                    },
                }
                : { kind: 'unavailable', reason: 'invalid_input' };
        }
        if (!resolved.snapshot.host.accountLifetime) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        const resolvedHints = accountFields[0]
            ? await resolveExactBoundConnectedAccountOptions(resolved, inputHints, accountFields[0], resolveCurrent)
            : inputHints;
        if ('kind' in resolvedHints) return resolvedHints;

        type SelectionSettlement = PluginContributedActionExactInputSelectionSettlement;
        let settleResult: (result: SelectionSettlement) => void = () => undefined;
        const result = new Promise<SelectionSettlement>((resolve) => {
            settleResult = resolve;
        });
        let settled = false;
        const settle = (value: SelectionSettlement) => {
            if (settled) return;
            settled = true;
            settleResult(value);
        };
        const form = createActionInputForm<
            PluginContributedActionSelectionSubmitOutcome,
            PluginContributedActionUnavailableOutcome['reason'],
            PluginContributedActionStaleOutcome['reason']
        >({
            presentation: {
                title: presentation.title,
                description: presentation.description,
                inputHints: resolvedHints,
            },
            accountLifetime: resolved.snapshot.host.accountLifetime,
            ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
            isCurrent: () => !('kind' in resolveCurrent()),
            retiredReason: 'action_retired',
            submissionInFlightReason: 'submission_in_flight',
            onCancel: () => settle({ kind: 'cancelled' }),
            onRetire: () => settle({ kind: 'stale', reason: 'action_retired' }),
            submit: async (candidate) => {
                const current = resolveCurrent();
                if ('kind' in current) {
                    settle(current);
                    return current;
                }
                if (
                    !current.action.inputSchema
                    || !isValidPluginJsonSchemaValue(
                        compilePluginJsonSchema(current.action.inputSchema),
                        candidate,
                    )
                ) return { kind: 'unavailable', reason: 'invalid_input' };

                const accountField = accountFields[0];
                let input = candidate;
                type SubmittedSelection = PluginContributedActionExactSubmittedInputResult;
                let connectedAccount: SubmittedSelection['connectedAccount'] = { kind: 'none' };
                if (accountField) {
                    const parsedRef = QualifiedConnectedAccountRefSchema.safeParse(
                        readPath(candidate, accountField.path),
                    );
                    if (!parsedRef.success) return { kind: 'unavailable', reason: 'invalid_input' };
                    input = deletePath(candidate, accountField.path);
                    connectedAccount = {
                        kind: 'selected',
                        fieldPath: accountField.path,
                        ref: parsedRef.data,
                    };
                }
                const parsedInput = PluginUiJsonValueV1Schema.safeParse(input);
                if (!parsedInput.success || !parsedInput.data || Array.isArray(parsedInput.data) || typeof parsedInput.data !== 'object') {
                    return { kind: 'unavailable', reason: 'invalid_input' };
                }
                settle({
                    kind: 'submitted',
                    action: current.identity,
                    input: parsedInput.data as SubmittedSelection['input'],
                    connectedAccount,
                });
                return { ok: true };
            },
        });
        form.replaceInput(draft);
        return { kind: 'form', form, result };
    }

    /**
     * An exact bound caller holds a cold Action reference rather than a
     * target-scoped Host API selection. Once that reference is no longer
     * current, it is unavailable to that caller. The private form primitive
     * still retains stale settlements for its presentation lifecycle and for
     * the target-scoped adapter that owns `stale_surface` publication.
     */
    function publishExactBoundActionInputSelection(
        selection: PluginContributedActionExactInputSelectionPrimitiveOutcome,
    ): PluginContributedActionExactInputSelectionOutcome {
        const unavailableForStale = (
            stale: PluginContributedActionStaleOutcome,
        ): PluginContributedActionUnavailableOutcome => (
            stale.reason === 'host_retired'
                ? { kind: 'unavailable', reason: 'host_unavailable' }
                : { kind: 'unavailable', reason: 'action_not_found' }
        );
        if (selection.kind === 'stale') return unavailableForStale(selection);
        if (selection.kind !== 'form') return selection;
        return {
            ...selection,
            result: selection.result.then((settled) => (
                settled.kind === 'stale' ? unavailableForStale(settled) : settled
            )),
        };
    }

    function publishTargetedSelection(
        result: PluginContributedActionExactInputSelectionResult,
        target: SelectionTarget,
    ): PluginUiSelectActionInputResultV1 {
        if (result.kind === 'cancelled') return result;
        return {
            ...result,
            selection: {
                target: target.targetedContributions.target,
                point: target.operation.point,
                contributor: target.operation.contributor,
            },
        };
    }

    function publishCurrentTargetedSelection(
        request: PluginUiSelectActionInputRequestV1,
        target: SelectionTarget,
        result: PluginContributedActionExactInputSelectionResult
            | PluginContributedActionUnavailableOutcome
            | PluginContributedActionStaleOutcome,
    ): PluginUiSelectActionInputResultV1
        | PluginContributedActionUnavailableOutcome
        | PluginContributedActionStaleOutcome {
        if (result.kind !== 'submitted') return result;
        const current = resolveCurrentSelection(request, target);
        return 'kind' in current ? current : publishTargetedSelection(result, current);
    }

    return {
        list(selector) {
            const snapshot = currentSnapshot();
            if (!snapshot || hostStatus(snapshot).kind !== 'ready') return [];
            const actions: PluginContributedActionDescriptor[] = [];
            for (const plugin of Object.values(snapshot.pluginProjectionById)) {
                if (plugin.enabled !== true || plugin.generation === null) continue;
                if (String(plugin.generation) !== readExpectedGeneration(snapshot.host.expectedGeneration)) continue;
                for (const action of plugin.actions) {
                    const identity = { pluginId: plugin.pluginId, localId: action.id };
                    if (
                        !isActionCurrent(snapshot, identity)
                        || !hasCurrentClientActionRegistration(snapshot, identity)
                    ) continue;
                    const descriptor = descriptorForAction({
                        pluginId: plugin.pluginId,
                        action,
                        pluginUiProjection: snapshot.pluginUiProjection,
                        selector,
                    });
                    if (descriptor) actions.push(descriptor);
                }
            }
            return actions.sort(comparePluginContributedActionDescriptors);
        },
        listSlashCommands() {
            const snapshot = currentSnapshot();
            if (!snapshot || hostStatus(snapshot).kind !== 'ready') return [];
            const actions: PluginContributedActionDescriptor[] = [];
            for (const plugin of Object.values(snapshot.pluginProjectionById)) {
                if (plugin.enabled !== true || plugin.generation === null) continue;
                if (String(plugin.generation) !== readExpectedGeneration(snapshot.host.expectedGeneration)) continue;
                for (const action of plugin.actions) {
                    const identity = { pluginId: plugin.pluginId, localId: action.id };
                    if (
                        !isActionCurrent(snapshot, identity)
                        || !hasCurrentClientActionRegistration(snapshot, identity)
                    ) continue;
                    const descriptor = descriptorForAction({
                        pluginId: plugin.pluginId,
                        action,
                        pluginUiProjection: snapshot.pluginUiProjection,
                        selector: { placement: 'composer.slash', scope: 'session' },
                    });
                    if (!descriptor || !hasComposerSlashTokens(descriptor.slash)) continue;
                    actions.push(descriptor);
                }
            }
            return actions.sort(comparePluginContributedActionDescriptors);
        },
        async open(requested) {
            const current = resolveAction(requested);
            if (current.kind !== 'resolved') return current;
            if (isResolvedFormAction(current.value)) {
                if (!current.value.snapshot.host.accountLifetime) {
                    return { kind: 'unavailable', reason: 'host_unavailable' };
                }
                const inputHints = await resolveFormConnectedAccountOptions(current.value);
                if ('kind' in inputHints) return inputHints;
                return {
                    kind: 'form',
                    action: current.value.descriptor,
                    form: createForm(current.value, inputHints),
                };
            }
            const submitted = await dispatchResolvedAction(
                current.value,
                {},
                () => resolveAction(requested).kind === 'resolved',
                undefined,
                current.value.descriptor.placement,
            );
            return submitted.kind === 'settled'
                ? {
                    kind: 'direct',
                    action: current.value.descriptor,
                    outcome: submitted.outcome,
                }
                : submitted;
        },
        async selectActionInput(request) {
            const target = resolveSelectionTarget(request);
            if ('kind' in target) return target;
            // The target-scoped Host API proves membership before borrowing the
            // generic primitive. It does not keep a second form, currentness,
            // local-id lookup, or invocation path of its own.
            const selected = await selectExactBoundActionInputForm({
                action: target.identity,
                expectedImmutableGenerationId: target.operation.contributor.immutableGenerationId,
                ...(request.draft === undefined ? {} : { draft: request.draft }),
            }, () => !('kind' in resolveCurrentSelection(request, target)));
            if (selected.kind === 'direct') {
                const current = resolveCurrentSelection(request, target);
                if ('kind' in current) return current;
                return {
                    kind: 'direct',
                    result: publishTargetedSelection(selected.result, current),
                };
            }
            if (selected.kind === 'form') {
                return {
                    kind: 'form',
                    form: selected.form,
                    result: selected.result.then((result) => (
                        publishCurrentTargetedSelection(request, target, result)
                    )),
                };
            }
            return selected;
        },
        async selectExactBoundActionInput(request) {
            return publishExactBoundActionInputSelection(
                await selectExactBoundActionInputForm(request),
            );
        },
        isReferenceAvailable(requested) {
            return resolveReference(requested).kind === 'resolved';
        },
        isSessionReferenceAvailable(requested) {
            return resolveSessionReference(requested).kind === 'resolved';
        },
        async invokeReference(requested, input) {
            const current = resolveReference(requested);
            if (current.kind !== 'resolved') return current;
            return await dispatchResolvedAction(
                current.value,
                input,
                () => resolveReference(requested).kind === 'resolved',
                undefined,
                resolveMessageReferenceInvocationPlacement(current.value),
            );
        },
        async openSessionReference(requested, input) {
            const current = resolveSessionReference(requested);
            if (current.kind !== 'resolved') return current;
            if (input === undefined && isResolvedFormAction(current.value)) {
                if (!current.value.snapshot.host.accountLifetime) {
                    return { kind: 'unavailable', reason: 'host_unavailable' };
                }
                const inputHints = await resolveFormConnectedAccountOptions(current.value);
                if ('kind' in inputHints) return inputHints;
                return {
                    kind: 'form',
                    action: current.value.descriptor,
                    form: createForm(current.value, inputHints),
                };
            }
            const submitted = await dispatchResolvedAction(
                current.value,
                input === undefined ? null : input,
                () => resolveSessionReference(requested).kind === 'resolved',
                undefined,
                current.value.descriptor.placement,
            );
            return submitted.kind === 'settled'
                ? {
                    kind: 'direct',
                    action: current.value.descriptor,
                    outcome: submitted.outcome,
                }
                : submitted;
        },
    };
}
