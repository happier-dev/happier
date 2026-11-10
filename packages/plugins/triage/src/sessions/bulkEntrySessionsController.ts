import type { PluginUiHostApi, PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { buildQualifiedPluginContributionKey, PluginError } from '@happier-dev/plugin-sdk';

import { sameTriageEntryReference } from '../corpus/identity/components.js';
import type { TriageStartEntrySessionInputV1, TriageStartEntrySessionResultV1 } from '../actions/entrySessionProtocol.js';
import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 } from '../actions/entrySessionProtocol.js';
import type { TriageConfiguredStartRecoveryV1, TriageLegacyRunConfiguredActionResultV1 as TriageRunConfiguredActionResultV1 } from '../actions/configuredActionRunProtocol.js';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { mintTriageOpaqueIdV1 } from '../opaqueId.js';
import { resolvesTriageUnknownSessionStartV1 } from '../ui/header/sessionStartOutcome.js';
import { canShareTriageNewSessionCheckoutV1, triageActionDefaultSeedV1, requestTriageNewSessionAuthoringV1 } from './newSessionAuthoring.js';
import { readTriageEntrySessionFactsV1 } from './readEntrySessionFacts.js';
import {
    readTriageActionExecutionPlacementV1,
    type TriageActionExecutionPlacementV1,
    type TriageActionPlacementV1,
    resolveTriageActionCheckoutV1,
    resolveTriageActionPlacementV1,
} from '../sessions/actionLaunch.js';
import {
    resolveTriageActionInstructionV1,
    resolveTriageActionReferencesV1,
    resolveTriageConfiguredActionForExecutionV1,
    type TriageActionReferencesV1,
    type TriageActionResolutionHostV1,
} from '../sessions/actionResolution.js';
import {
    readTriageProjectRegistryV1,
    type TriageProjectRegistryHostV1,
} from '../sessions/projectCandidates.js';
import {
    hasTriageActionInstructionSourceV1,
    requiresTriageActionInstructionV1,
    planTriageOfferedActionsV1,
    type TriageActionV1,
} from '../settings/actions.js';
import {
    projectTriageSessionPlacementCandidateV1,
    projectTriageNewSessionDestinationV1,
    triageNewSessionDraftSeedV1,
} from '../ui/header/newSessionDestination.js';
import {
    requestTriageNewSessionDraft,
    type TriageNewSessionDraftHostV1,
} from '../ui/header/newSessionDraftCommand.js';
import {
    type TriageNewSessionSeedHostV1,
} from '../ui/header/newSessionSeedCommand.js';
import type { TriageBulkSelectedEntryV1 } from '../ui/list/bulkSelectionEntries.js';
import {
    isTriageBulkEntryOutcomeIncompleteV1,
    projectTriageBulkSeedOutcomesV1,
    type TriageBulkEntryOutcomeV1,
} from '../ui/list/bulkSessionOutcome.js';
import {
    planTriageBulkEntrySessions,
    type TriageBulkActionRefusalV1,
    type TriageBulkEntrySelectionV1,
    type TriageBulkSessionDestinationV1,
    type TriageBulkSessionUnitResultV1,
} from '../ui/list/bulkSessionPlan.js';
import {
    runTriageBulkEntrySessionStartsV1,
    projectTriageBulkEntrySessionStartInputV1,
    type TriageBulkSessionExecutionHostV1,
} from '../ui/list/bulkEntrySessionExecution.js';

/**
 * One bulk press, from a selection to Sessions.
 *
 * It owns the SEQUENCE and nothing else. Every decision inside it already has
 * an owner and is reached through that owner: the action record's five answers
 * (`settings/actions.ts`), the profile and prompt reads
 * (`sessions/actionResolution.ts`), the placement precedence
 * (`sessions/actionLaunch.ts`), the fan-out and its per-Session creation keys
 * (`ui/list/bulkSessionPlan.ts`), the workspace-mode gate, creation, link and
 * open (`sessions/entrySessionOrchestrator.ts`), and what a delivery places
 * (`sessions/actionDelivery.ts`). Nothing here mints an id, names an agent,
 * chooses a directory or re-decides a materialization.
 *
 * **The action's profile and prompt are resolved ONCE, for the press**
 * (`PLAN.md` §0a A6). Placement is resolved at the Session boundary instead:
 * a shared destination settles once, while one-per-entry settles each unit
 * against that entry's own candidates before any Session starts. Those are
 * transient host-owned choices, not a Triage draft store, and each unit still
 * carries its OWN creation key.
 *
 * A press that arrives while one is in flight is ignored rather than queued,
 * for the same reason a single-entry press is: two presses of one action are
 * one request, and admitting the second would mint a second set of creation
 * keys for Sessions the first is creating.
 *
 * A direct destination travels on the start as one idempotent structured input
 * when Prompt Library or a shipped fallback supplied an actual instruction,
 * even when the selected action's single-entry default was `compose`. Its
 * attachment array contains every entry in the unit; delivery remains inside
 * the canonical start/link/send owner, before bulk-owned final navigation.
 */

export type TriageBulkSessionOutcomeV1 = TriageBulkSessionUnitResultV1<
    Readonly<{
        start: TriageStartEntrySessionResultV1;
        entries: readonly TriageBulkEntryOutcomeV1[];
    }>,
    TriageBulkSelectedEntryV1
>;

export type TriageBulkSessionsPhaseV1 =
    | Readonly<{ kind: 'idle' }>
    /** The action's profile, prompt and placement are being resolved. */
    | Readonly<{ kind: 'resolving' }>
    /** The host's New Session surface is open and the reader is choosing. */
    | Readonly<{ kind: 'choosing' }>
    | Readonly<{ kind: 'starting'; started: number; total: number }>
    /** The whole selection was placed on the host's New Session screen. */
    | Readonly<{
        kind: 'seeded';
        outcomes: readonly TriageBulkEntryOutcomeV1[];
        refusals: readonly TriageBulkActionRefusalV1<TriageBulkSelectedEntryV1>[];
    }>
    | Readonly<{
        kind: 'settled';
        results: readonly TriageBulkSessionOutcomeV1[];
        /** The exact List set this result and its same-key retries belong to. */
        selectionKeys: readonly string[];
        /** Selected rows this window could no longer supply a payload for. */
        unavailableKeys: readonly string[];
        refusals: readonly TriageBulkActionRefusalV1<Pick<TriageBulkSelectedEntryV1, 'entryRef'>>[];
    }>
    | Readonly<{ kind: 'unavailable'; reason: TriageBulkUnavailableReasonV1 }>;

/**
 * Why nothing was started.
 *
 * It is this controller's own closed union rather than the single press's,
 * because the two presses can fail at different places: a bulk press has a
 * selection that can empty out, and it has no per-entry arms at all. The
 * REFERENCE refusals are deliberately identical in meaning to the single
 * press's, because they come from the same resolver — a configured profile or
 * prompt that cannot be honoured refuses the press rather than quietly
 * degrading to the default the person configured away from.
 */
export type TriageBulkUnavailableReasonV1 =
    | 'reviewStartUnsupported'
    | 'preparedWorkspaceUnsupported'
    | 'newSessionUnsupported'
    | 'newSessionUnavailable'
    | 'checkoutRequiresNewSessionAuthoring'
    | 'sharedPlacementIncompatible'
    /** The action names a profile or prompt the catalog no longer holds. */
    | 'profileMissing'
    | 'promptMissing'
    | 'promptInvalid'
    | 'instructionMissing'
    /** The catalog did not answer; the reference may well still be good. */
    | 'profileUnavailable'
    | 'promptUnavailable'
    | 'dispatch'
    /** Every selected row lost its connection or its observation. */
    | 'noEntriesAvailable';

function referenceRefusal(
    references: Exclude<TriageActionReferencesV1, Readonly<{ status: 'resolved' }>>,
): TriageBulkUnavailableReasonV1 {
    const missing = references.status === 'referenceMissing';
    if (references.reference === 'profile') return missing ? 'profileMissing' : 'profileUnavailable';
    if (references.status === 'referenceInvalid') return 'promptInvalid';
    return missing ? 'promptMissing' : 'promptUnavailable';
}

export type TriageBulkSessionsControllerV1 = Readonly<{
    phase: TriageBulkSessionsPhaseV1;
    /** Ignored while a press is in flight; otherwise runs exactly one. */
    run: (request: TriageBulkSessionsRequestV1) => void;
    retryable: boolean;
    retry: () => void;
    /**
     * Withdraws the question. Sessions already created keep their outcomes —
     * they exist — and only units that have not started are abandoned.
     */
    cancel: () => Promise<void>;
    reset: () => Promise<void>;
}>;

/** The mounted controls and Action adapter consume the controller's same live phases. */
export function isTriageBulkSessionsPhaseRunningV1(phase: TriageBulkSessionsPhaseV1): boolean {
    return phase.kind === 'resolving' || phase.kind === 'choosing' || phase.kind === 'starting';
}

export function canRetryTriageBulkSessionsForSelectionV1(
    state: Pick<TriageBulkSessionsControllerV1, 'phase' | 'retryable'>,
    selected: ReadonlySet<string>,
): boolean {
    return state.retryable && state.phase.kind === 'settled'
        && selected.size === state.phase.selectionKeys.length
        && state.phase.selectionKeys.every((key) => selected.has(key));
}

export type TriageBulkSessionsRequestV1 = Readonly<{
    /** Each explicit choice reaches the same draft projection as UI selection. */
    settlementForEntries?: (entries: readonly TriageBulkSelectedEntryV1[]) => unknown;
    action: TriageActionV1;
    destination: TriageBulkSessionDestinationV1;
    /** The selection, already projected onto the loaded window, in reader order. */
    entries: readonly (TriageBulkSelectedEntryV1 & Pick<TriageBulkEntrySelectionV1, 'workflowSubject'>)[];
    /** Selected keys the window could not answer for; reported, never hidden. */
    unavailableKeys?: readonly string[];
}>;

const IDLE: TriageBulkSessionsPhaseV1 = Object.freeze({ kind: 'idle' });
const RESOLVING: TriageBulkSessionsPhaseV1 = Object.freeze({ kind: 'resolving' });
const CHOOSING: TriageBulkSessionsPhaseV1 = Object.freeze({ kind: 'choosing' });
const START_ENTRY_ACTION_ID = buildQualifiedPluginContributionKey({ pluginId: 'happier.triage', localId: TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 });

function unavailable(reason: TriageBulkUnavailableReasonV1): TriageBulkSessionsPhaseV1 {
    return Object.freeze({ kind: 'unavailable', reason });
}

export function isTriageBulkSessionOutcomeRetryableV1(
    result: TriageBulkSessionOutcomeV1,
): boolean {
    if (result.status !== 'settled') return true;
    const start = result.outcome.start;
    // The start owner explicitly makes these terminal. Reusing their creation
    // key would turn the Retry affordance into a contradiction of the result;
    // a new visible bulk press is the new logical request that mints new keys.
    if (start.type === 'creationFailed' || start.type === 'rejected') return false;
    if (start.type === 'workspacePreparationFailed') return start.retryable;
    if (start.type === 'creationPending'
        || start.type === 'linkPending'
        || start.type === 'openPending') return true;
    return result.outcome.entries.some(isTriageBulkEntryOutcomeIncompleteV1);
}

export function readTriageBulkRetryUnitsV1(
    results: readonly TriageBulkSessionOutcomeV1[],
): readonly TriageBulkSessionOutcomeV1['unit'][] {
    return Object.freeze(results
        .filter(isTriageBulkSessionOutcomeRetryableV1)
        .map((result) => result.unit));
}

export function mergeTriageBulkRetryResultsV1(
    previous: readonly TriageBulkSessionOutcomeV1[],
    retried: readonly TriageBulkSessionOutcomeV1[],
): readonly TriageBulkSessionOutcomeV1[] {
    const replacementByKey = new Map(
        retried.map((result) => [result.unit.creationKey, result] as const),
    );
    return Object.freeze(previous.map((result) => {
        const replacement = replacementByKey.get(result.unit.creationKey);
        if (replacement === undefined) return result;
        // Cancellation and response loss add no information. In particular,
        // they must never erase a Session id or a successfully linked/delivered
        // entry the previous answer already established.
        if (result.status === 'settled' && replacement.status !== 'settled') return result;
        if (result.status === 'unknownOutcome'
            && (replacement.status !== 'settled'
                || !resolvesTriageUnknownSessionStartV1(replacement.outcome.start))) return result;
        if (result.status !== 'settled' || replacement.status !== 'settled') return replacement;
        return Object.freeze({
            ...replacement,
            outcome: Object.freeze({
                start: preferTriageBulkStartResultV1(
                    result.outcome.start,
                    replacement.outcome.start,
                ),
                entries: mergeTriageBulkEntryOutcomesV1(
                    result.outcome.entries,
                    replacement.outcome.entries,
                ),
            }),
        });
    }));
}

function startKnowledgeRank(result: TriageStartEntrySessionResultV1): number {
    if (result.type === 'opened') return 5;
    if (result.type === 'linked') return 4;
    if (result.type === 'openPending') return 3;
    if (result.type === 'linkPending') return 2;
    if (result.type === 'creationPending') return 1;
    return 0;
}

function readStartDelivery(
    result: TriageStartEntrySessionResultV1,
): Extract<
    TriageStartEntrySessionResultV1,
    Readonly<{ type: 'opened' | 'linked' | 'openPending' }>
>['delivery'] | undefined {
    return result.type === 'opened' || result.type === 'linked' || result.type === 'openPending'
        ? result.delivery
        : result.type === 'linkPending'
            ? result.delivery
            : undefined;
}

function deliveryKnowledgeRank(
    delivery: ReturnType<typeof readStartDelivery>,
): number {
    if (delivery === 'accepted' || delivery === 'alreadyAccepted' || delivery === 'held' || delivery === 'replied') return 3;
    if (delivery === 'outcomeUnknown') return 2;
    if (delivery === 'rejected' || delivery === 'failed' || delivery === 'cancelled'
        || delivery === 'none' || delivery === 'notRequested') return 1;
    return 0;
}

function hasKnownTriageBulkSessionV1(
    result: TriageStartEntrySessionResultV1,
): result is Extract<
    TriageStartEntrySessionResultV1,
    Readonly<{ type: 'opened' | 'linked' | 'linkPending' | 'openPending' }>
> {
    return result.type === 'opened'
        || result.type === 'linked'
        || result.type === 'linkPending'
        || result.type === 'openPending';
}

function preferTriageBulkStartResultV1(
    previous: TriageStartEntrySessionResultV1,
    retried: TriageStartEntrySessionResultV1,
): TriageStartEntrySessionResultV1 {
    const previousHasSession = hasKnownTriageBulkSessionV1(previous);
    const retriedHasSession = hasKnownTriageBulkSessionV1(retried);
    if (previousHasSession !== retriedHasSession) {
        // A retry can never erase a known Session id, but a conclusive answer
        // must replace creationPending because that arm established no Session
        // success at all. Otherwise a terminal same-key creation failure would
        // remain visibly retryable forever.
        return retriedHasSession ? retried : previous;
    }
    if (!previousHasSession && !retriedHasSession) return retried;
    const previousRank = startKnowledgeRank(previous);
    const retriedRank = startKnowledgeRank(retried);
    const preferred = retriedRank !== previousRank
        ? retriedRank > previousRank ? retried : previous
        : deliveryKnowledgeRank(readStartDelivery(retried))
            >= deliveryKnowledgeRank(readStartDelivery(previous))
            ? retried
            : previous;
    const previousDelivery = readStartDelivery(previous);
    const retriedDelivery = readStartDelivery(retried);
    const delivery = deliveryKnowledgeRank(retriedDelivery)
        >= deliveryKnowledgeRank(previousDelivery)
        ? retriedDelivery
        : previousDelivery;
    if (delivery === undefined
        || (preferred.type !== 'opened'
            && preferred.type !== 'linked'
            && preferred.type !== 'linkPending'
            && preferred.type !== 'openPending')) return preferred;
    // Phase progress and admission progress are independent facts. A retry may
    // prove that navigation opened while its transport answer is less precise;
    // keep the later phase without erasing an already accepted structured send.
    return Object.freeze({ ...preferred, delivery });
}

function preferKnownValue<T extends string>(
    previous: T,
    retried: T,
    rank: Readonly<Record<T, number>>,
): T {
    return rank[retried] >= rank[previous] ? retried : previous;
}

function mergeTriageBulkEntryOutcomesV1(
    previous: readonly TriageBulkEntryOutcomeV1[],
    retried: readonly TriageBulkEntryOutcomeV1[],
): readonly TriageBulkEntryOutcomeV1[] {
    return Object.freeze(retried.map((candidate) => {
        const known = previous.find((entry) => sameTriageEntryReference(entry.entryRef, candidate.entryRef));
        if (known === undefined) return candidate;
        return Object.freeze({
            ...candidate,
            session: preferKnownValue(known.session, candidate.session, {
                notCreated: 0,
                uncertain: 1,
                existing: 2,
                rejoined: 2,
                created: 2,
            }),
            attachment: preferKnownValue(known.attachment, candidate.attachment, {
                notRequested: 0,
                refused: 1,
                uncertain: 2,
                carried: 3,
            }),
            link: preferKnownValue(known.link, candidate.link, {
                notAttempted: 0,
                conflictedOrUnavailable: 1,
                created: 2,
            }),
            newSessionSeed: preferKnownValue(known.newSessionSeed, candidate.newSessionSeed, {
                notRequested: 0,
                refused: 1,
                applied: 2,
            }),
            directSend: preferKnownValue(known.directSend, candidate.directSend, {
                notRequested: 0,
                refused: 1,
                uncertain: 2,
                applied: 3,
            }),
        });
    }));
}

export type TriageBulkStartRouteV1 =
    | 'direct'
    | 'seedNewSession'
    | 'refusedCheckout'
    | 'refusedCompose';

export function resolveTriageBulkStartRouteV1(
    destination: TriageBulkSessionDestinationV1,
    checkoutIntent: ReturnType<typeof resolveTriageActionCheckoutV1>,
    instruction: string | null,
): TriageBulkStartRouteV1 {
    if (destination === 'attachAllToNewSession') return 'seedNewSession';
    // A direct destination may override the single-entry compose default, but
    // it cannot invent the task. Entry attachments supply facts, not intent;
    // promptless Ask remains on the authoring destination.
    if (instruction === null || instruction.trim().length === 0) return 'refusedCompose';
    return checkoutIntent === 'none' || checkoutIntent === 'reuseWorkspace' || checkoutIntent === 'preparedReviewWorkspace'
        ? 'direct'
        : 'refusedCheckout';
}

type TriageBulkPlacementCandidateV1 = Extract<
    TriageActionPlacementV1,
    Readonly<{ kind: 'prefill' }>
>['candidates'][number];

/**
 * The one placement answer a bulk New Session seed can carry.
 *
 * An exact placement is safe only when every selected entry resolved to that
 * whole server/machine/path tuple. A candidate survives only when every entry
 * named it: taking a union would offer a checkout that belongs to one selected
 * entry as though it were valid for all of them. Candidate placements remain an
 * explicit reader choice; `none` deliberately leaves the incumbent New Session
 * picker in charge rather than guessing a location from part of the selection.
 */
export type TriageBulkSeedPlacementV1 =
    | Readonly<{
        kind: 'exact';
        placement: TriageActionExecutionPlacementV1;
        /** Saved-project evidence remains available when a pin leaves the directory for the reader. */
        candidates: readonly TriageBulkPlacementCandidateV1[];
    }>
    | Readonly<{ kind: 'candidates'; candidates: readonly TriageBulkPlacementCandidateV1[] }>
    | Readonly<{ kind: 'none' }>;

const NO_BULK_SEED_PLACEMENT: TriageBulkSeedPlacementV1 = Object.freeze({ kind: 'none' });

function sameTriageBulkExecutionPlacementV1(
    left: TriageActionExecutionPlacementV1,
    right: TriageActionExecutionPlacementV1,
): boolean {
    return left.directory === right.directory
        && left.directoryIntent?.kind === right.directoryIntent?.kind
        && (left.directoryIntent?.kind !== 'path' || right.directoryIntent?.kind !== 'path'
            || left.directoryIntent.path === right.directoryIntent.path)
        && left.executionTarget.serverId === right.executionTarget.serverId
        && left.executionTarget.machineId === right.executionTarget.machineId;
}

function sameTriageBulkProjectKeyV1(
    left: TriageBulkPlacementCandidateV1['projectKey'],
    right: TriageBulkPlacementCandidateV1['projectKey'],
): boolean {
    if ('projectKey' in left || 'projectKey' in right) {
        return 'projectKey' in left && 'projectKey' in right
            && left.serverId === right.serverId
            && left.projectKey === right.projectKey;
    }
    if ('id' in left || 'id' in right) {
        return 'id' in left && 'id' in right
            && left.serverId === right.serverId
            && left.id === right.id;
    }
    return left.serverId === right.serverId
        && left.machineId === right.machineId
        && left.rootPath === right.rootPath;
}

function sameTriageBulkPlacementCandidateV1(
    left: TriageBulkPlacementCandidateV1,
    right: TriageBulkPlacementCandidateV1,
): boolean {
    return sameTriageBulkProjectKeyV1(left.projectKey, right.projectKey)
        && left.serverId === right.serverId
        && left.machineId === right.machineId
        && left.rootPath === right.rootPath;
}

function candidatesForTriageBulkPlacementV1(
    placement: TriageActionPlacementV1,
): readonly TriageBulkPlacementCandidateV1[] {
    if (placement.kind === 'launch') return [placement.candidate];
    return placement.candidates;
}

function intersectTriageBulkCandidatesV1(
    left: readonly TriageBulkPlacementCandidateV1[],
    right: readonly TriageBulkPlacementCandidateV1[],
): readonly TriageBulkPlacementCandidateV1[] {
    return left.filter((candidate) => right.some((other) => (
        sameTriageBulkPlacementCandidateV1(candidate, other)
    )));
}

/**
 * Reduces the placement-owner answers for every selected entry to the one
 * answer a single New Session surface can honestly receive.
 *
 * This is deliberately pure: registry I/O remains in the mounted controller,
 * while the actual agreement rule is one testable decision rather than a
 * callback-local second placement resolver.
 */
export function resolveTriageBulkSeedPlacementV1(input: Readonly<{
    workspaceMode: TriageActionV1['workspaceMode'];
    preferences?: Parameters<typeof resolveTriageActionPlacementV1>[0]['profile'];
    entries: readonly Pick<TriageBulkSelectedEntryV1, 'repository'>[];
    projects: Parameters<typeof resolveTriageActionPlacementV1>[0]['projects'];
    registryComplete: boolean;
}>): TriageBulkSeedPlacementV1 {
    let agreed: TriageActionExecutionPlacementV1 | null = null;
    let choosing = false;
    let candidates: readonly TriageBulkPlacementCandidateV1[] | null = null;
    for (const entry of input.entries) {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: input.workspaceMode,
            ...(input.preferences === undefined ? {} : { profile: input.preferences }),
            ...(entry.repository === undefined ? {} : { forge: entry.repository }),
            projects: input.projects,
            registryComplete: input.registryComplete,
        });
        const resolved = readTriageActionExecutionPlacementV1(placement);
        if (resolved !== null) {
            if (choosing) return NO_BULK_SEED_PLACEMENT;
            if (agreed === null) {
                agreed = resolved;
            } else if (!sameTriageBulkExecutionPlacementV1(agreed, resolved)) return NO_BULK_SEED_PLACEMENT;
        } else {
            if (agreed !== null) return NO_BULK_SEED_PLACEMENT;
            choosing = true;
        }

        const entryCandidates = candidatesForTriageBulkPlacementV1(placement);
        candidates = candidates === null
            ? entryCandidates
            : intersectTriageBulkCandidatesV1(candidates, entryCandidates);
    }
    if (agreed !== null) return Object.freeze({ kind: 'exact', placement: agreed, candidates: candidates ?? [] });
    return candidates !== null && candidates.length > 0
        ? Object.freeze({ kind: 'candidates', candidates }) : NO_BULK_SEED_PLACEMENT;
}

export type TriageBulkHostV1 = TriageBulkSessionExecutionHostV1
    & TriageNewSessionDraftHostV1
    & TriageNewSessionSeedHostV1
    & TriageProjectRegistryHostV1
    & TriageActionResolutionHostV1
    & Pick<PluginUiHostApi, 'selectActionInput'>
    & Pick<PluginUiHostApi, 'executeAction'>
    & Readonly<{
        context(options?: Parameters<PluginUiHostApi['context']>[0]): Promise<Readonly<{
            targetedContributions?: PluginUiTargetedContributionsV1 | null;
            accountScope?: Readonly<{ serverId: string; accountId: string }>;
        }>>;
    }>;

export type TriageBulkSessionsOptionsV1 = Readonly<{
    mintCreationKey?: () => string;
}>;

type TriageBulkRetryContextV1 = Readonly<{
    entries: TriageBulkSessionsRequestV1['entries'];
    action: TriageActionV1;
    destination: Exclude<TriageBulkSessionDestinationV1, 'attachAllToNewSession'>;
    promptText: string | null;
    inputs: readonly Readonly<{
        creationKey: string;
        input: TriageStartEntrySessionInputV1;
    }>[];
}>;

type TriageBulkStartRecoveryV1 = Extract<TriageConfiguredStartRecoveryV1['state'], { kind: 'bulk' }>;

/** One projection for both configured outcomes and echoed bulk custody. */
export function projectTriageConfiguredBulkResultV1(result: TriageBulkSessionOutcomeV1): NonNullable<TriageRunConfiguredActionResultV1['results']>[number] {
    const identity = { creationKey: result.unit.creationKey, entryRefs: result.unit.entries.map((entry) => entry.entryRef) };
    return result.status === 'settled'
        ? { ...identity, status: 'settled', start: result.outcome.start, entries: [...result.outcome.entries] }
        : { ...identity, status: result.status };
}

/** Whether one workspace can truthfully represent every entry in a shared unit. */
export function isTriageBulkSharedPlacementCompatibleV1(input: Readonly<{
    workspaceMode: TriageActionV1['workspaceMode'];
    entries: readonly Pick<TriageBulkSelectedEntryV1, 'repository'>[];
}>): boolean {
    // Repository identity can prefill placement, but an explicit project choice
    // also supports entries from different repositories or without a repository.
    return canShareTriageNewSessionCheckoutV1(resolveTriageActionCheckoutV1(input.workspaceMode), input.entries.length);
}

/**
 * The destination compatibility answer shared by the mounted controls and the
 * press owner. Keeping it here means an omitted control and a programmatic
 * press fail closed for the same reason instead of becoming two policy paths.
 */
export function readTriageBulkDestinationUnavailableReasonV1(input: Readonly<{
    action: TriageActionV1;
    destination: TriageBulkSessionDestinationV1;
    entries: readonly (Pick<TriageBulkSelectedEntryV1, 'repository'> & Pick<TriageBulkEntrySelectionV1, 'workflowSubject'>)[];
}>): TriageBulkUnavailableReasonV1 | null {
    if (input.action.target.kind === 'reviewStart') return 'reviewStartUnsupported';
    const applicable = input.entries.filter((entry) => entry.workflowSubject !== null
        && planTriageOfferedActionsV1([input.action], entry.workflowSubject).length > 0);
    if (input.destination !== 'oneSessionPerEntry' && applicable.length > 0
        && !isTriageBulkSharedPlacementCompatibleV1({ workspaceMode: input.action.workspaceMode, entries: applicable })) {
        return 'sharedPlacementIncompatible';
    }
    if (input.destination !== 'attachAllToNewSession'
        && !hasTriageActionInstructionSourceV1(input.action.target)) return 'instructionMissing';
    return null;
}

export function createTriageBulkEntrySessionsController(
    host: TriageBulkHostV1,
    options?: TriageBulkSessionsOptionsV1,
): Readonly<{ getSnapshot: () => TriageBulkSessionsControllerV1; getRecovery: () => TriageBulkStartRecoveryV1 | null; restore: (recovery: TriageBulkStartRecoveryV1, entries: TriageBulkSessionsRequestV1['entries']) => boolean; subscribe: (listener: () => void) => () => void; activate: () => void; dispose: () => void; waitForSettled: () => Promise<TriageBulkSessionsControllerV1> }> {
    let phase: TriageBulkSessionsPhaseV1 = IDLE;
    const listeners = new Set<() => void>();
    let snapshot: TriageBulkSessionsControllerV1;
    const notify = () => { snapshot = readSnapshot(); for (const listener of listeners) listener(); };
    const setPhase = (value: TriageBulkSessionsPhaseV1) => { phase = value; notify(); };
    // Read synchronously by `run`, so two presses in one tick cannot both pass
    // the gate the way a state read would.
    const inFlight = ({ current: false } as { current: boolean });
    const retired = ({ current: false } as { current: boolean });
    const abort = ({ current: null } as { current: AbortController | null });
    let stopped = false;
    let activeRequestIdentity: Readonly<{ actionId: string; requestId: string }> | null = null;
    let completion: Promise<void> = Promise.resolve();
    const retryContext = ({ current: null } as { current: TriageBulkRetryContextV1 | null });
    const mintCreationKey = options?.mintCreationKey ?? mintTriageOpaqueIdV1;

    const run = (request: TriageBulkSessionsRequestV1) => {
        if (inFlight.current) return;
        retryContext.current = null;
        const action = request.action;
        if (requiresTriageActionInstructionV1(action.target)
            && !hasTriageActionInstructionSourceV1(action.target)) {
            setPhase(unavailable('instructionMissing'));
            return;
        }
        if (request.entries.length === 0) {
            setPhase(unavailable('noEntriesAvailable'));
            return;
        }
        const destinationUnavailable = readTriageBulkDestinationUnavailableReasonV1({
            action,
            destination: request.destination,
            entries: request.entries,
        });
        // Refused before anything opens, through the same compatibility answer
        // that omits the mounted dead control when all facts are already known.
        if (destinationUnavailable !== null) {
            setPhase(unavailable(destinationUnavailable));
            return;
        }
        // The fan-out, planned before ANY host read and before the reader is
        // asked anything. Its first job is the applicability partition, and
        // that partition has to settle first: resolving this action's profile
        // and prompt for a selection none of whose entries it is offered on
        // spends two host reads on a press that can start nothing, and then
        // reports whichever of those references happens to be broken instead of
        // the truthful per-entry refusal. Only a plan that actually carries
        // units spends a creation key.
        const initialPlan = planTriageBulkEntrySessions({
            action,
            selection: request.entries,
            destination: request.destination,
            mintCreationKey,
        });
        if (initialPlan.status === 'refused') {
            if (initialPlan.reason === 'noApplicableEntries') {
                setPhase(Object.freeze({
                    kind: 'settled',
                    results: Object.freeze([]),
                    selectionKeys: Object.freeze([
                        ...request.entries.map((entry) => entry.key),
                        ...(request.unavailableKeys ?? []),
                    ]),
                    unavailableKeys: request.unavailableKeys ?? [],
                    refusals: initialPlan.refusals ?? Object.freeze([]),
                }));
                return;
            }
            setPhase(unavailable(initialPlan.reason === 'emptySelection'
                ? 'noEntriesAvailable'
                : 'dispatch'));
            return;
        }
        inFlight.current = true;
        stopped = false;
        const controller = new AbortController();
        abort.current = controller;
        setPhase(RESOLVING);
        completion = (async () => {
            try {
                let plan = initialPlan;
                // 1. BOTH of the action's references, through the one resolver
                //    that owns them, resolved ONCE for the whole press and
                //    before any side effect. A reference that cannot be
                //    honoured refuses here — never after Sessions exist, and
                //    never by quietly degrading to the default the person
                //    configured away from.
                const references = await resolveTriageActionReferencesV1(
                    host,
                    action,
                    { signal: controller.signal },
                );
                if (retired.current) return;
                if (stopped || controller.signal.aborted) {
                    setPhase(IDLE);
                    return;
                }
                if (references.status !== 'resolved') {
                    setPhase(unavailable(referenceRefusal(references)));
                    return;
                }
                const preferences = references.profile?.preferences;
                const promptText = resolveTriageActionInstructionV1(
                    action,
                    references.prompt?.text ?? null,
                );

                // One registry read for the whole press. The placement owner is
                // then applied to the entries of each resulting Session: once
                // for a shared/seed destination, independently for each unit
                // of the per-entry destination.
                const registry = await readTriageProjectRegistryV1(
                    host,
                    { signal: controller.signal },
                );
                if (retired.current) return;
                if (stopped || controller.signal.aborted) {
                    setPhase(IDLE);
                    return;
                }
                const placementFor = (
                    entries: readonly Pick<TriageBulkSelectedEntryV1, 'repository'>[],
                ): TriageBulkSeedPlacementV1 => resolveTriageBulkSeedPlacementV1({
                    workspaceMode: action.workspaceMode,
                    ...(preferences === undefined ? {} : { preferences }),
                    entries,
                    projects: registry.status === 'read' ? registry.projects : [],
                    // An apparent exact match in part of the registry remains
                    // ambiguous; every unit consumes the same completeness fact.
                    registryComplete: registry.status === 'read' && registry.complete,
                });
                const checkoutIntent = resolveTriageActionCheckoutV1(action.workspaceMode, preferences);
                if (checkoutIntent === 'preparedReviewWorkspace') {
                    // Search observations need not include exact PR revisions. Acquire missing
                    // facts through the same get/detail owner as configured Action callers.
                    const allEntries = plan.status === 'seedNewSession' ? plan.entries : plan.units.flatMap((unit) => unit.entries);
                    if (allEntries.some((entry) => entry.reviewWorkspace === undefined)) {
                        const context = await host.context({ signal: controller.signal });
                        const complete = new Map<string, TriageBulkSessionsRequestV1['entries'][number]>();
                        for (const entry of allEntries) {
                            if (stopped || controller.signal.aborted || retired.current) break;
                            const facts = entry.reviewWorkspace !== undefined || context.targetedContributions === null ? null
                                : await readTriageEntrySessionFactsV1(host, {
                                    entryRef: entry.entryRef, sourceInstanceId: entry.sourceInstance.sourceInstanceId,
                                    ...(entry.lastKnownLocator === undefined ? {} : { lastKnownLocator: entry.lastKnownLocator }),
                                }, context.targetedContributions, controller.signal);
                            complete.set(entry.key, facts ?? entry);
                        }
                        if (retired.current) return;
                        if (stopped || controller.signal.aborted) { setPhase(IDLE); return; }
                        plan = plan.status === 'seedNewSession'
                            ? { ...plan, entries: plan.entries.map((entry) => complete.get(entry.key) ?? entry) }
                            : { ...plan, units: plan.units.map((unit) => ({ ...unit, entries: unit.entries.map((entry) => complete.get(entry.key) ?? entry) })) };
                    }
                }
                const startRoute = resolveTriageBulkStartRouteV1(
                    request.destination,
                    checkoutIntent,
                    promptText,
                );
                if (startRoute === 'refusedCompose') {
                    setPhase(unavailable('instructionMissing'));
                    return;
                }
                if (startRoute === 'refusedCheckout') {
                    setPhase(unavailable('checkoutRequiresNewSessionAuthoring'));
                    return;
                }

                if (plan.status === 'seedNewSession') {
                    const placement = placementFor(plan.entries);
                    const preparationAction = checkoutIntent === 'preparedReviewWorkspace' ? plan.entries[0]?.reviewWorkspace?.operation.action : undefined;
                    const seeded = await seedNewSession({
                        host,
                        entries: plan.entries,
                        promptText,
                        profileId: action.profileId,
                        actionDefault: triageActionDefaultSeedV1(action),
                        checkoutIntent,
                        placement,
                        // A prepared PR checkout needs a clone of this repository: only the matched projects can host it.
                        candidates: checkoutIntent === 'preparedReviewWorkspace'
                            ? (placement.kind === 'none' ? [] : placement.candidates).map(projectTriageSessionPlacementCandidateV1)
                            : registry.status === 'read' ? registry.projects.map(projectTriageSessionPlacementCandidateV1) : [],
                        signal: controller.signal,
                        isCurrent: () => !stopped && !controller.signal.aborted,
                        ...(preparationAction === undefined ? {} : { requestId: mintTriageOpaqueIdV1(),
                            onRequest: (requestId: string | null) => { activeRequestIdentity = requestId === null ? null
                                : { actionId: buildQualifiedPluginContributionKey(preparationAction), requestId }; } }),
                    });
                    if (retired.current) return;
                    if (stopped || seeded.status === 'cancelled') {
                        setPhase(IDLE);
                        return;
                    }
                    if (seeded.status !== 'seeded') {
                        setPhase(unavailable(seeded.status === 'refused' ? seeded.reason
                            : seeded.status === 'unsupported' ? 'newSessionUnsupported' : 'newSessionUnavailable'));
                        return;
                    }
                    setPhase(Object.freeze({
                        kind: 'seeded',
                        outcomes: projectTriageBulkSeedOutcomesV1(
                            plan.entries,
                            'applied',
                        ),
                        refusals: plan.refusals,
                    }));
                    return;
                }

                if (plan.units.length === 0) {
                    setPhase(unavailable('noEntriesAvailable'));
                    return;
                }

                // A shared destination asks once. A per-entry destination asks
                // once per resulting Session so a checkout for repository A is
                // never silently reused for repository B. All choices settle
                // before the first side effect; cancellation therefore still
                // has an honest "nothing started" outcome.
                const inputs: Array<TriageBulkRetryContextV1['inputs'][number]> = [];
                for (const unit of plan.units) {
                    const placement = placementFor(unit.entries);
                    const placementCandidates = placement.kind === 'none' ? [] : placement.candidates.map(projectTriageSessionPlacementCandidateV1);
                    setPhase(CHOOSING);
                    const explicitSettlement = request.settlementForEntries?.(unit.entries);
                    const draft = explicitSettlement === undefined ? await requestTriageNewSessionDraft(
                        host,
                        triageNewSessionDraftSeedV1(
                            {},
                            placement.kind === 'exact' ? placement.placement : undefined,
                            {
                                ...(action.profileId === null ? {} : { profileId: action.profileId }),
                                checkoutIntent,
                                ...(placementCandidates.length === 0 ? {} : { candidates: placementCandidates }),
                            },
                        ),
                        { signal: controller.signal },
                    ) : { status: 'settled' as const, settlement: explicitSettlement };
                    if (retired.current) return;
                    if (draft.status === 'cancelled' || stopped || controller.signal.aborted) {
                        setPhase(IDLE);
                        return;
                    }
                    if (draft.status !== 'settled') {
                        setPhase(unavailable(draft.status === 'unsupported'
                            ? 'newSessionUnsupported'
                            : 'newSessionUnavailable'));
                        return;
                    }
                    const admitted = projectTriageNewSessionDestinationV1({
                        workspaceMode: action.workspaceMode,
                        creationKey: unit.creationKey,
                        settlement: draft.settlement,
                        ...(action.profileId === null ? {} : { profileId: action.profileId }),
                        ...(unit.entries[0]?.reviewWorkspace === undefined ? {} : {
                            reviewWorkspace: unit.entries[0].reviewWorkspace.preparation,
                        }),
                        placementCandidates,
                    });
                    if (admitted.status === 'refused') {
                        setPhase(unavailable('newSessionUnavailable'));
                        return;
                    }
                    inputs.push(Object.freeze({
                        creationKey: unit.creationKey,
                        input: projectTriageBulkEntrySessionStartInputV1({ action, unit,
                            destination: request.destination as Exclude<TriageBulkSessionDestinationV1, 'attachAllToNewSession'>,
                            sessionDestination: admitted.destination, promptText }),
                    }));
                }

                const total = plan.units.length;
                let started = 0;
                retryContext.current = Object.freeze({
                    entries: request.entries,
                    action,
                    destination: request.destination as Exclude<
                        TriageBulkSessionDestinationV1,
                        'attachAllToNewSession'
                    >,
                    promptText,
                    inputs: Object.freeze(inputs),
                });
                setPhase(Object.freeze({ kind: 'starting', started, total }));
                const results = await runTriageBulkEntrySessionStartsV1({
                    host,
                    units: plan.units,
                    action,
                    destination: request.destination,
                    promptText,
                    inputForUnit: (unit) => inputs.find(
                        (candidate) => candidate.creationKey === unit.creationKey,
                    )!.input,
                    onPreparationCancelled: () => { stopped = true; },
                    signal: controller.signal,
                    isStopped: () => stopped,
                    onRequest: (requestId) => { activeRequestIdentity = requestId === null ? null : { actionId: START_ENTRY_ACTION_ID, requestId }; },
                    onStarted: () => {
                        started += 1;
                        if (!retired.current) {
                            setPhase(Object.freeze({ kind: 'starting', started, total }));
                        }
                    },
                });
                setPhase(Object.freeze({
                    kind: 'settled',
                    results,
                    selectionKeys: Object.freeze([
                        ...request.entries.map((entry) => entry.key),
                        ...(request.unavailableKeys ?? []),
                    ]),
                    unavailableKeys: request.unavailableKeys ?? [],
                    refusals: plan.refusals,
                }));
            } catch {
                if (!retired.current) {
                    setPhase(stopped || controller.signal.aborted ? IDLE : unavailable('dispatch'));
                }
            } finally {
                inFlight.current = false;
                notify();
                if (abort.current === controller) abort.current = null;
            }
        })();
    };

    const readRetryable = () => phase.kind === 'settled'
        && phase.results.some(isTriageBulkSessionOutcomeRetryableV1);

    const retry = () => {
        if (inFlight.current || phase.kind !== 'settled') return;
        const context = retryContext.current;
        if (context === null) return;
        const units = readTriageBulkRetryUnitsV1(phase.results);
        if (units.length === 0) return;

        const prior = phase;
        inFlight.current = true;
        stopped = false;
        const controller = new AbortController();
        abort.current = controller;
        let started = 0;
        setPhase(Object.freeze({ kind: 'starting', started, total: units.length }));
        completion = (async () => {
            try {
                const resolved = await resolveTriageConfiguredActionForExecutionV1(host, context.action.actionId, undefined, { signal: controller.signal });
                if (retired.current) return;
                if (stopped || controller.signal.aborted || resolved.status !== 'resolved') {
                    setPhase(prior);
                    return;
                }
                const subjects = new Map(context.entries.map((entry) => [entry.key, entry.workflowSubject]));
                const offeredUnits = units.filter((unit) => unit.entries.every((entry) => {
                    // Issued units retain custody even if provider facts are now unavailable.
                    // Only a unit never dispatched still needs current applicability evidence.
                    const previous = prior.results.find((result) => result.unit.creationKey === unit.creationKey);
                    if (previous?.status !== 'notStarted') return true;
                    const subject = subjects.get(entry.key);
                    return subject !== undefined && subject !== null
                        && planTriageOfferedActionsV1([resolved.action], subject).length > 0;
                }));
                const retried = await runTriageBulkEntrySessionStartsV1({
                    host,
                    units: offeredUnits,
                    action: context.action,
                    destination: context.destination,
                    promptText: context.promptText,
                    inputForUnit: (unit) => context.inputs.find(
                        (candidate) => candidate.creationKey === unit.creationKey,
                    )!.input,
                    onPreparationCancelled: () => { stopped = true; },
                    signal: controller.signal,
                    isStopped: () => stopped,
                    onRequest: (requestId) => { activeRequestIdentity = requestId === null ? null : { actionId: START_ENTRY_ACTION_ID, requestId }; },
                    previousResults: prior.results,
                    onStarted: () => {
                        started += 1;
                        if (!retired.current) {
                            setPhase(Object.freeze({ kind: 'starting', started, total: units.length }));
                        }
                    },
                });
                setPhase(Object.freeze({
                    ...prior,
                    results: mergeTriageBulkRetryResultsV1(prior.results, retried),
                }));
            } catch {
                if (!retired.current) setPhase(prior);
            } finally {
                inFlight.current = false;
                notify();
                if (abort.current === controller) abort.current = null;
            }
        })();
    };

    const cancel = async () => {
        stopped = true;
        const requestIdentity = activeRequestIdentity;
        if (requestIdentity === null) return;
        const result = await host.executeAction('action.operations.list', { requestIdentity });
        const operation = result.items[0];
        const context = await host.context();
        if (!operation || !context.accountScope) throw new PluginError({ code: 'unavailable', diagnostics: [
            { code: 'action_operation_not_found', severity: 'error' },
        ] });
        const cancellation = await host.executeAction('action.operations.cancel', {
            serverId: context.accountScope.serverId, machineId: operation.scope.machineId, operationId: operation.operationId,
        });
        if (cancellation.kind !== 'requested' && cancellation.kind !== 'already_settled') throw new PluginError({ code: 'unavailable', diagnostics: [
            { code: 'action_operation_stop_unconfirmed', severity: 'error' },
        ] });
    };
    const reset = async () => {
        if (inFlight.current) {
            await cancel();
            return;
        }
        retryContext.current = null;
        setPhase(IDLE);
    };

    const readSnapshot = (): TriageBulkSessionsControllerV1 => Object.freeze({ phase, run, retryable: readRetryable(), retry, cancel, reset });
    snapshot = readSnapshot();
    return Object.freeze({
        getSnapshot: () => snapshot,
        getRecovery: (): TriageBulkStartRecoveryV1 | null => {
            const context = retryContext.current;
            if (phase.kind !== 'settled' || !readRetryable() || context === null) return null;
            return { kind: 'bulk', action: context.action, destination: context.destination, promptText: context.promptText,
                units: phase.results.map((result) => ({ result: projectTriageConfiguredBulkResultV1(result),
                    input: context.inputs.find((candidate) => candidate.creationKey === result.unit.creationKey)!.input })),
                refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
                unavailableKeys: [...phase.unavailableKeys],
            };
        },
        restore: (recovery, entries) => {
            if (inFlight.current) return false;
            const results: TriageBulkSessionOutcomeV1[] = [];
            for (const retained of recovery.units) {
                if (retained.input.destination.kind !== 'new' || retained.input.destination.creationKey !== retained.result.creationKey
                    || triageEntryRowKey(retained.input.entryRef) !== triageEntryRowKey(retained.result.entryRefs[0]!)) return false;
                const selected = retained.result.entryRefs.map((ref) => entries.find((entry) => triageEntryRowKey(entry.entryRef) === triageEntryRowKey(ref)));
                if (selected.some((entry) => entry === undefined)) return false;
                const unit = { creationKey: retained.result.creationKey,
                    entries: selected.filter((entry): entry is TriageBulkSessionsRequestV1['entries'][number] => entry !== undefined) };
                results.push(retained.result.status === 'settled'
                    ? { unit, status: 'settled', outcome: { start: retained.result.start, entries: retained.result.entries } }
                    : { unit, status: retained.result.status });
            }
            const refusals: Extract<TriageBulkSessionsPhaseV1, { kind: 'settled' }>['refusals'][number][] = [];
            for (const refusal of recovery.refusals) {
                const entry = { entryRef: refusal.entryRef };
                const reason = refusal.reason;
                if (reason !== 'workflowSubjectUnavailable' && reason !== 'actionInapplicable') return false;
                refusals.push({ entry, reason });
            }
            retryContext.current = { entries, action: recovery.action, destination: recovery.destination, promptText: recovery.promptText,
                inputs: recovery.units.map((unit) => ({ creationKey: unit.result.creationKey, input: unit.input })) };
            setPhase({ kind: 'settled', results, refusals, unavailableKeys: recovery.unavailableKeys,
                selectionKeys: [...entries.map((entry) => entry.key), ...recovery.unavailableKeys] });
            return true;
        },
        activate: () => { retired.current = false; },
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose: () => { retired.current = true; abort.current?.abort(); listeners.clear(); },
        waitForSettled: async () => { await completion; return snapshot; },
    });
}

async function seedNewSession(input: Readonly<{
    host: TriageNewSessionSeedHostV1 & Pick<PluginUiHostApi, 'selectActionInput'>;
    entries: readonly TriageBulkSelectedEntryV1[];
    promptText: string | null;
    profileId: string | null;
    actionDefault: Parameters<typeof requestTriageNewSessionAuthoringV1>[1]['actionDefault'];
    checkoutIntent: ReturnType<typeof resolveTriageActionCheckoutV1>;
    /**
     * The selection's one honest placement answer. An exact answer carries its
     * machine beside the path; ambiguous matches remain reader-selectable
     * candidates instead of becoming the first path in the array.
     */
    placement: TriageBulkSeedPlacementV1;
    candidates: Parameters<typeof requestTriageNewSessionAuthoringV1>[1]['candidates'];
    signal: AbortSignal;
    requestId?: string;
    onRequest?: Parameters<typeof requestTriageNewSessionAuthoringV1>[1]['onRequest'];
    isCurrent: () => boolean;
}>): ReturnType<typeof requestTriageNewSessionAuthoringV1> {
    return await requestTriageNewSessionAuthoringV1(input.host, {
        entries: input.entries, promptText: input.promptText, profileId: input.profileId,
        actionDefault: input.actionDefault,
        checkoutIntent: input.checkoutIntent, candidates: input.candidates,
        placement: input.placement.kind === 'exact' ? input.placement.placement : null,
        signal: input.signal,
        isCurrent: input.isCurrent,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId, onRequest: input.onRequest }),
    });
}
