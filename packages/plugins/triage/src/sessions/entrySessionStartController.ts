import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import type { ScmComparisonSource } from '@happier-dev/plugin-sdk/scm';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import type { ActionSessionAddressV1, SessionInputForgeEvidenceV1 } from '@happier-dev/plugin-sdk/sessions';
import type { AgentExecutionTargetV1 } from '@happier-dev/plugin-sdk/agents';
import type {
    PluginUiActionExecutionOptions,
    SelectActionInputRequest,
    SelectActionInputResult,
} from '@happier-dev/plugin-sdk/ui';
import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_DEFAULT_FIX_ACTION_ID_V1,
    projectTriagePrepareReviewWorkspaceInputV1,
    type TriageEntryLocatorV1,
    type TriageEntryRefV1,
    type TriageSourceInstanceRefV1,
    type TriageSessionHandoffInputV1,
} from '@happier-dev/triage-protocol/v1';

import { sameTriageEntryReference } from '../corpus/identity/components.js';
import { mintTriageOpaqueIdV1 } from '../opaqueId.js';
import { buildTriageForgeEvidenceAttachmentDraftV1 } from '../composer/mutationPlan.js';
import { openLinkedSession } from '../sessions/entrySessionOpen.js';
import { resolvesTriageUnknownSessionStartV1 } from '../ui/header/sessionStartOutcome.js';
import type {
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1,
} from '../actions/entrySessionProtocol.js';
import { planTriageActionDeliveryV1 } from '../sessions/actionDelivery.js';
import {
    readTriageActionExecutionPlacementV1,
    readTriageActionLaunchDirectoryV1,
    resolveTriageActionCheckoutV1,
    resolveTriageActionPlacementV1,
} from '../sessions/actionLaunch.js';
import {
    resolveTriageActionInstructionV1,
    resolveTriageActionReferencesV1,
    readTriageActionPlacementV1,
    type TriageActionReferencesV1,
    type TriageActionResolutionHostV1,
} from '../sessions/actionResolution.js';
import { resolveTriageLinkedSessionPlacementV1, type TriageForgeIdentityV1 } from '../sessions/launchPlacement.js';
import {
    readTriageAgentExecutionTargetV1,
    type TriageAgentInventoryHostV1,
} from '../sessions/agentTarget.js';
import {
    readTriageProjectRegistryV1,
    type TriageProjectRegistryHostV1,
} from '../sessions/projectCandidates.js';
import {
    hasTriageActionInstructionSourceV1,
    isTriageActionConfigurationCoherentV1,
    requiresTriageActionInstructionV1,
    type TriageActionV1,
} from '../settings/actions.js';
import {
    projectTriageActionPlacementCandidatesV1,
    projectTriageNewSessionDestinationV1,
    type TriageNewSessionPreferenceV1,
    type TriageReviewWorkspacePreparationV1,
} from '../ui/header/newSessionDestination.js';
import {
    type TriageNewSessionSeedHostV1,
    type TriageNewSessionFailureV1,
} from '../ui/header/newSessionSeedCommand.js';
import { triageActionDefaultSeedV1, requestTriageNewSessionAuthoringV1 } from './newSessionAuthoring.js';
import { readTriageEntrySessionFactsV1, type TriageEntrySessionSourceFactsV1 } from './readEntrySessionFacts.js';
import { projectTriageNewSessionFailureV1 } from '../ui/header/newSessionSeedCommand.js';
import {
    submitTriageEntrySessionStart,
    type TriageSessionStartHostV1,
} from '../ui/header/startEntrySessionCommand.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionResultV1Schema,
    type TriageConfiguredStartRecoveryV1, type TriageRunConfiguredActionResultV1 } from '../actions/configuredActionRunProtocol.js';

type TriageSingleStartRecoveryV1 = Extract<TriageConfiguredStartRecoveryV1['state'], { kind: 'single' }>;

/**
 * The transient single-entry Session-start controller shared by UI and Actions.
 *
 * One press resolves the pressed action's references and placement. Compose
 * hands those facts to the host's New Session authoring surface and stops;
 * send starts through this plugin's one start Action and delivers there. Each
 * of those belongs to an owner this module composes and none of them lives
 * here: the record's five answers to `settings/actions.ts`, the placement
 * precedence to `sessions/actionLaunch.ts`, the two reference reads to
 * `sessions/actionResolution.ts`, the workspace-mode gate, creation, link and
 * open to `sessions/entrySessionOrchestrator.ts`, and whether a settled start
 * may be reviewed in at all to the canonical `review.start` Action path.
 *
 * **This is where a configured action stops being a stored record.** Before
 * this, four of the five members A1 defines reached nothing: `profileId`,
 * `promptInvocationId`, `delivery` and `target.kind` were stored, wired and
 * edited, and every press produced the same empty agent Session. They are read
 * here, in that order, and every one of them changes what the press does.
 *
 * It is deliberately the only state in the whole start path, and it is
 * transient: an in-flight request and the last settled verdict, both scoped to
 * this controller. There is no local Session record, no optimistic link, no queue
 * and no retry policy.
 *
 * A press that arrives while one is in flight is ignored rather than queued:
 * two presses of one action are one request, and admitting the second would
 * open a second New Session surface and mint a second creation key for the
 * Session the first is already creating.
 */

export type TriageEntrySessionStartRequestV1 = Readonly<{
    /** Explicit host-shaped destinations use the incumbent draft projection. */
    settlement?: unknown;
    /**
     * Where the reader asked this press to go, when not the action's own resolution (the split's Send to a
     * Session): `existingSession` hands the configured action to a Session selected by the host's picker. Choosing
     * the agent and machine is the prefilled composer's job (Add instructions…), not a destination.
     */
    destinationChoice?: 'existingSession';
    /** The pressed action, whole. Every member of it decides something below. */
    action: TriageActionV1;
    /** Final human-edited ORC prompt, not a configured Prompt Library or shipped fallback. */
    orchestrationPrompt?: string;
    requestedTask?: TriageSessionHandoffInputV1['task'];
    forgeEvidence?: SessionInputForgeEvidenceV1;
    preferredAgentTargetKey?: string;
    resolvedAgentTarget?: AgentExecutionTargetV1;
    resolvedReferences?: Extract<TriageActionReferencesV1, { status: 'resolved' }>;
    /** Read-only navigation shares placement/creation, with no prompt or checkout preparation. */
    comparisonDestination?: PluginActionInputById['session.open']['destination'];
    linkedSessionIds?: readonly string[];
    comparisonSource?: ScmComparisonSource;
    entryRef: TriageEntryRefV1;
    display: TriageStartEntrySessionInputV1['display'];
    /**
     * The connection this entry was read through, and the bounded immutable
     * fallback the host freezes for it. Together they are the entry attachment
     * a delivery carries — the way entry context reaches the agent without any
     * provider prose being stringified into a prompt (`PLAN.md` §0a A4/A8).
     */
    sourceInstance: TriageSourceInstanceRefV1;
    presentation: ComposerAttachmentAuthorPresentationV1;
    /** The routing hint the observation carried, when one was observed. */
    lastKnownLocator?: TriageEntryLocatorV1;
    /**
     * What Triage settings pin for this action beyond the record, when the
     * reader set anything. Absent is the default path.
     */
    preference?: TriageNewSessionPreferenceV1;
    /**
     * The entry's own forge repository, when it has one, exactly as its source
     * declared it. It is the left half of the launch-placement join; absent —
     * an error group, an analytics issue — resolves no candidate, which is the
     * honest answer rather than a guessed directory.
     */
    repository?: TriageForgeIdentityV1;
    /**
     * The exact admitted source operation and semantic request for a formal
     * pull-request review. The mounted host selects its raw input once the
     * reader has settled the matching project/machine/root workspace.
     */
    /** The admitted source snapshot lets a sparse list observation acquire its missing exact revision on press. */
    sourceContributions?: TriageEntrySessionSourceFactsV1;
    reviewWorkspace?: Readonly<{
        operation: Extract<SelectActionInputRequest, Readonly<{ operation: unknown }>>['operation'];
        preparation: TriageReviewWorkspacePreparationV1;
    }>;
}>;

/**
 * `SessionCreationKeyV1`: the one identity of one logical new-Session request.
 *
 * It is injectable for the same reason the link's publication id is
 * (`sessions/entrySessionLinks.ts`) — a caller that must pin exactly what left
 * for the daemon, and a runtime whose `crypto` surface is not guaranteed.
 */
export type TriageSessionCreationKeyMintV1 = () => string;

const mintRandomCreationKey: TriageSessionCreationKeyMintV1 = mintTriageOpaqueIdV1;

/**
 * Why nothing was started, when the failure is this surface's rather than a
 * phase of the orchestrator's own verdict.
 */
export type TriageEntrySessionStartUnavailableReasonV1 =
    | 'handoffOutcomeUnknown'
    /** This mount cannot open the host's New Session surface at all. */
    | 'newSessionUnsupported'
    /** It could not be opened, or settled something no start can be built from. */
    | 'newSessionUnavailable'
    /** The reachable wire cannot request a prepared review workspace. */
    | 'preparedWorkspaceUnsupported'
    /**
     * A reference the action names is not in the catalog that owns it.
     *
     * It is refused BEFORE anything is created, because the alternatives are
     * both dishonest: treating a deleted Launch Profile as "no preference"
     * starts the Session with the very defaults the person configured away
     * from, and noticing a deleted prompt only after the Session exists leaves
     * the reader with an empty composer or a generic prompt Triage invented in
     * place of theirs. The reference has to be repointed; a retry cannot help.
     */
    | 'profileMissing'
    | 'promptMissing'
    | 'promptInvalid'
    /** The action has no Prompt Library reference or shipped fallback task. */
    | 'instructionMissing'
    /**
     * The catalog that owns a configured reference did not answer.
     *
     * Deliberately distinct from missing: nothing is known to be wrong with the
     * configuration, and retrying is exactly what can help.
     */
    | 'profileUnavailable'
    | 'promptUnavailable'
    /** Nothing left this surface: the press failed before the start Action. */
    | 'dispatch'
    /**
     * The start Action left, and what became of it is unknown.
     *
     * Deliberately distinct from `dispatch`: the host emits the exact daemon
     * Action and can then lose its settlement
     * (`pluginSurfaceActionDispatch.ts`, `plugin_ui_action_outcome_unknown`), so
     * a Session, a link and a Message may all exist. Saying "nothing was
     * started" would be false, and the retry this leaves available repeats the
     * retained identity rather than minting a second one.
     */
    | 'startOutcomeUnknown';

/**
 * What became of the action's configured prompt and entry attachment.
 *
 * It is reported beside the start's own verdict rather than folded into it: the
 * Session was created, linked and opened either way, and telling a reader the
 * start failed because their prompt was refused would be false.
 *
 * A `send` is delivered inside the start, before the open (`PLAN.md` §0a A4a),
 * so its verdict arrives on the start's own result and is carried unchanged.
 * A `compose` never reaches this type: it opens the host-owned New Session
 * authoring surface and stops before a Session exists.
 *
 * There is no "the prompt no longer exists" arm: a reference that cannot be
 * resolved refuses the press before the Session exists.
 */
export type TriageEntrySessionDeliveryOutcomeV1 =
    /** The canonical `session.message.send` verdict, exactly as it answered. */
    | Readonly<{
        kind: 'send';
        status: Extract<
            TriageStartEntrySessionResultV1,
            Readonly<{ type: 'opened' | 'linked' | 'openPending' }>
        >['delivery'];
    }>
    /** Nothing was configured to deliver, so nothing was placed. */
    | Readonly<{ kind: 'none' }>;

export type TriageEntrySessionStartPhaseV1 =
    | Readonly<{ kind: 'idle' }>
    /** The action's profile, prompt and placement are being resolved. */
    | Readonly<{ kind: 'resolving' }>
    /** The host's New Session surface is open and the reader is choosing. */
    | Readonly<{ kind: 'choosing' }>
    | Readonly<{ kind: 'starting' }>
    /** The configured Action retains its native receipt, refusal and recovery unchanged. */
    | Readonly<{ kind: 'handoffSettled'; result: TriageRunConfiguredActionResultV1 }>
    /** The orchestrator answered. Every arm — including its refusals — is here. */
    | Readonly<{
        kind: 'settled';
        result: TriageStartEntrySessionResultV1;
        /** Present for an `agent` action that settled into a Session. */
        delivery?: TriageEntrySessionDeliveryOutcomeV1;
    }>
    /**
     * Nothing was started. It is deliberately distinct from every settled arm,
     * because "nothing was started" and "the start failed at a named phase" are
     * different things to tell a reader.
     */
    | Readonly<{ kind: 'unavailable'; reason: TriageEntrySessionStartUnavailableReasonV1; failure?: TriageNewSessionFailureV1 }>;

export type TriageEntrySessionStartControllerV1 = Readonly<{
    phase: TriageEntrySessionStartPhaseV1;
    authoringResult?: 'seeded' | 'cancelled';
    /** The canonical custody's prompt, immutable while this orchestration can only resume. */
    pendingOrchestrationPrompt: string | null;
    /** A linked selected-PR Session awaiting the reader's explicit engine choice. */
    review: TriagePendingPullRequestReviewV1 | null;
    /** Ignored while a press is in flight; otherwise starts exactly one. */
    start: (request: TriageEntrySessionStartRequestV1) => void;
    startInSession: (request: TriageEntrySessionStartRequestV1, session: ActionSessionAddressV1) => Promise<TriageRunConfiguredActionResultV1 | null>;
    /** Returns to `idle` — for dismissing a settled outcome, never for retrying one. */
    reset: () => void;
}>;

export type TriagePendingPullRequestReviewV1 = Readonly<{
    actionId: TriageActionV1['actionId'];
    sessionId: Extract<TriageStartEntrySessionResultV1, Readonly<{ type: 'linked' }>>['sessionId'];
    review: NonNullable<Extract<
        TriageStartEntrySessionResultV1,
        Readonly<{ type: 'linked' }>
    >['review']>;
    instructions: string;
    comparisonSource?: ScmComparisonSource;
}>;

const IDLE: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'idle' });
const RESOLVING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'resolving' });
const CHOOSING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'choosing' });
const STARTING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'starting' });

function unavailable(
    reason: TriageEntrySessionStartUnavailableReasonV1,
    failure?: TriageNewSessionFailureV1,
): TriageEntrySessionStartPhaseV1 {
    return Object.freeze({ kind: 'unavailable', reason, ...(failure === undefined ? {} : { failure }) });
}

/** Refuse incoherent configuration or a missing task before any effect. */
export function triageActionImmediateRefusalV1(
    action: Pick<TriageActionV1, 'target' | 'workspaceMode' | 'appliesTo'>,
    humanPrompt?: string,
): TriageEntrySessionStartUnavailableReasonV1 | null {
    if (requiresTriageActionInstructionV1(action.target)
        && !hasTriageActionInstructionSourceV1(action.target, humanPrompt)) {
        return 'instructionMissing';
    }
    return isTriageActionConfigurationCoherentV1(action, humanPrompt)
        ? null
        : 'preparedWorkspaceUnsupported';
}

/**
 * Name the refused reference and why, in the four combinations the resolver
 * produces. Which catalog and which failure are both material: one needs the
 * configuration repaired, the other needs another try.
 */
function referenceRefusal(
    refusal: Exclude<TriageActionReferencesV1, Readonly<{ status: 'resolved' }>>,
): TriageEntrySessionStartUnavailableReasonV1 {
    if (refusal.reference === 'profile') {
        return refusal.status === 'referenceMissing' ? 'profileMissing' : 'profileUnavailable';
    }
    if (refusal.status === 'referenceInvalid') return 'promptInvalid';
    return refusal.status === 'referenceMissing' ? 'promptMissing' : 'promptUnavailable';
}

export type TriageEntrySessionStartOptionsV1 = Readonly<{
    mintCreationKey?: TriageSessionCreationKeyMintV1;
}>;

export type TriageStartHostV1 = TriageSessionStartHostV1
    & TriageNewSessionSeedHostV1
    & TriageProjectRegistryHostV1
    & TriageAgentInventoryHostV1
    & TriageActionResolutionHostV1
    & Readonly<{
        readSession?: PluginClientActionUi['readSession'];
        selectActionInput(
            request: SelectActionInputRequest,
            options?: PluginUiActionExecutionOptions,
        ): Promise<SelectActionInputResult>;
    }>;

/** The exact semantic materialization request a prepared start is authorized for. */
type TriagePreparedReviewRequestV1 = Parameters<typeof projectTriagePrepareReviewWorkspaceInputV1>[0];
type TriagePreparedReviewOperationV1 =
    NonNullable<TriageEntrySessionStartRequestV1['reviewWorkspace']>['operation'];

/**
 * The one authorization a prepared-review start travels with, and the only
 * place it is asked for.
 *
 * The host settles the source's raw input and releases that settlement before
 * the outer Action leaves (`hostedWebAdapter.ts`, `reactNative/hostApi.ts`, CLI
 * `actions.ts`), so a carrier is spent by the dispatch that consumed it and can
 * never be replayed. Asking the SAME question again for the SAME retained
 * request is a different thing, and it is the only way a start whose response
 * was lost can reach its preparation owner again: preparation runs INSIDE the
 * start Action, so without a carrier the orchestrator refuses the workspace and
 * a recovery could never rejoin what the first press may already have created.
 */
type TriagePreparedStartAuthorizationV1 =
    | Readonly<{
        status: 'authorized';
        selection: NonNullable<TriageStartEntrySessionInputV1['prepareReviewWorkspaceSelection']>;
        options: PluginUiActionExecutionOptions;
    }>
    /** The reader closed the source's selection surface. */
    | Readonly<{ status: 'cancelled' }>
    /** It settled something no start can be authorized by. */
    | Readonly<{ status: 'unavailable' }>;

export async function authorizeTriagePreparedReviewWorkspaceV1(
    host: Pick<TriageStartHostV1, 'selectActionInput'>,
    operation: TriagePreparedReviewOperationV1,
    request: TriagePreparedReviewRequestV1,
    options?: PluginUiActionExecutionOptions,
): Promise<TriagePreparedStartAuthorizationV1> {
    const selected = await host.selectActionInput({
        operation,
        draft: projectTriagePrepareReviewWorkspaceInputV1(request),
    }, options);
    if (selected.kind === 'cancelled') return { status: 'cancelled' };
    if (selected.kind !== 'submitted'
        || (selected.connectedAccount.kind === 'none' && 'account' in request.instance.binding)) {
        return { status: 'unavailable' };
    }
    return {
        status: 'authorized',
        selection: {
            selection: selected.selection,
            input: selected.input,
            ...(selected.connectedAccount.kind === 'selected' ? { credentialRef: selected.connectedAccount.ref } : {}),
        },
        // The selected source operation is consumed exactly once by the outer
        // start Action's canonical materialization owner.
        options: {
            selectedActionInput: { operation, result: selected },
            consumeSelectedActionInput: true,
        } as PluginUiActionExecutionOptions,
    };
}

/**
 * The retained request a prepared start must be authorized for again, when it
 * is that kind of start. Its bytes are the original ones: a recovery repeats
 * the settled destination, never a re-resolved one.
 */
function retainedPreparedRequest(
    input: TriageStartEntrySessionInputV1,
): TriagePreparedReviewRequestV1 | null {
    return input.destination.kind === 'new'
        && input.destination.materialization.kind === 'reviewWorkspace'
        ? input.destination.materialization.request
        : null;
}

/**
 * Custody never keeps a spent authorization carrier. It is consumed by the one
 * dispatch it travelled with, so retaining it could only ever produce a replay.
 */
function retainedStartInput(
    input: TriageStartEntrySessionInputV1,
): TriageStartEntrySessionInputV1 {
    if (input.prepareReviewWorkspaceSelection === undefined) return input;
    const { prepareReviewWorkspaceSelection: _spent, ...retained } = input;
    return retained;
}

/**
 * The minimal mounted fact a retry needs, and nothing more.
 *
 * A press that answered `creationPending`, `linkPending` or `openPending` left
 * something real behind: a creation the daemon may already have settled, a
 * Session with no link, or a linked Session that did not open. So did a press
 * whose own response never came back at all — the Action was emitted either
 * way — which is why this is taken before the dispatch rather than from its
 * result. The header's
 * notice has been telling readers that pressing again resumes the same Session
 * — and until this ref existed that was simply untrue, because every press
 * minted a fresh creation key and a fresh delivery key, so a second press
 * created a SECOND Session and queued a SECOND Message.
 *
 * It retains the exact Action input the first press submitted, so a retry
 * re-sends the same creation key, the same delivery key and the same
 * destination. There is no durable retry table, no attempt ordinal and no
 * second retry coordinator: the canonical creator's creation key, the
 * idempotent link and the Session-input idempotency key are what make repeating
 * a phase safe, and this is only the memory of which identity to repeat.
 */
type TriageEntrySessionStartCustodyV1 = Readonly<{
    /** Which press this belongs to; a different action or entry starts fresh. */
    actionId: string;
    input: TriageStartEntrySessionInputV1;
    /**
     * The phase the settled start stopped at, when it stopped at one.
     *
     * Absent is the OTHER thing this ref remembers, and the two are not the
     * same: no phase came back at all, so what the dispatch did remains
     * unknown. A phase resumes itself; an unknown outcome repeats the whole
     * request under the retained identity.
     */
    pending?: NonNullable<TriageStartEntrySessionInputV1['resume']>;
    /** Resolved once from the configured review action; link/open retry reuses it. */
    reviewInstructions?: string;
}>;

/**
 * The delivery verdict the start reported, for the two arms that can carry one.
 *
 * A `linkPending` never delivered — nothing is sent into a Session this entry is
 * not linked to — so it reads as nothing placed rather than as a refusal.
 */
function readSendStatus(
    result: TriageStartEntrySessionResultV1,
): Extract<TriageEntrySessionDeliveryOutcomeV1, Readonly<{ kind: 'send' }>>['status'] {
    return result.type === 'opened' || result.type === 'openPending' || result.type === 'linked'
        ? result.delivery
        : 'none';
}

export function createTriageEntrySessionStartController(
    host: TriageStartHostV1,
    options?: TriageEntrySessionStartOptionsV1,
): Readonly<{ getSnapshot: () => TriageEntrySessionStartControllerV1; getRecovery: () => TriageSingleStartRecoveryV1 | null; restore: (recovery: TriageSingleStartRecoveryV1) => void; subscribe: (listener: () => void) => () => void; activate: () => void; dispose: () => void; waitForSettled: () => Promise<TriageEntrySessionStartControllerV1> }> {
    let phase: TriageEntrySessionStartPhaseV1 = IDLE;
    let authoringResult: 'seeded' | 'cancelled' | undefined;
    const listeners = new Set<() => void>();
    let snapshot: TriageEntrySessionStartControllerV1;
    const notify = () => { snapshot = readSnapshot(); for (const listener of listeners) listener(); };
    const setPhase = (value: TriageEntrySessionStartPhaseV1) => { phase = value; notify(); };
    let review: TriagePendingPullRequestReviewV1 | null = null;
    const setReview = (value: TriagePendingPullRequestReviewV1 | null) => { review = value; notify(); };
    // Read synchronously by `start`, so two presses in one tick cannot both pass
    // the gate the way a state read would.
    const inFlight = ({ current: false } as { current: boolean });
    const retired = ({ current: false } as { current: boolean });
    // Input selectors are host presentations borrowed by this controller, not independent pending work.
    let selectionLifetime = new AbortController();
    // The one identity a retry repeats. Scoped to this mount, like every other
    // fact here: a Session the user navigates back to is reached through its
    // link, not through a remembered start.
    const custody = ({ current: null } as { current: TriageEntrySessionStartCustodyV1 | null });
    // Absent options resolve to the one module-level default, so the ordinary
    // caller keeps a referentially stable `start`.
    const mintCreationKey = options?.mintCreationKey ?? mintRandomCreationKey;

    /**
     * Where this press should run, resolved once, in the one stated order
     * (`PLAN.md` §0a A8): the action's workspace requirement, then the
     * profile's preference, then the reachable candidates.
     *
     * It answers with the WHOLE placement decision — resolved machine and path,
     * or every candidate the reader still has to choose between. Carrying only the directory
     * left the machine to whoever stamped it next, which paired a checkout
     * resolved on one machine with an execution target on another and started
     * an agent at a path that does not exist there.
     *
     * `registryComplete` is forwarded rather than assumed: exactly one reachable
     * checkout in a PAGE of the project registry is not exactly one in the
     * registry, and the row that would have made the answer ambiguous may simply
     * not have been sent.
     */
    const resolvePlacement = async (
        request: TriageEntrySessionStartRequestV1,
        preferences: Parameters<typeof resolveTriageActionPlacementV1>[0]['profile'],
    ) => {
        return readTriageActionPlacementV1(host, request.action, preferences, request.repository);
    };

    /**
     * Records a send start's verdict and decides whether a retry still has
     * something to resume. Compose returns before this callback is reachable.
     *
     * The delivery half is read from the start's own result rather than
     * re-asked: a `send` already happened, inside the start and before the open,
     * and the canonical send verdict it answered with travels on the
     * result. Reporting anything other than that verdict is how a refusal used
     * to reach the reader as success.
     */
    const settle = async (
        request: TriageEntrySessionStartRequestV1,
        input: TriageStartEntrySessionInputV1,
        result: TriageStartEntrySessionResultV1,
        reviewInstructions?: string,
        /**
         * The unresolved identity this dispatch was a recovery for, when it was
         * one. Its first dispatch never answered, so a refusal answered to the
         * SECOND one describes only itself.
         */
        unresolved?: TriageEntrySessionStartCustodyV1,
    ): Promise<void> => {
        // Custody is retained for exactly the arms a retry can resume, and
        // released for every terminal one. A `creationFailed` is terminal by the
        // orchestrator's own rule — no Session id is disclosed — so the next
        // visible press is a new logical request with a new key.
        const retained = retainedStartInput(input);
        const resumable: TriageEntrySessionStartCustodyV1 | null = result.type === 'creationPending'
            ? {
                actionId: request.action.actionId,
                input: retained,
                pending: {
                    phase: 'creationPending',
                    ...(result.preparedReviewWorkspace === undefined
                        ? {}
                        : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
                },
                ...(reviewInstructions === undefined ? {} : { reviewInstructions }),
            }
            : result.type === 'linkPending' || result.type === 'openPending'
                ? {
                    actionId: request.action.actionId,
                    input: retained,
                    pending: {
                        phase: result.type,
                        sessionId: result.sessionId,
                        disposition: result.disposition,
                        // An unknown admission answer is intentionally omitted:
                        // the phase retry invokes the one canonical sender with
                        // the retained public idempotency key. A settled answer
                        // is carried so an open retry cannot send a second time.
                        ...(result.delivery === undefined || result.delivery === 'outcomeUnknown'
                            ? {}
                            : { delivery: result.delivery }),
                        ...(result.preparedReviewWorkspace === undefined
                            ? {}
                            : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
                    },
                    ...(reviewInstructions === undefined ? {} : { reviewInstructions }),
                }
                // The Session opened, but delivery did not settle. The link and
                // stable Session id already exist, so retry only admission and
                // open under the retained public delivery identity.
                : result.type === 'opened'
                    && result.delivery === 'outcomeUnknown'
                    && input.delivery !== undefined
                    ? {
                        actionId: request.action.actionId,
                        input: retained,
                        pending: {
                            phase: 'openPending',
                            sessionId: result.sessionId,
                            disposition: result.disposition,
                            ...(result.preparedReviewWorkspace === undefined
                                ? {}
                                : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
                        },
                        ...(reviewInstructions === undefined ? {} : { reviewInstructions }),
                    }
                : null;

        const sessionId = result.type === 'opened' || result.type === 'openPending' || result.type === 'linked'
            ? result.sessionId
            : null;
        // A result that names the Session, or a phase to resume, answers for the
        // whole logical request: it was created or rejoined, and nothing about
        // it is unknown any more. A result that names neither — a refused
        // preparation, a creation conflict, a mode rejection — answers only for
        // the dispatch that received it, so it can neither release nor speak for
        // an EARLIER dispatch whose own reply never arrived.
        const unresolvedRemains = unresolved !== undefined && !resolvesTriageUnknownSessionStartV1(result);
        // Releasing there is what let the next press mint a second creation key
        // and a second delivery key for a Session and a Message that may exist.
        custody.current = resumable ?? (unresolvedRemains ? unresolved : null);
        if (unresolvedRemains) {
            // ...and reporting that refusal as the verdict is the same mistake
            // told to the reader: every terminal arm's notice says nothing was
            // created, which is precisely what this surface does not know. The
            // honest answer is the one it already has for this exact state, and
            // it is the one whose notice tells them pressing again resumes the
            // same Session rather than starting a second.
            if (!retired.current) {
                setReview(null);
                setPhase(unavailable('startOutcomeUnknown'));
            }
            return;
        }
        const delivery: TriageEntrySessionDeliveryOutcomeV1 = sessionId === null
            ? { kind: 'none' }
            : input.delivery !== undefined
                ? { kind: 'send', status: readSendStatus(result) }
                : { kind: 'none' };
        if (!retired.current) {
            if (request.comparisonDestination !== undefined && result.type === 'linked') {
                const opened = await openLinkedSession({
                    execute: host.executeAction.bind(host), sessionId: result.sessionId,
                    destination: request.comparisonDestination,
                    ...(input.destination.kind === 'new'
                        ? { serverId: input.destination.spawn.executionTarget.serverId } : {}),
                });
                if (retired.current) return;
                if (opened.status === 'failed') {
                    custody.current = { actionId: request.action.actionId, input: retained,
                        pending: { phase: 'openPending', sessionId: result.sessionId,
                            disposition: result.disposition } };
                    // Walk's request has no delivery. Project only the shared
                    // open settlement, not linked-only review/deferred fields.
                    const pending: TriageStartEntrySessionResultV1 = {
                        v: 1, type: 'openPending', sessionId: result.sessionId,
                        disposition: result.disposition, delivery: 'none',
                    };
                    setPhase(Object.freeze({ kind: 'settled',
                        result: pending, delivery }));
                    return;
                }
                custody.current = null;
                const openedResult: TriageStartEntrySessionResultV1 = {
                    v: 1, type: 'opened', sessionId: result.sessionId,
                    disposition: result.disposition, delivery: 'none',
                };
                setPhase(Object.freeze({ kind: 'settled', result: openedResult, delivery }));
                return;
            }
            const pendingReview = result.type === 'linked'
                && result.review !== undefined
                && reviewInstructions !== undefined
                ? {
                    actionId: request.action.actionId,
                    sessionId: result.sessionId,
                    review: result.review,
                    instructions: reviewInstructions,
                    ...(request.comparisonSource === undefined ? {} : { comparisonSource: request.comparisonSource }),
                }
                : null;
            setReview(pendingReview === null ? null : Object.freeze(pendingReview));
            setPhase(Object.freeze({ kind: 'settled', result, delivery }));
        }
    };

    const start = (initialRequest: TriageEntrySessionStartRequestV1, existingSession?: ActionSessionAddressV1) => {
        let request = initialRequest;
        if (inFlight.current || retired.current) return;
        authoringResult = undefined;
        // A Walk requests placement for reading. The reference-only mode is the incumbent
        // no-materialization path; its normal New Session picker still owns machine/Agent choices.
        const action: TriageActionV1 = request.comparisonDestination === undefined ? request.action : {
            ...request.action, workspaceMode: 'reference_only', profileId: null,
            target: { kind: 'agent', delivery: 'compose', promptInvocationId: null },
        };
        // Refused before anything opens. Asking the reader to pick an Agent and
        // a directory for a start this wire cannot carry spends their choice on
        // a refusal they could have been told about first.
        // 0. The arm the action DECLARED, read before anything else and never
        //    inferred from its label (`PLAN.md` §0a A1). This is the whole
        //    point of `target.kind` being a member: until now nothing read it,
        //    so a `reviewStart` action started an ordinary agent Session and
        //    called it a review. `review.start` scopes to the exact commits of
        //    a pull request in a source-prepared worktree. The mounted producer
        //    can request that workspace, but only for the one coherent formal
        //    arm/mode/subject combination admitted by the action owner.
        const immediateRefusal = triageActionImmediateRefusalV1(action, request.orchestrationPrompt);
        if (immediateRefusal !== null) {
            setPhase(unavailable(immediateRefusal));
            return;
        }
        inFlight.current = true;

        if (existingSession !== undefined || request.destinationChoice === 'existingSession') {
            const previous = phase.kind === 'handoffSettled' ? phase.result.recovery : undefined;
            setReview(null);
            setPhase(RESOLVING);
            void (async () => {
                let submitted = false;
                try {
                    let session = existingSession;
                    if (session === undefined) {
                        setPhase(CHOOSING);
                        const choice = await host.selectActionInput(
                            { hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } },
                            { signal: selectionLifetime.signal },
                        );
                        if (retired.current) return;
                        if (choice.kind === 'cancelled') { setPhase(IDLE); return; }
                        if (choice.kind !== 'sessionAddress') { setPhase(unavailable('dispatch')); return; }
                        session = choice.session;
                    }
                    const selected = { entryRef: request.entryRef, sourceInstanceId: request.sourceInstance.sourceInstanceId };
                    const handoff: TriageSessionHandoffInputV1 = {
                        task: request.requestedTask ?? (action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1 ? 'fix' : 'investigate'),
                        configuredActionId: action.actionId,
                        context: { kind: 'entry', entry: selected }, evidence: [{ kind: 'entry', entry: selected }],
                        sessionChoice: { kind: 'existing', session: session.sessionId }, agentChoice: { kind: 'configured' }, delivery: 'configured',
                    };
                    const resumeStart = previous?.state.kind === 'handoff'
                        && previous.state.serverId === session.serverId
                        && JSON.stringify(previous.state.handoff) === JSON.stringify(handoff) ? previous : undefined;
                    setPhase(STARTING);
                    submitted = true;
                    const result = TriageRunConfiguredActionResultV1Schema.parse(await host.executeAction(
                        { pluginId: 'happier.triage', localId: TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 },
                        { v: 1, handoff, ...(resumeStart === undefined ? {} : { resumeStart }) },
                        { signal: selectionLifetime.signal, sessionAddress: session },
                    ));
                    if (!retired.current) setPhase(Object.freeze({ kind: 'handoffSettled', result }));
                } catch {
                    if (!retired.current) setPhase(unavailable(submitted ? 'handoffOutcomeUnknown' : 'dispatch'));
                } finally {
                    inFlight.current = false;
                    notify();
                }
            })();
            return;
        }

        // A retry of the SAME press on the SAME entry. Everything the first
        // press resolved — its references, its placement, the destination the
        // reader settled on — is already decided, so re-deciding it would spend
        // their choice again and mint a second identity for one Session. It goes
        // straight back to the start Action with the retained input, plus the
        // phase to resume when the first press stopped at one.
        const retained = custody.current;
        if (retained && retained.actionId === action.actionId && sameTriageEntryReference(retained.input.entryRef, request.entryRef)) {
            setPhase(STARTING);
            void (async () => {
                try {
                    // A phase the first start actually reported resumes as that
                    // phase. Its preparation already ran and the owner echoed
                    // the facts back, so nothing is authorized a second time —
                    // and the consumed carrier is never replayed, here or below.
                    if (retained.pending !== undefined) {
                        const resumed = await submitTriageEntrySessionStart(
                            host,
                            { ...retained.input, resume: retained.pending },
                        );
                        await settle(request, retained.input, resumed, retained.reviewInstructions);
                        return;
                    }

                    // No phase came back at all: this is the recovery of a
                    // dispatch whose own response was lost. The retained
                    // destination, creation key and delivery key are repeated
                    // exactly, and only a prepared-review start needs anything
                    // more — its preparation runs inside the start Action, so
                    // without a current authorization the orchestrator refuses
                    // the workspace and the recovery could never reach the
                    // canonical creator's rejoin at all.
                    const prepared = retainedPreparedRequest(retained.input);
                    let input = retained.input;
                    let options: PluginUiActionExecutionOptions | undefined;
                    if (prepared !== null) {
                        const operation = request.reviewWorkspace?.operation;
                        if (operation === undefined) {
                            // Nothing reachable can authorize the retained
                            // request, and the first dispatch's outcome is still
                            // unknown. Custody stays: saying "nothing was
                            // started" would be a claim this surface cannot make.
                            if (!retired.current) setPhase(unavailable('startOutcomeUnknown'));
                            return;
                        }
                        setPhase(CHOOSING);
                        const authorization = await authorizeTriagePreparedReviewWorkspaceV1(
                            host,
                            operation,
                            prepared,
                            { signal: selectionLifetime.signal },
                        );
                        if (retired.current) return;
                        if (authorization.status !== 'authorized') {
                            // Cancelling or refusing a RECOVERY answers only the
                            // recovery. Returning to idle would say nothing was
                            // started, and releasing the retained keys would let
                            // the next press mint a second identity.
                            setPhase(unavailable('startOutcomeUnknown'));
                            return;
                        }
                        input = {
                            ...retained.input,
                            prepareReviewWorkspaceSelection: authorization.selection,
                        };
                        options = authorization.options;
                        setPhase(STARTING);
                    }
                    const result = await submitTriageEntrySessionStart(host, input, options);
                    await settle(request, retained.input, result, retained.reviewInstructions, retained);
                } catch {
                    // Custody is deliberately left in place: this retry left
                    // too, so the next press repeats the same identity again.
                    if (!retired.current) setPhase(unavailable('startOutcomeUnknown'));
                } finally {
                    inFlight.current = false;
                notify();
                }
            })();
            return;
        }

        setPhase(RESOLVING);
        void (async () => {
            // Whether the start Action itself left this surface. Everything
            // before it — the two catalog reads, the placement read, the host's
            // New Session surface, the source selection — genuinely starts
            // nothing when it throws, and saying so remains truthful.
            let submitted = false;
            try {
                if (request.comparisonDestination !== undefined && request.linkedSessionIds?.length) {
                    const registry = await readTriageProjectRegistryV1(host);
                    if (retired.current) return;
                    for (const sessionId of request.linkedSessionIds) {
                        let state: SessionStateV1 | null;
                        try { state = await host.readSession?.(sessionId) ?? null; } catch { continue; }
                        if (retired.current) return;
                        const linked = resolveTriageLinkedSessionPlacementV1({
                            sessionId, serverId: state?.serverId, workspace: state?.workspace,
                            projects: registry.status === 'read' ? registry.projects : [],
                        });
                        if (linked === null) continue;
                        const opened = await openLinkedSession({
                            execute: host.executeAction.bind(host), ...linked, destination: request.comparisonDestination,
                        });
                        if (retired.current) return;
                        setPhase(opened.status === 'opened' ? IDLE : unavailable('dispatch'));
                        return;
                    }
                }
                // 1. BOTH references, resolved before any side effect. A
                //    configured reference that cannot be honoured refuses the
                //    press here — never after a Session exists, and never by
                //    quietly degrading to the default the person configured
                //    away from.
                const references = request.resolvedReferences ?? await resolveTriageActionReferencesV1(host, action);
                if (retired.current) return;
                if (references.status !== 'resolved') {
                    setPhase(unavailable(referenceRefusal(references)));
                    return;
                }
                if (action.workspaceMode === 'pull_request' && request.reviewWorkspace === undefined
                    && request.sourceContributions !== undefined) {
                    // A list row can omit exact revisions. Acquire them through the same source
                    // get/detail owner as bulk and configured starts, only when this press needs them.
                    const facts = await readTriageEntrySessionFactsV1(host, {
                        entryRef: request.entryRef, sourceInstanceId: request.sourceInstance.sourceInstanceId,
                        ...(request.lastKnownLocator === undefined ? {} : { lastKnownLocator: request.lastKnownLocator }),
                    }, request.sourceContributions, selectionLifetime.signal);
                    if (retired.current) return;
                    if (selectionLifetime.signal.aborted) { setPhase(IDLE); return; }
                    if (facts?.reviewWorkspace === undefined) {
                        setPhase(unavailable('preparedWorkspaceUnsupported', { codes: ['preparedWorkspaceUnsupported'] }));
                        return;
                    }
                    request = { ...request, ...facts };
                }
                const preferences = references.profile?.preferences;
                const promptText = request.orchestrationPrompt ?? resolveTriageActionInstructionV1(
                    action,
                    references.prompt?.text ?? null,
                    request.requestedTask === undefined ? undefined : { task: request.requestedTask, context: 'entry' },
                );
                if (action.target.kind === 'reviewStart') {
                    if (action.workspaceMode !== 'pull_request' || request.reviewWorkspace === undefined) {
                        setPhase(unavailable('preparedWorkspaceUnsupported'));
                        return;
                    }
                }

                // 2. Placement, in the one stated precedence.
                const preference = request.preference ?? {};
                const placement = preference.directory
                    ? null
                    : await resolvePlacement({ ...request, action }, preferences);
                if (retired.current) return;

                // 3. The one-click launch (`PLAN.md` §0a A5). A resolved place
                //    to run plus a profile whose Agent the host inventory
                //    resolves is a COMPLETE start: every member the wire needs
                //    is known, so opening the New Session surface would ask the
                //    reader to confirm the two facts their own configuration
                //    already stated. Anything less — no directory, no profile,
                //    an Agent the catalogue cannot resolve, several candidates,
                //    an unreachable one, or a registry that admitted it was
                //    partial — opens the surface with what IS known seeded.
                //    That degradation is the feature, not a failure path.
                //
                //    The profile's CHECKOUT preference is part of "complete".
                //    A one-click launch reuses the resolved checkout (or the
                //    source-prepared review checkout its start Action carries),
                //    so it can only answer `reuseWorkspace`, `none` and
                //    `preparedReviewWorkspace`; `createWorktree`
                //    and `ask` are answers this wire cannot give — it carries no
                //    worktree creation (`actions/entrySessionProtocol.ts`) and
                //    `ask` asked for the screen. Launching anyway would do
                //    something other than what the profile's author configured,
                //    silently, which is the failure this whole vertical exists
                //    to stop. Precedence is unchanged (§0a A8): the action's
                //    mode still decides the requirement, and the profile only
                //    chooses among the ways `repository` can be met.
                const checkout = resolveTriageActionCheckoutV1(action.workspaceMode, preferences);
                const executionPlacement = placement === null
                    ? null
                    : readTriageActionExecutionPlacementV1(placement);
                const explicitAgent = request.resolvedAgentTarget === undefined
                    ? request.preferredAgentTargetKey === undefined ? null
                        : await readTriageAgentExecutionTargetV1(host, request.preferredAgentTargetKey)
                    : { status: 'resolved' as const, agentTarget: request.resolvedAgentTarget };
                if (request.preferredAgentTargetKey !== undefined && explicitAgent?.status !== 'resolved') {
                    setPhase(unavailable('newSessionUnavailable'));
                    return;
                }

                // A complete start: an explicit settlement, or the profile's Agent
                // plus a resolved directory with a checkout this wire can launch.
                // A prepared review checkout is launchable: the start Action
                // carries its source preparation.
                const composes = request.comparisonDestination === undefined
                    && action.target.kind === 'agent' && action.target.delivery === 'compose';
                const launchDirectory = readTriageActionLaunchDirectoryV1(executionPlacement, checkout);
                const preferredAgentTargetKey = references.profile?.preferredAgentTargetKey;
                const agent = composes ? explicitAgent
                    : explicitAgent ?? (launchDirectory !== undefined
                        && preferredAgentTargetKey !== undefined
                        ? await readTriageAgentExecutionTargetV1(host, preferredAgentTargetKey)
                        : null);
                if (retired.current) return;
                const directSettlement: unknown = request.settlement
                    ?? (agent?.status === 'resolved' && executionPlacement !== null && launchDirectory !== undefined ? {
                        executionTarget: executionPlacement.executionTarget,
                        agentTarget: agent.agentTarget,
                        directory: launchDirectory,
                    } : undefined);

                // Compose is authoring, not Session creation, and so is every
                // agent action whose start is not complete — send, formal
                // review, Walk through and orchestration alike (owner rulings
                // "Agent actions: one shared flow", 2026-11-07, and 16:50Z):
                // hand the resolved profile, prompt, placement and entry
                // attachment to the host's incumbent New Session composer and
                // stop. That screen owns all subsequent edits and the eventual
                // send; closing it creates no Session, link or Message and
                // spends no creation key.
                if (composes || directSettlement === undefined) {
                    const placementCandidates = placement === null ? [] : projectTriageActionPlacementCandidatesV1(placement);
                    setPhase(CHOOSING);
                    const seeded = await requestTriageNewSessionAuthoringV1(host, {
                        entries: [request], promptText, profileId: action.profileId,
                        actionDefault: triageActionDefaultSeedV1(action),
                        attachments: request.forgeEvidence === undefined ? [] : [buildTriageForgeEvidenceAttachmentDraftV1(request.forgeEvidence)],
                        ...(explicitAgent?.status === 'resolved' ? { agentTarget: explicitAgent.agentTarget } : {}),
                        checkoutIntent: checkout, placement: executionPlacement, candidates: placementCandidates,
                        signal: selectionLifetime.signal,
                        isCurrent: () => !retired.current,
                    });
                    if (retired.current) return;
                    if (seeded.status === 'seeded' || seeded.status === 'cancelled') authoringResult = seeded.status;
                    setPhase(seeded.status === 'seeded' || seeded.status === 'cancelled'
                        ? IDLE
                        : unavailable(seeded.status === 'refused' ? 'preparedWorkspaceUnsupported' : seeded.status === 'unsupported'
                            ? 'newSessionUnsupported'
                            : 'newSessionUnavailable', seeded.status === 'unavailable' ? seeded.failure : undefined));
                    return;
                }

                // A direct start is admitted by the same destination grammar as
                // the host's own settlement.
                const settlement = directSettlement;
                const placementCandidates = placement === null
                    ? undefined
                    : projectTriageActionPlacementCandidatesV1(placement);
                const destination = projectTriageNewSessionDestinationV1({
                    workspaceMode: action.workspaceMode,
                    creationKey: mintCreationKey(),
                    settlement,
                    ...(action.profileId === null ? {} : { profileId: action.profileId }),
                    ...(action.workspaceMode === 'pull_request'
                        ? { reviewWorkspace: request.reviewWorkspace!.preparation }
                        : {}),
                    ...(placementCandidates === undefined ? {} : { placementCandidates }),
                });
                if (destination.status === 'refused') {
                    setPhase(unavailable(destination.reason === 'preparedWorkspaceUnsupported'
                        ? 'preparedWorkspaceUnsupported'
                        : 'newSessionUnavailable'));
                    return;
                }
                let startOptions: PluginUiActionExecutionOptions | undefined;
                let reviewInstructions: string | undefined;
                let prepareReviewWorkspaceSelection:
                    | TriageStartEntrySessionInputV1['prepareReviewWorkspaceSelection']
                    | undefined;
                if (action.workspaceMode === 'pull_request') {
                    if (destination.destination.kind !== 'new'
                        || destination.destination.materialization.kind !== 'reviewWorkspace') {
                        setPhase(unavailable('preparedWorkspaceUnsupported'));
                        return;
                    }
                    const authorization = await authorizeTriagePreparedReviewWorkspaceV1(
                        host,
                        request.reviewWorkspace!.operation,
                        destination.destination.materialization.request,
                        { signal: selectionLifetime.signal },
                    );
                    if (retired.current) return;
                    if (authorization.status === 'cancelled') {
                        // Nothing has left this surface yet, so this cancellation
                        // genuinely started nothing and spends no identity.
                        setPhase(IDLE);
                        return;
                    }
                    if (authorization.status !== 'authorized') {
                        setPhase(unavailable('preparedWorkspaceUnsupported'));
                        return;
                    }
                    prepareReviewWorkspaceSelection = authorization.selection;
                    startOptions = authorization.options;
                    if (action.target.kind === 'reviewStart') reviewInstructions = promptText!;
                }
                setPhase(STARTING);
                // 3. A send travels with the start so it settles between link
                //    and open. Compose returned above before anything existed.
                const input: TriageStartEntrySessionInputV1 = {
                    v: 1,
                    workspaceMode: action.workspaceMode,
                    entryRef: request.entryRef,
                    sourceInstanceId: request.sourceInstance.sourceInstanceId,
                    display: request.display,
                    destination: destination.destination,
                    ...(request.orchestrationPrompt === undefined ? {} : { orchestrate: true as const }),
                    ...(prepareReviewWorkspaceSelection === undefined
                        ? {}
                        : { prepareReviewWorkspaceSelection }),
                    ...(action.target.kind === 'reviewStart' || request.comparisonDestination !== undefined
                        ? { finalOpen: 'deferred' as const } : {}),
                    ...(request.comparisonDestination === undefined && action.target.kind === 'agent' && action.target.delivery === 'send'
                        ? {
                            delivery: {
                                kind: 'send' as const,
                                ...(promptText === null || promptText.trim().length === 0
                                    ? {}
                                    : { text: promptText }),
                                attachments: [{
                                    entryRef: request.entryRef,
                                    display: request.display,
                                    sourceInstanceId: request.sourceInstance.sourceInstanceId,
                                    title: request.presentation.label,
                                }],
                                idempotencyKey: mintCreationKey(),
                                ...(request.requestedTask === undefined ? {} : { returnResult: true as const }),
                                ...(request.forgeEvidence === undefined ? {} : { forgeEvidence: request.forgeEvidence }),
                            },
                        }
                        : {}),
                };
                // Custody is taken BEFORE the outward dispatch, not from the
                // settled result. The whole logical request — its creation key,
                // its delivery idempotency key and its settled destination — is
                // decided by now, and the one response that can go missing is
                // this one. Retaining it only afterwards meant a lost reply left
                // nothing behind, so the next press resolved everything again
                // and minted a SECOND creation key and a SECOND delivery key for
                // the Session and Message the first press may already have made.
                custody.current = {
                    actionId: action.actionId,
                    input: retainedStartInput(input),
                    ...(reviewInstructions === undefined ? {} : { reviewInstructions }),
                };
                submitted = true;
                const result = await submitTriageEntrySessionStart(host, input, startOptions);
                await settle(request, input, result, reviewInstructions);
            } catch (error) {
                if (!retired.current) {
                    setPhase(unavailable(submitted ? 'startOutcomeUnknown' : 'dispatch', projectTriageNewSessionFailureV1(error)));
                }
            } finally {
                inFlight.current = false;
                notify();
            }
        })();
    };

    const reset = () => {
        authoringResult = undefined;
        setReview(null);
        setPhase(IDLE);
    };

    const waitForSettled = () => inFlight.current ? new Promise<TriageEntrySessionStartControllerV1>((resolve) => {
        const listener = () => { if (!inFlight.current) { listeners.delete(listener); resolve(snapshot); } };
        listeners.add(listener);
    }) : Promise.resolve(snapshot);

    const startInSession: TriageEntrySessionStartControllerV1['startInSession'] = async (request, session) => {
        if (inFlight.current || retired.current) return null;
        start(request, session);
        const settled = await waitForSettled();
        return settled.phase.kind === 'handoffSettled' ? settled.phase.result : null;
    };

    const readSnapshot = (): TriageEntrySessionStartControllerV1 => Object.freeze({
        phase, review, start, startInSession, reset, ...(authoringResult === undefined ? {} : { authoringResult }),
        pendingOrchestrationPrompt: custody.current?.input.orchestrate === true
            ? custody.current.input.delivery?.text ?? null : null,
    });
    snapshot = readSnapshot();
    return Object.freeze({
        getSnapshot: () => snapshot,
        getRecovery: (): TriageSingleStartRecoveryV1 | null => custody.current === null ? null : {
            kind: 'single', actionId: custody.current.actionId,
            input: { ...custody.current.input,
                ...(custody.current.pending === undefined ? {} : { resume: custody.current.pending }) },
            ...(custody.current.reviewInstructions === undefined ? {} : { reviewInstructions: custody.current.reviewInstructions }),
        },
        restore: (recovery) => {
            if (inFlight.current) return;
            const { resume, ...input } = retainedStartInput(recovery.input);
            custody.current = { actionId: recovery.actionId, input,
                ...(resume === undefined ? {} : { pending: resume }),
                ...(recovery.reviewInstructions === undefined ? {} : { reviewInstructions: recovery.reviewInstructions }),
            };
        },
        activate: () => {
            retired.current = false;
            if (selectionLifetime.signal.aborted) selectionLifetime = new AbortController();
        },
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose: () => { retired.current = true; selectionLifetime.abort(); listeners.clear(); },
        waitForSettled,
    });
}
