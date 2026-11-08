import { DaemonPluginHostPresentedComposerCurrentIntentV1Schema, type DaemonPluginHostPresentedComposerCurrentIntentV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { PluginActionPlacementV2Schema, PluginActionScopeV2Schema, type PluginActionPlacementV2, type PluginActionScopeV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { QualifiedConnectedAccountRefSchema, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { DaemonPluginActionFormConnectedAccountOption } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { InputHintsSchema as ActionInputHintsSchema, type InputHints as ActionInputHints } from '@happier-dev/protocol/inputs/inputFields';
import { seedInputByFieldHints, writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readActionSessionTargetOperands, replaceActionSessionTargetField, validateActionSessionAddressV1 } from '@happier-dev/protocol/actions/executor/sessionTargets';
import type { MessageActionReferenceV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import {
    PluginUiJsonValueV1Schema,
    reconstructPluginUiSelectedActionInput,
    type CurrentUiContextSnapshotV1,
    type PluginUiSelectedActionInputForReconstructionV1,
    type PluginUiTargetedContributionOperationV1,
    type PluginUiTargetedContributionsV1,
    type PluginUiSelectActionInputRequestV1,
    type PluginUiSelectActionInputResultV1,
    type PluginUiSelectActionInputTargetedRequestV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { readPluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import {
    type DispatchPluginSurfaceActionInput,
    type PluginSurfaceActionDispatchOutcome,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceHostPresentedActionInvocation,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { launchPluginSurfaceAction } from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import type { PopoverAnchor } from '@/components/ui/popover';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import {
    machinePluginActionFormConnectedAccountOptionsResolve,
    machinePluginActionSchemasRead,
    type MachinePluginActionFormConnectedAccountOptionsResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    resolvePluginProjectedActionPresentation,
    type PluginProjectedActionPresentation,
} from '@/sync/domains/plugins/ui/actionPresentation';
import {
    isPluginProjectedActionExecutable,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { getPreferredLanguage } from '@/text';
import { createPluginLocalizedTextResolver, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { readCurrentAppShellPluginUiTranslationRuntime } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';

import {
    createActionInputForm,
    type ActionInputForm,
    type ActionInputFormSubmitOutcome,
} from './actionInputForm';
import { comparePluginContributedActionDescriptors } from './pluginContributedActionPresentation';
import { declaredHostInputFieldAdmitsValue, draftMatchesDeclaredNonSecretFields } from './actionInputDraftValidation';
export { comparePluginContributedActionDescriptors } from './pluginContributedActionPresentation';

const executeRowAction = createFrontDoorActionExecute();

function isSessionRowPlacement(snapshot: PluginContributedActionCurrentSnapshot,
    placement: PluginActionPlacementV2 | undefined, scope: PluginActionScopeV2 | undefined): boolean {
    return snapshot.host.sessionRow === true && scope === 'session' && (placement === 'rowAction' || placement === 'contextMenu');
}

function readSessionRowAddress(snapshot: PluginContributedActionCurrentSnapshot) {
    const { serverId, sessionId, accountLifetime } = snapshot.host;
    return serverId && sessionId && accountLifetime?.isCurrent()
        && areServerProfileIdentifiersEquivalent(serverId, accountLifetime.scope.serverId)
        ? { serverId: accountLifetime.scope.serverId, sessionId } : null;
}

/** Only initial intent is seeded; an edited operand must still match the row at dispatch. */
function seedSessionRowInput(snapshot: PluginContributedActionCurrentSnapshot,
    identity: PluginContributedActionDescriptor['identity'], input: Readonly<Record<string, unknown>>) {
    const address = readSessionRowAddress(snapshot);
    const declaration = snapshot.resolveContributedAction?.(identity)?.sessionTarget;
    if (!address || !declaration) return input;
    const operands = readActionSessionTargetOperands(input, declaration.field);
    if (operands.length === 1) return replaceActionSessionTargetField(input, operands[0]!.field, address.sessionId);
    // A wildcard names existing array slots, not a new array grammar. Forms
    // retain their declared defaults; final admission requires one exact slot.
    return declaration.field.includes('*') ? input : writeInputPath(input, declaration.field, address.sessionId);
}

/**
 * This controller adds only its local action identity around Protocol's
 * selection-free reconstruction input. The Protocol owner reconstructs the
 * selected Connected Account for every realm.
 */
type PluginContributedActionExactSubmittedInputResult = Readonly<{
    kind: 'submitted';
    action: Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>['action'];
    presentation: Readonly<{ connectedAccountLabel: string | null }>;
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

type NativeCredentialFormChoice = Readonly<{
    fieldPath: string;
    nativeServicePath: string;
    service: Readonly<{ pluginId: string; localId: string }>;
}>;
type ResolvedCredentialFormHints = Readonly<{
    inputHints: ActionInputHints;
    nativeChoices: readonly NativeCredentialFormChoice[];
}>;

function resolveNativeCredentialFormInput(candidate: Readonly<Record<string, unknown>>, choices: readonly NativeCredentialFormChoice[]) {
    let input = candidate;
    for (const fieldPath of new Set(choices.map(choice => choice.fieldPath))) {
        const selected = PluginContributionIdentityV1Schema.safeParse(readPath(candidate, fieldPath));
        if (!selected.success) continue;
        const choice = choices.find(option => option.fieldPath === fieldPath
            && option.service.pluginId === selected.data.pluginId && option.service.localId === selected.data.localId);
        if (!choice) return null;
        input = writeInputPath(deletePath(input, fieldPath), choice.nativeServicePath, choice.service);
    }
    return input;
}

function readNativeCredentialFormChoices(fieldPath: string, options: readonly DaemonPluginActionFormConnectedAccountOption[]): readonly NativeCredentialFormChoice[] {
    return options.flatMap(option => 'nativeServicePath' in option
        ? [{ fieldPath, nativeServicePath: option.nativeServicePath, service: option.value }] : []);
}

/**
 * The host facts a concrete UI placement already owns. Action currentness is
 * carried by each projected Action's exact contributor occurrence.
 */
export type PluginContributedActionHostFacts = Readonly<{
    machineId: string | null | undefined;
    /** Existing machine-store display projection; never an identifier fallback. */
    machineDisplayName?: string | null;
    serverId?: string | null;
    /** Exact mounted targeted-contribution target; never derived from a contributor. */
    targetPluginId?: string | null;
    sessionId?: string | null;
    /** Concrete list-row intent; reference forms may borrow the same placement without it. */
    sessionRow?: true;
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
    /** The incumbent target-scoped destination owner; never caller-built navigation. */
    openSurface?: PluginSurfaceOpenHandler;
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
    localize?: PluginLocalizedTextResolver;
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
    /** The contributing plugin's display name (its projection entry title), for grouping; never its id. */
    pluginTitle?: string | null;
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
    pickerContext?: import('@/components/sessions/actions/InputTypePickerHostProvider').InputTypePickerHostContext;
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
    /** Hidden inventories can retain authored copy without demanding Resources; admission is unchanged. */
    list(selector: PluginContributedActionSelector, presentation?: Readonly<{
        localize: PluginLocalizedTextResolver;
    }>): readonly PluginContributedActionDescriptor[];
    /** Current session-scoped slash Actions for the incumbent composer picker. */
    listSlashCommands(): readonly PluginContributedActionDescriptor[];
    open(action: PluginContributedActionDescriptor, anchor?: PopoverAnchor): Promise<PluginContributedActionOpenOutcome>;
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
        anchor?: PopoverAnchor,
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
 * its caller has already received an admitted qualified Action and occurrence
 * from its owning catalog.
 */
export type PluginExactBoundActionInputRequest = Readonly<{
    action: Readonly<{ pluginId: string; localId: string }>;
    expectedOccurrenceId: string;
    /** Host-stamped caller surface; targeted and Automation selection retain their plugin default. */
    invocationSurface?: 'ui' | 'plugin';
    draft?: Readonly<Record<string, unknown>>;
    /** Authoring intent, re-admitted against the declared dynamic account choices on submit. */
    connectedAccount?: import('@happier-dev/protocol/connect/qualified-connected-account-persistence').QualifiedConnectedAccountRef;
    /** Event authoring may carry schema-declared, non-presented setup operands. */
    allowSchemaDeclaredDraftFields?: true;
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
    expectedOccurrenceId: string;
}>;

type ResolvedFormAction = ResolvedAction & Readonly<{
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
    /** The plugin's projection entry title (its display name). */
    pluginTitle?: string | null;
    action: PluginProjectionAction;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localize?: PluginLocalizedTextResolver;
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
        !isPluginProjectedActionExecutable(params.action)
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
        localize: params.localize,
        locale: getPreferredLanguage(),
    });
    const base = {
        identity: identity.data,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity.data),
        title: presentation.title,
        description: presentation.description,
        pluginTitle: params.pluginTitle?.trim() || null,
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

async function prepareActionPresentation(snapshot: PluginContributedActionCurrentSnapshot, pluginId: string, action: PluginProjectionAction) {
    const projection = snapshot.pluginUiProjection;
    const locale = getPreferredLanguage();
    const presentation = actionPresentationForResolver(action);
    const initialLocalize = snapshot.localize ?? createPluginLocalizedTextResolver({ projection, locale });
    let hasKeyedCopy = false;
    const fallback = resolvePluginProjectedActionPresentation({ pluginId, presentation, projection, locale,
        localize: (id, value) => {
            if (value && typeof value === 'object' && 'key' in value && typeof value.key === 'string') hasKeyedCopy = true;
            return initialLocalize(id, value);
        } });
    if (!hasKeyedCopy || !projection?.translationsByPluginId[pluginId]?.resourceIdsByLocale) return fallback;
    const owner = readCurrentAppShellPluginUiTranslationRuntime(projection);
    if (!owner) return fallback;
    const runtime = owner.matchesSource(projection, pluginId) ? owner : owner.createScopedRuntime(projection);
    try {
        await runtime.demand(pluginId, locale);
        return resolvePluginProjectedActionPresentation({ pluginId, presentation, projection, locale,
            localize: createPluginLocalizedTextResolver({ projection, runtime, locale }) });
    } finally {
        if (runtime !== owner) runtime.dispose();
    }
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
    expectedOccurrenceId: string;
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
        && left.contributor.occurrenceId === right.contributor.occurrenceId
        && pluginSourceCustodyV1Equal(
            left.contributor.sourceCustody,
            right.contributor.sourceCustody,
        )
        && left.role === right.role
        && left.action.pluginId === right.action.pluginId
        && left.action.localId === right.action.localId;
}

function sameTargetedContributionTarget(
    left: PluginUiTargetedContributionsV1['target'],
    right: PluginUiTargetedContributionsV1['target'],
): boolean {
    return left.pluginId === right.pluginId
        && left.occurrenceId === right.occurrenceId
        && pluginSourceCustodyV1Equal(
            left.sourceCustody,
            right.sourceCustody,
        );
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

/**
 * One host-owned action catalog/form/currentness seam. It consumes the
 * normalized projection and delegates all execution to the canonical surface
 * dispatcher, which stamps `executionSurface: 'ui'` and invokes daemon policy.
 */
export function createPluginContributedActionController(params: Readonly<{
    /** An app catalog can span Machines; a selected Action borrows its own already-admitted host. */
    resolveCurrent: (identity?: Readonly<{ pluginId: string; localId: string }>) => PluginContributedActionCurrentSnapshot | null;
    dispatch?: PluginContributedActionDispatch;
    resolveConnectedAccountOptions?: PluginContributedActionConnectedAccountOptionsTransport;
}>): PluginContributedActionController
    & PluginActionInputSelectionController
    & PluginExactBoundActionInputController {
    const dispatch = params.dispatch;
    const resolveConnectedAccountOptions = params.resolveConnectedAccountOptions
        ?? machinePluginActionFormConnectedAccountOptionsResolve;

    function currentSnapshot(identity?: Readonly<{ pluginId: string; localId: string }>): PluginContributedActionCurrentSnapshot | null {
        try {
            return params.resolveCurrent(identity);
        } catch {
            return null;
        }
    }

    function hostStatus(snapshot: PluginContributedActionCurrentSnapshot):
        | Readonly<{
            kind: 'ready';
            machineId: string | null;
            serverId: string | null;
            accountLifetime: ActiveServerAccountScopeLifetime | null;
        }>
        | PluginContributedActionUnavailableOutcome
        | PluginContributedActionStaleOutcome {
        const machineId = readRequiredString(snapshot.host.machineId);
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

    function hasSessionRowTarget(snapshot: PluginContributedActionCurrentSnapshot,
        identity: PluginContributedActionDescriptor['identity'], placement: PluginActionPlacementV2, scope: PluginActionScopeV2): boolean {
        return !isSessionRowPlacement(snapshot, placement, scope)
            || (readSessionRowAddress(snapshot) !== null && !!snapshot.resolveContributedAction?.(identity)?.sessionTarget);
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
        return resolvePluginUiClientActionRegistration({
                action: projectedAction,
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
        identity: Readonly<{ pluginId: string; localId: string }>,
    ): boolean {
        const originalHost = hostStatus(original);
        const currentHost = hostStatus(current);
        const originalOccurrenceId = readRequiredString(
            original.pluginProjectionById[identity.pluginId]?.actions
                .find((candidate) => candidate.id === identity.localId)?.occurrenceId,
        );
        const currentOccurrenceId = readRequiredString(
            current.pluginProjectionById[identity.pluginId]?.actions
                .find((candidate) => candidate.id === identity.localId)?.occurrenceId,
        );
        return originalHost.kind === 'ready'
            && currentHost.kind === 'ready'
            && isActionCurrent(original, identity)
            && originalHost.machineId === currentHost.machineId
            && originalHost.serverId === currentHost.serverId
            && originalOccurrenceId !== null
            && originalOccurrenceId === currentOccurrenceId
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
        const snapshot = currentSnapshot(requested.identity);
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const plugin = snapshot.pluginProjectionById[requested.identity.pluginId];
        if (
            !plugin
            || plugin.pluginId !== requested.identity.pluginId
            || plugin.enabled !== true
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const action = plugin.actions.find((candidate) => candidate.id === requested.identity.localId);
        const expectedOccurrenceId = readRequiredString(action?.occurrenceId);
        if (
            !action
            || !expectedOccurrenceId
            || !isActionCurrent(snapshot, requested.identity)
            || !hasCurrentClientActionRegistration(snapshot, requested.identity)
            || !hasSessionRowTarget(snapshot, requested.identity, requested.placement, requested.scope)
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const descriptor = descriptorForAction({
            pluginId: plugin.pluginId,
            pluginTitle: plugin.title,
            action,
            pluginUiProjection: snapshot.pluginUiProjection,
            localize: snapshot.localize,
            selector: {
                placement: requested.placement,
                scope: requested.scope,
            },
        });
        if (!descriptor || !sameDescriptor(requested, descriptor)) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        return {
            kind: 'resolved',
            value: {
                snapshot,
                descriptor,
                identity: descriptor.identity,
                expectedOccurrenceId,
            },
        };
    }

    function resolveFormAction(
        requested: PluginContributedActionDescriptor,
        originalSnapshot: PluginContributedActionCurrentSnapshot,
    ): ResolveActionResult {
        const current = resolveAction(requested);
        if (current.kind !== 'resolved') return current;
        return hasSameActionFormHostBinding(originalSnapshot, current.value.snapshot, requested.identity)
            ? current
            : { kind: 'stale', reason: 'host_retired' };
    }

    function resolveReference(
        requested: Readonly<{ pluginId: string; localId: string }>,
    ): ResolveActionResult<ResolvedCurrentAction> {
        const identity = PluginContributionIdentityV1Schema.safeParse(requested);
        if (!identity.success) return { kind: 'unavailable', reason: 'invalid_input' };
        const snapshot = currentSnapshot(identity.data);
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const plugin = snapshot.pluginProjectionById[identity.data.pluginId];
        if (
            !plugin
            || plugin.pluginId !== identity.data.pluginId
            || plugin.enabled !== true
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
            || !isPluginProjectedActionExecutable(action)
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
            pluginTitle: plugin.title,
            action,
            pluginUiProjection: reference.value.snapshot.pluginUiProjection,
            localize: reference.value.snapshot.localize,
            // Retain only the first non-semantic placement to reuse the
            // descriptor, form, and currentness owner. A semantic
            // Composer/Message binding must never acquire this generic
            // session-scoped control path.
            selector: { placement, scope: 'session' },
        });
        if (!descriptor) return { kind: 'stale', reason: 'action_retired' };
        const expectedOccurrenceId = readRequiredString(action.occurrenceId);
        if (!expectedOccurrenceId) return { kind: 'stale', reason: 'action_retired' };
        return {
            kind: 'resolved',
            value: { ...reference.value, descriptor, expectedOccurrenceId },
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
            // Client handlers have no legacy daemon admission to preserve. An
            // actual menu press may carry its Message even when the same Action
            // also appears in the palette; reference-only routes stay unchanged.
            const clientAction = snapshot.resolveContributedAction?.(params.resolved.identity)?.execution.target === 'client';
            if (!clientAction && !isSemanticOnlyMessageMenuAction(params.resolved)) return { kind: 'resolved' };
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
        scope?: PluginActionScopeV2,
        anchor?: PopoverAnchor,
    ): Promise<PluginContributedActionInvocationOutcome> {
        const host = hostStatus(resolved.snapshot);
        if (host.kind !== 'ready') return host;
        const projectedAction = resolved.snapshot.resolveContributedAction?.(resolved.identity) ?? null;
        if (!projectedAction) return { kind: 'unavailable', reason: 'host_unavailable' };
        const executionTarget = projectedAction.execution.target;
        if (executionTarget === 'daemon' && !host.machineId) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        const transportInput = input === undefined ? undefined : PluginUiJsonValueV1Schema.safeParse(input);
        if (transportInput !== undefined && !transportInput.success) {
            // This is only the JSON transport boundary. The Action schema still
            // performs final field validation at canonical dispatch.
            return { kind: 'unavailable', reason: 'invalid_input' };
        }
        const rowAddress = isSessionRowPlacement(resolved.snapshot, placement, scope) ? readSessionRowAddress(resolved.snapshot) : null;
        if (isSessionRowPlacement(resolved.snapshot, placement, scope) && (!rowAddress || !validateActionSessionAddressV1({
            sessionTarget: projectedAction.sessionTarget,
            input: transportInput?.data,
            sessionAddress: rowAddress,
        }).ok)) return { kind: 'unavailable', reason: 'invalid_input' };
        const invocation = resolveHostInvocation({ resolved, placement });
        if (invocation.kind !== 'resolved') return invocation;
        const dispatchSignal = signal ?? resolved.snapshot.host.signal;
        try {
            const dispatchInput: DispatchPluginSurfaceActionInput = {
                actionInputAnchor: anchor,
                // Catalog, Composer, and transcript host presentation never
                // fabricate a mounted plugin caller. The canonical dispatcher
                // receives only the current host intent carrier, if required.
                action: resolved.identity,
                ...(transportInput === undefined ? {} : { input: transportInput.data }),
                ...(resolved.snapshot.resolveContributedAction
                    ? { resolveContributedAction: resolved.snapshot.resolveContributedAction }
                    : {}),
                ...(rowAddress ? { hostAction: { execute: executeRowAction, context: {
                    surface: 'ui' as const, serverId: rowAddress.serverId,
                    expectedAccountId: resolved.snapshot.host.accountLifetime!.scope.accountId,
                    defaultSessionId: rowAddress.sessionId,
                } } } : {}),
                ...(executionTarget !== 'daemon'
                    ? {
                        clientAction: {
                            ...(placement === 'message.menu' && invocation.invocation?.kind === 'hostPresentedMessage'
                                ? { messageActionReference: invocation.invocation.currentMessageIntent }
                                : {}),
                            ...(resolved.snapshot.host.openSurface
                                ? { openSurface: resolved.snapshot.host.openSurface }
                                : {}),
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
                            ...(rowAddress && resolved.snapshot.host.accountLifetime
                                ? { accountLifetime: resolved.snapshot.host.accountLifetime } : {}),
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
                pluginUiProjection: resolved.snapshot.pluginUiProjection,
                ...(dispatchSignal ? { signal: dispatchSignal } : {}),
                isCurrent,
            };
            if (dispatch) {
                return { kind: 'settled', outcome: await dispatch(dispatchInput) };
            }
            const launched = await launchPluginSurfaceAction(dispatchInput);
            return launched;
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
        nativeChoices: readonly NativeCredentialFormChoice[] = [],
        anchor?: PopoverAnchor,
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
            ...(isSessionRowPlacement(resolved.snapshot, resolved.descriptor.placement, resolved.descriptor.scope) ? { initialInput: seedSessionRowInput(
                resolved.snapshot, resolved.identity, seedInputByFieldHints({ inputHints }, {}),
            ) } : {}),
            accountLifetime: resolved.snapshot.host.accountLifetime,
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
                const input = resolveNativeCredentialFormInput(candidate, nativeChoices);
                if (!input) return { kind: 'unavailable', reason: 'invalid_input' };
                const outcome = await dispatchResolvedAction(
                    current.value,
                    input,
                    () => resolveFormAction(
                        resolved.descriptor,
                        resolved.snapshot,
                    ).kind === 'resolved',
                    context.signal,
                    current.value.descriptor.placement,
                    current.value.descriptor.scope,
                    anchor,
                );
                // Dispatch owns settlement ordering. A presentation signal can
                // prevent admission before dispatch, but cannot relabel a
                // fulfilled canonical result observed afterward.
                return outcome;
            },
        });
        return { ...form, action: resolved.descriptor, pickerContext: {
            machineId: resolved.snapshot.host.machineId,
            serverId: resolved.snapshot.host.serverId,
            sessionId: resolved.snapshot.host.sessionId,
            contextKey: resolved.descriptor.qualifiedActionId,
        } };
    }

    async function prepareFormAction(resolved: ResolvedFormAction): Promise<ResolveActionResult<ResolvedFormAction>> {
        const action = resolved.snapshot.pluginProjectionById[resolved.identity.pluginId]?.actions
            .find(candidate => candidate.id === resolved.identity.localId);
        if (!action) return { kind: 'stale', reason: 'action_retired' };
        const presentation = await prepareActionPresentation(resolved.snapshot, resolved.identity.pluginId, action);
        const current = resolveFormAction(resolved.descriptor, resolved.snapshot);
        if (current.kind !== 'resolved') return current;
        if (!isResolvedFormAction(current.value) || !presentation.inputHints) return { kind: 'stale', reason: 'action_retired' };
        return { kind: 'resolved', value: { ...current.value, descriptor: { ...current.value.descriptor,
            title: presentation.title, description: presentation.description, inputHints: presentation.inputHints } } };
    }

    async function resolveFormConnectedAccountOptions(
        resolved: ResolvedFormAction,
    ): Promise<ResolvedCredentialFormHints | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome> {
        const dynamicFields = resolved.descriptor.inputHints.fields.filter((field) => (
            field.connectedAccountOptions === true
        ));
        if (dynamicFields.length === 0) return { inputHints: resolved.descriptor.inputHints, nativeChoices: [] };
        const host = hostStatus(resolved.snapshot);
        if (host.kind !== 'ready') return host;
        if (!host.machineId) return { kind: 'unavailable', reason: 'host_unavailable' };
        const optionsByPath = new Map<string, ActionInputHints['fields'][number]['options']>();
        const nativeChoices: NativeCredentialFormChoice[] = [];
        for (const field of dynamicFields) {
            const result: MachinePluginActionFormConnectedAccountOptionsResult = await resolveConnectedAccountOptions(
                host.machineId,
                {
                    serverId: readRequiredString(resolved.snapshot.host.serverId) ?? null,
                    expectedOccurrenceId: resolved.expectedOccurrenceId,
                    qualifiedActionId: resolved.descriptor.qualifiedActionId,
                    fieldPath: field.path,
                    ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
                },
            );
            const current = resolveFormAction(resolved.descriptor, resolved.snapshot);
            if (current.kind !== 'resolved') return current;
            if (!result.supported) {
                return { kind: 'unavailable', reason: 'host_unavailable' };
            }
            if (!result.result.ok) {
                return result.result.code === 'plugin_occurrence_stale'
                    ? { kind: 'stale', reason: 'action_retired' }
                    : { kind: 'unavailable', reason: 'host_unavailable' };
            }
            optionsByPath.set(field.path, result.result.options.map(({ value, label }) => ({ value, label })));
            nativeChoices.push(...readNativeCredentialFormChoices(field.path, result.result.options));
        }
        try {
            // This transient view is the exact host-produced option result for
            // this one form lifetime. It removes the dynamic marker so the
            // renderer cannot re-resolve, cache, or re-authorize accounts.
            return { nativeChoices, inputHints: ActionInputHintsSchema.parse({
                ...resolved.descriptor.inputHints,
                fields: resolved.descriptor.inputHints.fields.map((field) => {
                    if (field.connectedAccountOptions !== true) return field;
                    return projectResolvedConnectedAccountOptions(
                        field,
                        optionsByPath.get(field.path) ?? [],
                    );
                }),
            }) };
        } catch {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
    }

    function resolveSelectionTarget(
        request: PluginUiSelectActionInputTargetedRequestV1,
    ): SelectionTarget | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome {
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
            || readRequiredString(action.occurrenceId) !== operation.contributor.occurrenceId
            || !hasCurrentClientActionRegistration(snapshot, identity.data)
            || !isPluginProjectedActionExecutable(action)
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
        request: PluginUiSelectActionInputTargetedRequestV1,
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
            && hasSameActionFormHostBinding(original.snapshot, current.snapshot, current.identity)
            ? current
            : { kind: 'stale', reason: 'action_retired' };
    }

    /**
     * Resolves exactly one qualified plugin-surface Action and its process-local
     * occurrence. This is deliberately narrower than catalog
     * selection: it never enumerates another plugin or local-id candidate.
     */
    function resolveExactBoundAction(
        request: PluginExactBoundActionInputRequest,
    ): ExactBoundAction | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome {
        const identity = PluginContributionIdentityV1Schema.safeParse(request.action);
        const expectedOccurrenceId = readRequiredString(request.expectedOccurrenceId);
        if (!identity.success || !expectedOccurrenceId) {
            return { kind: 'unavailable', reason: 'invalid_input' };
        }
        const snapshot = currentSnapshot(identity.data);
        if (!snapshot) return { kind: 'unavailable', reason: 'host_unavailable' };
        const host = hostStatus(snapshot);
        if (host.kind !== 'ready') return host;
        const plugin = snapshot.pluginProjectionById[identity.data.pluginId];
        if (
            !plugin
            || plugin.pluginId !== identity.data.pluginId
            || plugin.enabled !== true
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        const action = plugin.actions.find((candidate) => candidate.id === identity.data.localId);
        if (
            !action
            || readRequiredString(action.occurrenceId) !== expectedOccurrenceId
            || !hasCurrentClientActionRegistration(snapshot, identity.data)
            || !isPluginProjectedActionExecutable(action)
            || !action.surfaces.includes(request.invocationSurface ?? 'plugin')
        ) {
            return { kind: 'stale', reason: 'action_retired' };
        }
        return {
            snapshot,
            plugin,
            action,
            identity: identity.data,
            expectedOccurrenceId,
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
            && current.expectedOccurrenceId === original.expectedOccurrenceId
            && hasSameActionFormHostBinding(original.snapshot, current.snapshot, current.identity)
            && additionallyCurrent
            ? current
            : { kind: 'stale', reason: 'action_retired' };
    }

    async function resolveExactBoundConnectedAccountOptions(
        resolved: ExactBoundAction,
        inputHints: ActionInputHints,
        field: ActionInputHints['fields'][number],
        resolveCurrent: () => ExactBoundAction | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome,
    ): Promise<ResolvedCredentialFormHints | PluginContributedActionUnavailableOutcome | PluginContributedActionStaleOutcome> {
        const host = hostStatus(resolved.snapshot);
        if (host.kind !== 'ready') return host;
        if (!host.machineId) return { kind: 'unavailable', reason: 'host_unavailable' };
        const result = await resolveConnectedAccountOptions(host.machineId, {
            serverId: host.serverId,
            expectedOccurrenceId: resolved.expectedOccurrenceId,
            qualifiedActionId: buildQualifiedPluginContributionKey(resolved.identity),
            fieldPath: field.path,
            ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
        });
        const current = resolveCurrent();
        if ('kind' in current) return current;
        if (!result.supported) return { kind: 'unavailable', reason: 'host_unavailable' };
        if (!result.result.ok) return result.result.code === 'plugin_occurrence_stale'
            ? { kind: 'stale', reason: 'action_retired' }
            : { kind: 'unavailable', reason: 'host_unavailable' };
        const options = result.result.options.map(({ value, label }) => ({ value, label }));
        try {
            return { nativeChoices: readNativeCredentialFormChoices(field.path, result.result.options), inputHints: ActionInputHintsSchema.parse({
                ...inputHints,
                fields: inputHints.fields.map((candidate) => {
                    if (candidate.path !== field.path) return candidate;
                    return projectResolvedConnectedAccountOptions(candidate, options);
                }),
            }) };
        } catch {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
    }

    /**
     * The form's own settlement for a schema-complete draft that already fills its one account field: the account
     * must be one of the person's Connected Accounts the field offers (else refused), or a native service the field
     * offers. `null` when the draft names neither, so the form remains the way to choose.
     */
    function settleCompleteAccountDraft(
        identity: ExactBoundAction['identity'],
        draft: Readonly<Record<string, unknown>>,
        fieldPath: string,
        resolvedHints: ResolvedCredentialFormHints,
    ): PluginContributedActionExactInputSelectionPrimitiveOutcome | null {
        const refused = { kind: 'unavailable', reason: 'invalid_draft' } as const;
        const named = readPath(draft, fieldPath);
        let input = draft;
        let connectedAccount: PluginContributedActionExactSubmittedInputResult['connectedAccount'] = { kind: 'none' };
        let connectedAccountLabel: string | null = null;
        if (named !== undefined) {
            const ref = QualifiedConnectedAccountRefSchema.safeParse(named);
            if (!ref.success) return refused;
            const offered = resolvedHints.inputHints.fields.find((field) => field.path === fieldPath)?.options?.find((option) => {
                const optionRef = QualifiedConnectedAccountRefSchema.safeParse(option.value);
                return optionRef.success && sameQualifiedConnectedAccountRef(optionRef.data, ref.data);
            });
            if (!offered) return refused;
            input = deletePath(draft, fieldPath);
            connectedAccount = { kind: 'selected', fieldPath, ref: ref.data };
            connectedAccountLabel = offered.label.trim() || null;
        } else if (!resolvedHints.nativeChoices.some((choice) => {
            const service = PluginContributionIdentityV1Schema.safeParse(readPath(draft, choice.nativeServicePath));
            return choice.fieldPath === fieldPath && service.success
                && service.data.pluginId === choice.service.pluginId && service.data.localId === choice.service.localId;
        })) return null;
        const parsedInput = PluginUiJsonValueV1Schema.safeParse(input);
        if (!parsedInput.success || !parsedInput.data || Array.isArray(parsedInput.data) || typeof parsedInput.data !== 'object') return refused;
        return { kind: 'direct', result: { kind: 'submitted', action: identity,
            input: parsedInput.data as PluginContributedActionExactSubmittedInputResult['input'],
            connectedAccount, presentation: { connectedAccountLabel } } };
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
        const presentation = await prepareActionPresentation(resolved.snapshot, resolved.identity.pluginId, resolved.action);
        const afterCopyRead = resolveCurrent();
        if ('kind' in afterCopyRead) return afterCopyRead;
        const inputHints = presentation.inputHints;
        const fields = inputHints?.fields ?? [];
        if (fields.some((field) => field.widget === 'secret')) {
            return { kind: 'unavailable', reason: 'secret_input_unsupported' };
        }
        const accountFields = fields.filter((field) => field.connectedAccountOptions === true);
        if (accountFields.length > 1) {
            return { kind: 'unavailable', reason: 'connected_account_ambiguous' };
        }
        const projectedAction = resolved.snapshot.resolveContributedAction?.(resolved.identity);
        let inputSchema: PluginJsonSchemaV2 | undefined;
        if (projectedAction && (projectedAction.execution.target === 'account' || 'hostAccountOrigin' in projectedAction)) {
            const lifetime = resolved.snapshot.host.accountLifetime;
            const selected = !projectedAction.accountActionDeclaration && lifetime ? await readPluginAccountAvailability(lifetime.scope)
                .ensureCurrentAccountExecution(resolved.identity.pluginId) : null;
            const declaration = projectedAction.accountActionDeclaration ?? (selected?.kind === 'available' && selected.custodyId === projectedAction.occurrenceId
                ? selected.manifest.contributes.actions.find(action => action.id === resolved.identity.localId) : undefined);
            if (!declaration || !readPluginUiAccountExecutableOrigin(projectedAction)) {
                return { kind: 'unavailable', reason: 'host_unavailable' };
            }
            inputSchema = declaration.inputSchema ?? {};
        } else {
            // Machine-projected Actions retain their exact occurrence schema read;
            // Account declarations already carry the admitted schema locally.
            const machineId = readRequiredString(resolved.snapshot.host.machineId);
            if (!machineId) return { kind: 'unavailable', reason: 'host_unavailable' };
            const schemas = await machinePluginActionSchemasRead(machineId, {
                serverId: readRequiredString(resolved.snapshot.host.serverId) ?? null,
                expectedOccurrenceId: resolved.expectedOccurrenceId,
                qualifiedActionId: buildQualifiedPluginContributionKey(resolved.identity),
                ...(resolved.snapshot.host.signal ? { signal: resolved.snapshot.host.signal } : {}),
            });
            if (!schemas.supported || !schemas.result.ok) {
                return schemas.supported && !schemas.result.ok && schemas.result.code === 'plugin_occurrence_stale'
                    ? { kind: 'stale', reason: 'action_retired' }
                    : { kind: 'unavailable', reason: 'host_unavailable' };
            }
            inputSchema = schemas.result.inputSchema;
        }
        const afterSchemaRead = resolveCurrent();
        if ('kind' in afterSchemaRead) return afterSchemaRead;
        let draft = request.draft ?? {};
        if (request.connectedAccount) {
            const accountField = accountFields[0];
            const parsedDraft = PluginUiJsonValueV1Schema.safeParse(draft);
            if (!accountField || !parsedDraft.success) return { kind: 'unavailable', reason: 'invalid_draft' };
            const seeded = reconstructPluginUiSelectedActionInput({ input: parsedDraft.data,
                connectedAccount: { kind: 'selected', fieldPath: accountField.path, ref: request.connectedAccount } },
                { allowMatchingConnectedAccount: true });
            if (!seeded) return { kind: 'unavailable', reason: 'invalid_draft' };
            draft = seeded;
        }
        const nonAccountDraft = request.connectedAccount && accountFields[0] ? deletePath(draft, accountFields[0].path) : draft;
        const draftMatchesFields = draftMatchesDeclaredNonSecretFields({ draft: nonAccountDraft, action: resolved.action, inputSchema,
            allowDeclaredUnhintedFields: request.connectedAccount !== undefined || request.allowSchemaDeclaredDraftFields === true });
        // A draft that is already the Action's complete input, including its one account field (the source's bound
        // account or a native service that field offers), settles below exactly as the form would, without it.
        const completeAccountDraft = request.draft !== undefined && request.connectedAccount === undefined
            && accountFields.length === 1 && inputSchema !== undefined
            && isValidPluginJsonSchemaValue(compilePluginJsonSchema(inputSchema), draft);
        if (!draftMatchesFields && !completeAccountDraft) {
            return { kind: 'unavailable', reason: 'invalid_draft' };
        }
        if (!inputHints || fields.length === 0) {
            const parsedInput = PluginUiJsonValueV1Schema.safeParse(draft);
            const validatesDraft = parsedInput.success
                && parsedInput.data
                && !Array.isArray(parsedInput.data)
                && typeof parsedInput.data === 'object'
                && (inputSchema === undefined || isValidPluginJsonSchemaValue(
                    compilePluginJsonSchema(inputSchema),
                    parsedInput.data,
                ));
            return validatesDraft
                ? {
                    kind: 'direct',
                    result: {
                        kind: 'submitted',
                        action: resolved.identity,
                        input: parsedInput.data as PluginContributedActionExactSubmittedInputResult['input'],
                        connectedAccount: { kind: 'none' },
                        presentation: { connectedAccountLabel: null },
                    },
                }
                : { kind: 'unavailable', reason: 'invalid_input' };
        }
        if (!resolved.snapshot.host.accountLifetime) {
            return { kind: 'unavailable', reason: 'host_unavailable' };
        }
        const resolvedHints = accountFields[0]
            ? await resolveExactBoundConnectedAccountOptions(resolved, inputHints, accountFields[0], resolveCurrent)
            : { inputHints, nativeChoices: [] };
        if ('kind' in resolvedHints) return resolvedHints;
        if (completeAccountDraft) {
            const settled = settleCompleteAccountDraft(resolved.identity, draft, accountFields[0]!.path, resolvedHints);
            if (settled !== null) return settled;
            if (!draftMatchesFields) return { kind: 'unavailable', reason: 'invalid_draft' };
        }

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
                inputHints: resolvedHints.inputHints,
            },
            initialInput: draft,
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
                const normalizedCandidate = resolveNativeCredentialFormInput(candidate, resolvedHints.nativeChoices);
                if (!normalizedCandidate) return { kind: 'unavailable', reason: 'invalid_input' };
                for (const field of resolvedHints.inputHints.fields) {
                    if (!field.inputType || !('hostType' in field.inputType)) continue;
                    const value = readPath(normalizedCandidate, field.path);
                    if (value !== undefined && !declaredHostInputFieldAdmitsValue(field, value)) {
                        return { kind: 'unavailable', reason: 'invalid_input' };
                    }
                }
                // `resolveCurrent` pins the same Action occurrence the schema
                // was read for.
                if (inputSchema !== undefined && !isValidPluginJsonSchemaValue(
                    compilePluginJsonSchema(inputSchema),
                    normalizedCandidate,
                )) return { kind: 'unavailable', reason: 'invalid_input' };

                const accountField = accountFields[0];
                let input = normalizedCandidate;
                type SubmittedSelection = PluginContributedActionExactSubmittedInputResult;
                let connectedAccount: SubmittedSelection['connectedAccount'] = { kind: 'none' };
                let connectedAccountLabel: string | null = null;
                const nativeSelected = accountField && resolvedHints.nativeChoices.some(choice => choice.fieldPath === accountField.path
                    && readPath(candidate, accountField.path) !== undefined
                    && PluginContributionIdentityV1Schema.safeParse(readPath(candidate, accountField.path)).success);
                if (accountField && !nativeSelected) {
                    const parsedRef = QualifiedConnectedAccountRefSchema.safeParse(
                        readPath(normalizedCandidate, accountField.path),
                    );
                    if (!parsedRef.success) return { kind: 'unavailable', reason: 'invalid_input' };
                    input = deletePath(normalizedCandidate, accountField.path);
                    connectedAccount = {
                        kind: 'selected',
                        fieldPath: accountField.path,
                        ref: parsedRef.data,
                    };
                    const resolvedAccountField = resolvedHints.inputHints.fields.find((field) => field.path === accountField.path);
                    connectedAccountLabel = resolvedAccountField?.options?.flatMap((option) => {
                        const optionRef = QualifiedConnectedAccountRefSchema.safeParse(option.value);
                        return optionRef.success && sameQualifiedConnectedAccountRef(optionRef.data, parsedRef.data)
                            ? [option.label.trim()]
                            : [];
                    }).find(Boolean) ?? null;
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
                    presentation: { connectedAccountLabel },
                });
                return { ok: true };
            },
        });
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
            presentation: {
                connectedAccountLabel: result.presentation.connectedAccountLabel,
                machineDisplayName: readRequiredString(target.snapshot.host.machineDisplayName),
            },
            selection: {
                target: {
                    pluginId: target.targetedContributions.target.pluginId,
                    sourceCustody:
                        target.targetedContributions.target.sourceCustody,
                },
                point: target.operation.point,
                contributor: {
                    pluginId: target.operation.contributor.pluginId,
                    contributionId:
                        target.operation.contributor.contributionId,
                    sourceCustody:
                        target.operation.contributor.sourceCustody,
                },
            },
        };
    }

    function publishCurrentTargetedSelection(
        request: PluginUiSelectActionInputTargetedRequestV1,
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
        list(selector, presentation) {
            const snapshot = currentSnapshot();
            if (!snapshot || hostStatus(snapshot).kind !== 'ready') return [];
            const actions: PluginContributedActionDescriptor[] = [];
            for (const plugin of Object.values(snapshot.pluginProjectionById)) {
                if (plugin.enabled !== true) continue;
                for (const action of plugin.actions) {
                    const identity = { pluginId: plugin.pluginId, localId: action.id };
                    if (
                        !isActionCurrent(snapshot, identity)
                        || !hasCurrentClientActionRegistration(snapshot, identity)
                        || !hasSessionRowTarget(snapshot, identity, selector.placement, selector.scope)
                    ) continue;
                    const descriptor = descriptorForAction({
                        pluginId: plugin.pluginId,
                        pluginTitle: plugin.title,
                        action,
                        pluginUiProjection: snapshot.pluginUiProjection,
                        localize: presentation?.localize ?? snapshot.localize,
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
                if (plugin.enabled !== true) continue;
                for (const action of plugin.actions) {
                    const identity = { pluginId: plugin.pluginId, localId: action.id };
                    if (
                        !isActionCurrent(snapshot, identity)
                        || !hasCurrentClientActionRegistration(snapshot, identity)
                    ) continue;
                    const descriptor = descriptorForAction({
                        pluginId: plugin.pluginId,
                        pluginTitle: plugin.title,
                        action,
                        pluginUiProjection: snapshot.pluginUiProjection,
                        localize: snapshot.localize,
                        selector: { placement: 'composer.slash', scope: 'session' },
                    });
                    if (!descriptor || !hasComposerSlashTokens(descriptor.slash)) continue;
                    actions.push(descriptor);
                }
            }
            return actions.sort(comparePluginContributedActionDescriptors);
        },
        async open(requested, anchor) {
            const current = resolveAction(requested);
            if (current.kind !== 'resolved') return current;
            if (isResolvedFormAction(current.value)) {
                if (!current.value.snapshot.host.accountLifetime) {
                    return { kind: 'unavailable', reason: 'host_unavailable' };
                }
                const prepared = await prepareFormAction(current.value);
                if (prepared.kind !== 'resolved') return prepared;
                const inputHints = await resolveFormConnectedAccountOptions(prepared.value);
                if ('kind' in inputHints) return inputHints;
                return {
                    kind: 'form',
                    action: prepared.value.descriptor,
                    form: createForm(prepared.value, inputHints.inputHints, inputHints.nativeChoices, anchor),
                };
            }
            const submitted = await dispatchResolvedAction(
                current.value,
                isSessionRowPlacement(current.value.snapshot, current.value.descriptor.placement, current.value.descriptor.scope)
                    ? seedSessionRowInput(current.value.snapshot, current.value.identity, {}) : {},
                () => resolveAction(requested).kind === 'resolved',
                undefined,
                current.value.descriptor.placement,
                current.value.descriptor.scope,
                anchor,
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
            // Literal host-owned projections are resolved by their owning host
            // route. This controller accepts only the targeted request arm and
            // must not reinterpret either host projection as an Action.
            if (!('operation' in request)) return { kind: 'unavailable', reason: 'invalid_input' };
            const target = resolveSelectionTarget(request);
            if ('kind' in target) return target;
            // The target-scoped Host API proves membership before borrowing the
            // generic primitive. It does not keep a second form, currentness,
            // local-id lookup, or invocation path of its own.
            const selected = await selectExactBoundActionInputForm({
                action: target.identity,
                expectedOccurrenceId: target.operation.contributor.occurrenceId,
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
        async openSessionReference(requested, input, anchor) {
            const current = resolveSessionReference(requested);
            if (current.kind !== 'resolved') return current;
            if (input === undefined && isResolvedFormAction(current.value)) {
                if (!current.value.snapshot.host.accountLifetime) {
                    return { kind: 'unavailable', reason: 'host_unavailable' };
                }
                const prepared = await prepareFormAction(current.value);
                if (prepared.kind !== 'resolved') return prepared;
                const inputHints = await resolveFormConnectedAccountOptions(prepared.value);
                if ('kind' in inputHints) return inputHints;
                return {
                    kind: 'form',
                    action: prepared.value.descriptor,
                    form: createForm(prepared.value, inputHints.inputHints, inputHints.nativeChoices, anchor),
                };
            }
            const submitted = await dispatchResolvedAction(
                current.value,
                input,
                () => resolveSessionReference(requested).kind === 'resolved',
                undefined,
                current.value.descriptor.placement,
                undefined,
                anchor,
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
