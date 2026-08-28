import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

import type { TriageStartEntrySessionResultV1 } from '../../actions/entrySessionProtocol.js';
import { mintTriageOpaqueIdV1 } from '../../opaqueId.js';
import { planTriageActionDeliveryV1 } from '../../sessions/actionDelivery.js';
import {
    readTriageActionExecutionPlacementV1,
    type TriageActionExecutionPlacementV1,
    type TriageActionPlacementV1,
    resolveTriageActionCheckoutV1,
    resolveTriageActionPlacementV1,
} from '../../sessions/actionLaunch.js';
import {
    resolveTriageActionReferencesV1,
    type TriageActionReferencesV1,
    type TriageActionResolutionHostV1,
} from '../../sessions/actionResolution.js';
import {
    readTriageProjectRegistryV1,
    type TriageProjectRegistryHostV1,
} from '../../sessions/projectCandidates.js';
import type { TriageActionV1 } from '../../settings/actions.js';
import {
    projectTriageSessionPlacementCandidateV1,
    projectTriagePreparedWorkspaceSelectionInputV1,
    projectTriageNewSessionDestinationV1,
    triageNewSessionDraftSeedV1,
    triageNewSessionWireMaterializationV1,
} from '../header/newSessionDestination.js';
import {
    requestTriageNewSessionDraft,
    type TriageNewSessionDraftHostV1,
} from '../header/newSessionDraftCommand.js';
import {
    requestTriageNewSessionSeed,
    type TriageNewSessionSeedHostV1,
    type TriageNewSessionSeedV1,
} from '../header/newSessionSeedCommand.js';
import type { TriageBulkSelectedEntryV1 } from './bulkSelectionEntries.js';
import {
    isTriageBulkEntryOutcomeIncompleteV1,
    projectTriageBulkSeedOutcomesV1,
    type TriageBulkEntryOutcomeV1,
} from './bulkSessionOutcome.js';
import {
    planTriageBulkEntrySessions,
    type TriageBulkActionRefusalV1,
    type TriageBulkEntrySelectionV1,
    type TriageBulkSessionDestinationV1,
    type TriageBulkSessionUnitResultV1,
} from './bulkSessionPlan.js';
import {
    runTriageBulkEntrySessionStartsV1,
    type TriageBulkSessionExecutionHostV1,
} from './bulkEntrySessionExecution.js';

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
 * (`PLAN.md` §0a A6), and so is the reader's Agent/target choice: the host's
 * New Session surface opens once and its settlement is spent by every unit,
 * each under its OWN creation key. One press is one question to the reader,
 * whether it asks for one Session or twelve.
 *
 * A press that arrives while one is in flight is ignored rather than queued,
 * for the same reason a single-entry press is: two presses of one action are
 * one request, and admitting the second would open a second New Session surface
 * and mint a second set of creation keys for Sessions the first is creating.
 *
 * A `send` action travels on the start as one idempotent structured input. Its
 * attachment array contains every entry in the unit, so "one Session for all"
 * gives the model every selected entry as initial context without provider
 * prose in the prompt or a follow-up send that navigation could retire.
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
        refusals: readonly TriageBulkActionRefusalV1<TriageBulkSelectedEntryV1>[];
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
    | 'composeRequiresNewSessionAuthoring'
    /** The action names a profile or prompt the catalog no longer holds. */
    | 'profileMissing'
    | 'promptMissing'
    | 'promptInvalid'
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
    cancel: () => void;
    reset: () => void;
}>;

export type TriageBulkSessionsRequestV1 = Readonly<{
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
    const replacementByUnit = new Map(retried.map((result) => [result.unit, result] as const));
    return Object.freeze(previous.map((result) => replacementByUnit.get(result.unit) ?? result));
}

export type TriageBulkStartRouteV1 =
    | 'direct'
    | 'seedNewSession'
    | 'refusedCheckout'
    | 'refusedCompose';

export function resolveTriageBulkStartRouteV1(
    destination: TriageBulkSessionDestinationV1,
    checkoutIntent: ReturnType<typeof resolveTriageActionCheckoutV1>,
    target: TriageActionV1['target'],
): TriageBulkStartRouteV1 {
    if (destination === 'attachAllToNewSession') return 'seedNewSession';
    // Compose is authoring, so its text and attachments must exist in the
    // canonical New Session draft before spawn. The two direct destinations
    // cannot express N independent drafts; spawning first and patching each
    // composer afterwards starts empty Sessions and races the runtime. Fail
    // closed here and leave Attach all to New Session available instead.
    if (target.kind === 'agent' && target.delivery === 'compose') return 'refusedCompose';
    return checkoutIntent === 'none' || checkoutIntent === 'reuseWorkspace'
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
        /** Retained only when the exact answer came from this real candidate. */
        candidate?: TriageBulkPlacementCandidateV1;
    }>
    | Readonly<{ kind: 'candidates'; candidates: readonly TriageBulkPlacementCandidateV1[] }>
    | Readonly<{ kind: 'none' }>;

const NO_BULK_SEED_PLACEMENT: TriageBulkSeedPlacementV1 = Object.freeze({ kind: 'none' });

function sameTriageBulkExecutionPlacementV1(
    left: TriageActionExecutionPlacementV1,
    right: TriageActionExecutionPlacementV1,
): boolean {
    return left.directory === right.directory
        && left.executionTarget.serverId === right.executionTarget.serverId
        && left.executionTarget.machineId === right.executionTarget.machineId;
}

function sameTriageBulkProjectKeyV1(
    left: TriageBulkPlacementCandidateV1['projectKey'],
    right: TriageBulkPlacementCandidateV1['projectKey'],
): boolean {
    if ('id' in left || 'id' in right) return 'id' in left && 'id' in right && left.id === right.id;
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
): readonly TriageBulkPlacementCandidateV1[] | null {
    if (placement.kind === 'launch') return [placement.candidate];
    if (placement.kind === 'prefill') return placement.candidates;
    // A profile pin is a stated machine/path answer, not one more candidate a
    // bulk chooser may replace with a registry match.
    return null;
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
    let agreedCandidate: TriageBulkPlacementCandidateV1 | undefined;
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
        if (resolved !== null && resolved.directory !== undefined) {
            if (candidates !== null) return NO_BULK_SEED_PLACEMENT;
            if (agreed === null) {
                agreed = resolved;
                agreedCandidate = placement.kind === 'launch' ? placement.candidate : undefined;
            } else {
                if (!sameTriageBulkExecutionPlacementV1(agreed, resolved)) return NO_BULK_SEED_PLACEMENT;
                if (
                    agreedCandidate !== undefined
                    && (placement.kind !== 'launch'
                        || !sameTriageBulkPlacementCandidateV1(agreedCandidate, placement.candidate))
                ) agreedCandidate = undefined;
            }
            continue;
        }

        const entryCandidates = candidatesForTriageBulkPlacementV1(placement);
        if (entryCandidates === null || agreed !== null) return NO_BULK_SEED_PLACEMENT;
        candidates = candidates === null
            ? entryCandidates
            : intersectTriageBulkCandidatesV1(candidates, entryCandidates);
        if (candidates.length === 0) return NO_BULK_SEED_PLACEMENT;
    }
    if (candidates !== null) return Object.freeze({ kind: 'candidates', candidates });
    return agreed === null
        ? NO_BULK_SEED_PLACEMENT
        : Object.freeze({
            kind: 'exact',
            placement: agreed,
            ...(agreedCandidate === undefined ? {} : { candidate: agreedCandidate }),
        });
}

type TriageBulkHostV1 = TriageBulkSessionExecutionHostV1
    & TriageNewSessionDraftHostV1
    & TriageNewSessionSeedHostV1
    & TriageProjectRegistryHostV1
    & TriageActionResolutionHostV1
    & Pick<PluginUiHostApi, 'selectActionInput'>;

export type TriageBulkSessionsOptionsV1 = Readonly<{
    mintCreationKey?: () => string;
}>;

type TriageBulkRetryContextV1 = Readonly<{
    action: TriageActionV1;
    destination: Exclude<TriageBulkSessionDestinationV1, 'attachAllToNewSession'>;
    promptText: string | null;
    settlement: unknown;
}>;

export function useTriageBulkEntrySessions(
    options?: TriageBulkSessionsOptionsV1,
): TriageBulkSessionsControllerV1 {
    const host = usePluginHostApi() as unknown as TriageBulkHostV1;
    const [phase, setPhase] = React.useState<TriageBulkSessionsPhaseV1>(IDLE);
    // Read synchronously by `run`, so two presses in one tick cannot both pass
    // the gate the way a state read would.
    const inFlight = React.useRef(false);
    const retired = React.useRef(false);
    const abort = React.useRef<AbortController | null>(null);
    const retryContext = React.useRef<TriageBulkRetryContextV1 | null>(null);
    const mintCreationKey = options?.mintCreationKey ?? mintTriageOpaqueIdV1;

    React.useEffect(() => {
        retired.current = false;
        return () => {
            retired.current = true;
            abort.current?.abort();
        };
    }, []);

    /** Reads the one project registry, then delegates agreement to its pure owner. */
    const resolveSeedPlacement = React.useCallback(async (
        request: TriageBulkSessionsRequestV1,
        preferences: Parameters<typeof resolveTriageActionPlacementV1>[0]['profile'],
    ): Promise<TriageBulkSeedPlacementV1> => {
        const registry = await readTriageProjectRegistryV1(host);
        return resolveTriageBulkSeedPlacementV1({
            workspaceMode: request.action.workspaceMode,
            ...(preferences === undefined ? {} : { preferences }),
            entries: request.entries,
            projects: registry.status === 'read' ? registry.projects : [],
            // One reachable match in a PAGE of the registry is not one in the
            // registry, and a bulk press multiplies whatever that mistake costs
            // by the size of the selection.
            registryComplete: registry.status === 'read' && registry.complete,
        });
    }, [host]);

    const run = React.useCallback((request: TriageBulkSessionsRequestV1) => {
        if (inFlight.current) return;
        retryContext.current = null;
        const action = request.action;
        // Refused before anything opens, exactly as the single press refuses
        // them: spending the reader's Agent and directory choice on a start the
        // wire cannot carry is worse than telling them first.
        if (action.target.kind === 'reviewStart') {
            setPhase(unavailable('reviewStartUnsupported'));
            return;
        }
        if (triageNewSessionWireMaterializationV1(action.workspaceMode) === null) {
            setPhase(unavailable('preparedWorkspaceUnsupported'));
            return;
        }
        if (request.entries.length === 0) {
            setPhase(unavailable('noEntriesAvailable'));
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
        const plan = planTriageBulkEntrySessions({
            action,
            selection: request.entries,
            destination: request.destination,
            mintCreationKey,
        });
        if (plan.status === 'refused') {
            if (plan.reason === 'noApplicableEntries') {
                setPhase(Object.freeze({
                    kind: 'settled',
                    results: Object.freeze([]),
                    selectionKeys: Object.freeze([
                        ...request.entries.map((entry) => entry.key),
                        ...(request.unavailableKeys ?? []),
                    ]),
                    unavailableKeys: request.unavailableKeys ?? [],
                    refusals: plan.refusals ?? Object.freeze([]),
                }));
                return;
            }
            setPhase(unavailable(plan.reason === 'emptySelection'
                ? 'noEntriesAvailable'
                : 'dispatch'));
            return;
        }
        inFlight.current = true;
        const controller = new AbortController();
        abort.current = controller;
        setPhase(RESOLVING);
        void (async () => {
            try {
                // 1. BOTH of the action's references, through the one resolver
                //    that owns them, resolved ONCE for the whole press and
                //    before any side effect. A reference that cannot be
                //    honoured refuses here — never after Sessions exist, and
                //    never by quietly degrading to the default the person
                //    configured away from.
                const references = await resolveTriageActionReferencesV1(host, action);
                if (retired.current) return;
                if (references.status !== 'resolved') {
                    setPhase(unavailable(referenceRefusal(references)));
                    return;
                }
                const preferences = references.profile?.preferences;
                const promptText = references.prompt?.text ?? null;

                const applicableEntries = plan.status === 'seedNewSession'
                    ? plan.entries
                    : plan.units.flatMap((unit) => unit.entries);
                const placement = await resolveSeedPlacement(
                    { ...request, entries: applicableEntries },
                    preferences,
                );
                if (retired.current) return;
                const checkoutIntent = resolveTriageActionCheckoutV1(action.workspaceMode, preferences);
                const startRoute = resolveTriageBulkStartRouteV1(
                    request.destination,
                    checkoutIntent,
                    action.target,
                );
                if (startRoute === 'refusedCheckout' || startRoute === 'refusedCompose') {
                    setPhase(unavailable(startRoute === 'refusedCompose'
                        ? 'composeRequiresNewSessionAuthoring'
                        : 'checkoutRequiresNewSessionAuthoring'));
                    return;
                }

                if (plan.status === 'seedNewSession') {
                    const seeded = await seedNewSession({
                        host,
                        entries: plan.entries,
                        promptText,
                        profileId: action.profileId,
                        checkoutIntent,
                        placement,
                        signal: controller.signal,
                    });
                    if (retired.current) return;
                    if (seeded.status === 'cancelled') {
                        setPhase(IDLE);
                        return;
                    }
                    setPhase(Object.freeze({
                        kind: 'seeded',
                        outcomes: projectTriageBulkSeedOutcomesV1(
                            plan.entries,
                            seeded.status === 'seeded' ? 'applied' : 'refused',
                        ),
                        refusals: plan.refusals,
                    }));
                    return;
                }

                // 4. One question to the reader for the whole press.
                setPhase(CHOOSING);
                const draft = await requestTriageNewSessionDraft(
                    host,
                    triageNewSessionDraftSeedV1(
                        {},
                        placement.kind === 'exact' ? placement.placement : undefined,
                        {
                            ...(action.profileId === null ? {} : { profileId: action.profileId }),
                            checkoutIntent,
                            ...(placement.kind !== 'candidates' ? {} : {
                                candidates: placement.candidates.map(projectTriageSessionPlacementCandidateV1),
                            }),
                        },
                    ),
                    { signal: controller.signal },
                );
                if (retired.current) return;
                if (draft.status === 'cancelled') {
                    setPhase(IDLE);
                    return;
                }
                if (draft.status !== 'settled') {
                    setPhase(unavailable(draft.status === 'unsupported'
                        ? 'newSessionUnsupported'
                        : 'newSessionUnavailable'));
                    return;
                }

                // Whether this settlement can build a destination at all depends
                // only on the action's mode and what the reader settled — not on
                // which unit is being started. Answering it ONCE, before
                // anything runs, is what keeps a refusal an honest "nothing was
                // started" instead of N units each reported as "attempted,
                // outcome not observed" when nothing was ever attempted.
                const firstUnit = plan.units[0];
                if (firstUnit === undefined) {
                    setPhase(unavailable('noEntriesAvailable'));
                    return;
                }
                if (projectTriageNewSessionDestinationV1({
                    workspaceMode: action.workspaceMode,
                    creationKey: firstUnit.creationKey,
                    settlement: draft.settlement,
                    ...(action.profileId === null ? {} : { profileId: action.profileId }),
                }).status === 'refused') {
                    setPhase(unavailable('newSessionUnavailable'));
                    return;
                }

                const total = plan.units.length;
                let started = 0;
                retryContext.current = Object.freeze({
                    action,
                    destination: request.destination as Exclude<
                        TriageBulkSessionDestinationV1,
                        'attachAllToNewSession'
                    >,
                    promptText,
                    settlement: draft.settlement,
                });
                setPhase(Object.freeze({ kind: 'starting', started, total }));
                const results = await runTriageBulkEntrySessionStartsV1({
                    host,
                    units: plan.units,
                    action,
                    destination: request.destination,
                    promptText,
                    settlement: draft.settlement,
                    signal: controller.signal,
                    onStarted: () => {
                        started += 1;
                        if (!retired.current) {
                            setPhase(Object.freeze({ kind: 'starting', started, total }));
                        }
                    },
                });
                if (retired.current) return;
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
                if (!retired.current) setPhase(unavailable('dispatch'));
            } finally {
                inFlight.current = false;
            }
        })();
    }, [host, mintCreationKey, resolveSeedPlacement]);

    const retryable = phase.kind === 'settled'
        && phase.results.some(isTriageBulkSessionOutcomeRetryableV1);

    const retry = React.useCallback(() => {
        if (inFlight.current || phase.kind !== 'settled') return;
        const context = retryContext.current;
        if (context === null) return;
        const units = readTriageBulkRetryUnitsV1(phase.results);
        if (units.length === 0) return;

        const prior = phase;
        inFlight.current = true;
        const controller = new AbortController();
        abort.current = controller;
        let started = 0;
        setPhase(Object.freeze({ kind: 'starting', started, total: units.length }));
        void (async () => {
            try {
                const retried = await runTriageBulkEntrySessionStartsV1({
                    host,
                    units,
                    action: context.action,
                    destination: context.destination,
                    promptText: context.promptText,
                    settlement: context.settlement,
                    signal: controller.signal,
                    onStarted: () => {
                        started += 1;
                        if (!retired.current) {
                            setPhase(Object.freeze({ kind: 'starting', started, total: units.length }));
                        }
                    },
                });
                if (retired.current) return;
                setPhase(Object.freeze({
                    ...prior,
                    results: mergeTriageBulkRetryResultsV1(prior.results, retried),
                }));
            } catch {
                if (!retired.current) setPhase(prior);
            } finally {
                inFlight.current = false;
            }
        })();
    }, [host, phase]);

    const cancel = React.useCallback(() => { abort.current?.abort(); }, []);
    const reset = React.useCallback(() => {
        retryContext.current = null;
        setPhase(IDLE);
    }, []);

    return React.useMemo(
        () => Object.freeze({ phase, run, retryable, retry, cancel, reset }),
        [cancel, phase, reset, retry, retryable, run],
    );
}

async function seedNewSession(input: Readonly<{
    host: TriageNewSessionSeedHostV1 & Pick<PluginUiHostApi, 'selectActionInput'>;
    entries: readonly TriageBulkSelectedEntryV1[];
    promptText: string | null;
    profileId: string | null;
    checkoutIntent: ReturnType<typeof resolveTriageActionCheckoutV1>;
    /**
     * The selection's one honest placement answer. An exact answer carries its
     * machine beside the path; ambiguous matches remain reader-selectable
     * candidates instead of becoming the first path in the array.
     */
    placement: TriageBulkSeedPlacementV1;
    signal: AbortSignal;
}>): Promise<
    | Awaited<ReturnType<typeof requestTriageNewSessionSeed>>
    | Readonly<{ status: 'cancelled' }>
> {
    // The attachment drafts are built by the ONE composer-side owner, so an
    // entry seeded onto the New Session screen and an entry attached through
    // the picker are the same record.
    const placed = planTriageActionDeliveryV1({
        // `compose` is what this destination IS: the reader asked to look
        // first, and the screen they land on has not created anything yet.
        delivery: 'compose',
        promptText: input.promptText,
        entries: input.entries.map((entry) => ({
            entryRef: entry.entryRef,
            sourceInstance: entry.sourceInstance,
            presentation: entry.presentation,
            ...(entry.lastKnownLocator === undefined
                ? {}
                : { lastKnownLocator: entry.lastKnownLocator }),
        })),
    });
    const attachments = placed.kind === 'none' ? [] : placed.attachments;
    const text = placed.kind === 'none' ? undefined : placed.text;
    const placementCandidates = input.placement.kind === 'candidates'
        ? input.placement.candidates.map(projectTriageSessionPlacementCandidateV1)
        : input.placement.kind === 'exact' && input.placement.candidate !== undefined
            ? [projectTriageSessionPlacementCandidateV1(input.placement.candidate)]
            : [];
    let openOptions: Parameters<typeof requestTriageNewSessionSeed>[2];
    if (input.checkoutIntent === 'preparedReviewWorkspace') {
        // One New Session can have one working directory. Preparing one of two
        // selected pull requests and silently attaching the other into that
        // checkout would claim a correspondence no source declared.
        const entry = input.entries.length === 1 ? input.entries[0] : undefined;
        if (entry?.reviewWorkspace === undefined) return { status: 'unavailable' };
        const selected = await input.host.selectActionInput({
            operation: entry.reviewWorkspace.operation,
            draft: projectTriagePreparedWorkspaceSelectionInputV1({
                preparation: entry.reviewWorkspace.preparation,
                placement: input.placement.kind === 'exact'
                    ? input.placement.placement
                    : null,
                candidates: placementCandidates,
            }),
        }, { signal: input.signal });
        if (selected.kind === 'cancelled') return { status: 'cancelled' };
        if (selected.kind !== 'submitted') return { status: 'unavailable' };
        openOptions = {
            signal: input.signal,
            preparedReviewWorkspace: {
                operation: entry.reviewWorkspace.operation,
                result: selected,
            },
        };
    }
    const seed: TriageNewSessionSeedV1 = {
        ...(text === undefined ? {} : { prompt: text }),
        ...(input.profileId === null ? {} : { profileId: input.profileId }),
        checkoutIntent: input.checkoutIntent,
        ...(input.placement.kind !== 'exact' ? {} : {
            placement: {
                serverId: input.placement.placement.executionTarget.serverId,
                machineId: input.placement.placement.executionTarget.machineId,
                ...(input.checkoutIntent === 'preparedReviewWorkspace'
                    || input.placement.placement.directory === undefined
                    ? {}
                    : { directory: input.placement.placement.directory }),
            },
        }),
        ...(input.placement.kind !== 'candidates'
            ? {}
            : { candidates: placementCandidates }),
        ...(attachments.length === 0 ? {} : { attachments }),
    };
    return await requestTriageNewSessionSeed(
        input.host,
        seed,
        openOptions ?? { signal: input.signal },
    );
}
