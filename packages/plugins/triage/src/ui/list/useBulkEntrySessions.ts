import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';

import type { TriageStartEntrySessionResultV1 } from '../../actions/entrySessionProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from '../../actions/sessionLinksProtocol.js';
import { planTriageActionDeliveryV1 } from '../../sessions/actionDelivery.js';
import {
    readTriageActionExecutionPlacementV1,
    type TriageActionExecutionPlacementV1,
    type TriageActionPlacementV1,
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
import { submitTriageEntrySessionStart, type TriageSessionStartHostV1 } from '../header/startEntrySessionCommand.js';
import type { TriageBulkSelectedEntryV1 } from './bulkSelectionEntries.js';
import {
    projectTriageBulkEntryOutcomesV1,
    projectTriageBulkSeedOutcomesV1,
    type TriageBulkComposeOutcomeV1,
    type TriageBulkEntryOutcomeV1,
    type TriageBulkLinkOutcomeV1,
} from './bulkSessionOutcome.js';
import {
    planTriageBulkEntrySessions,
    runTriageBulkEntrySessions,
    type TriageBulkActionRefusalV1,
    type TriageBulkEntrySelectionV1,
    type TriageBulkSessionDestinationV1,
    type TriageBulkSessionUnitResultV1,
} from './bulkSessionPlan.js';

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
    | Readonly<{ kind: 'exact'; placement: TriageActionExecutionPlacementV1 }>
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
            if (agreed === null) agreed = resolved;
            else if (!sameTriageBulkExecutionPlacementV1(agreed, resolved)) return NO_BULK_SEED_PLACEMENT;
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
        : Object.freeze({ kind: 'exact', placement: agreed });
}

const mintRandomCreationKey = (): string => {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    // React Native has no WebCrypto, and a creation key is a dedupe identity
    // rather than a secret: distinctness per unit is the whole requirement.
    return `triage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

type TriageBulkHostV1 = TriageSessionStartHostV1
    & TriageNewSessionDraftHostV1
    & TriageNewSessionSeedHostV1
    & TriageProjectRegistryHostV1
    & TriageActionResolutionHostV1;

export type TriageBulkSessionsOptionsV1 = Readonly<{
    mintCreationKey?: () => string;
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
    const mintCreationKey = options?.mintCreationKey ?? mintRandomCreationKey;

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

                // 3. The fan-out. It is planned BEFORE the reader is asked
                //    anything, so an empty or colliding plan never opens a
                //    surface.
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

                const applicableEntries = plan.status === 'seedNewSession'
                    ? plan.entries
                    : plan.units.flatMap((unit) => unit.entries);
                const placement = await resolveSeedPlacement(
                    { ...request, entries: applicableEntries },
                    preferences,
                );
                if (retired.current) return;

                if (plan.status === 'seedNewSession') {
                    const seeded = await seedNewSession({
                        host,
                        entries: plan.entries,
                        promptText,
                        profileId: action.profileId,
                        placement,
                        signal: controller.signal,
                    });
                    if (retired.current) return;
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
                    placement.kind === 'candidates'
                        ? { candidates: placement.candidates.map(projectTriageSessionPlacementCandidateV1) }
                        : triageNewSessionDraftSeedV1(
                            {},
                            ...(placement.kind === 'exact' ? [placement.placement] : []),
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
                setPhase(Object.freeze({ kind: 'starting', started, total }));
                const results = await runTriageBulkEntrySessions<
                    Readonly<{
                        start: TriageStartEntrySessionResultV1;
                        entries: readonly TriageBulkEntryOutcomeV1[];
                    }>,
                    TriageBulkSelectedEntryV1
                >({
                    units: plan.units,
                    signal: controller.signal,
                    start: async (unit) => {
                        const first = unit.entries[0];
                        if (first === undefined) throw new Error('triage:bulk:emptyUnit');
                        const destination = projectTriageNewSessionDestinationV1({
                            workspaceMode: action.workspaceMode,
                            creationKey: unit.creationKey,
                            settlement: draft.settlement,
                            ...(action.profileId === null ? {} : { profileId: action.profileId }),
                        });
                        if (destination.status === 'refused') throw new Error('triage:bulk:destinationRefused');
                        const result = await submitTriageEntrySessionStart(host, {
                            v: 1,
                            workspaceMode: action.workspaceMode,
                            entryRef: first.entryRef,
                            display: first.display,
                            destination: destination.destination,
                            // A `send` travels WITH the start, through the one
                            // owner that runs it between the link and the open
                            // (`sessions/entrySessionDelivery.ts`). Sending from
                            // here instead would repeat the exact defect that
                            // owner exists to fix: opening the Session retires
                            // this mount, so a send issued afterwards is skipped
                            // and the reader arrives at an empty Session. The
                            // idempotency key is this unit's creation key, so a
                            // resend of the same unit rejoins its durable input.
                            ...(action.target.kind === 'agent' && action.target.delivery === 'send'
                                ? {
                                    delivery: {
                                        kind: 'send' as const,
                                        ...(promptText === null || promptText.trim().length === 0
                                            ? {}
                                            : { text: promptText }),
                                        attachments: unit.entries.map((entry) => ({
                                            entryRef: entry.entryRef,
                                            display: entry.display,
                                            sourceInstanceId: entry.sourceInstance.sourceInstanceId,
                                            title: entry.presentation.label,
                                        })),
                                        idempotencyKey: unit.creationKey,
                                    },
                                }
                                : {}),
                        }, { signal: controller.signal });
                        started += 1;
                        if (!retired.current) {
                            setPhase(Object.freeze({ kind: 'starting', started, total }));
                        }
                        const sessionId = result.type === 'opened' || result.type === 'openPending'
                            ? result.sessionId
                            : null;
                        if (sessionId !== null) {
                            // The start Action links the entry it carried. Every
                            // other entry in this unit is the same relationship
                            // and reaches the same idempotent writer, so the
                            // Session cockpit lists all of them rather than one.
                            const secondaryLinks = await linkRemainingEntries(
                                host,
                                sessionId,
                                unit.entries.slice(1),
                                controller.signal,
                            );
                            const compose = await composeInto({
                                host,
                                action,
                                sessionId,
                                promptText,
                                entries: unit.entries,
                                signal: controller.signal,
                            });
                            return {
                                start: result,
                                entries: projectTriageBulkEntryOutcomesV1({
                                    entries: unit.entries,
                                    start: result,
                                    secondaryLinks,
                                    compose,
                                }),
                            };
                        }
                        return {
                            start: result,
                            entries: projectTriageBulkEntryOutcomesV1({
                                entries: unit.entries,
                                start: result,
                                secondaryLinks: [],
                                compose: 'notRequested',
                            }),
                        };
                    },
                });
                if (retired.current) return;
                setPhase(Object.freeze({
                    kind: 'settled',
                    results,
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

    const cancel = React.useCallback(() => { abort.current?.abort(); }, []);
    const reset = React.useCallback(() => { setPhase(IDLE); }, []);

    return React.useMemo(
        () => Object.freeze({ phase, run, cancel, reset }),
        [cancel, phase, reset, run],
    );
}

async function seedNewSession(input: Readonly<{
    host: TriageNewSessionSeedHostV1;
    entries: readonly TriageBulkSelectedEntryV1[];
    promptText: string | null;
    profileId: string | null;
    /**
     * The selection's one honest placement answer. An exact answer carries its
     * machine beside the path; ambiguous matches remain reader-selectable
     * candidates instead of becoming the first path in the array.
     */
    placement: TriageBulkSeedPlacementV1;
    signal: AbortSignal;
}>): Promise<Awaited<ReturnType<typeof requestTriageNewSessionSeed>>> {
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
    const seed: TriageNewSessionSeedV1 = {
        ...(text === undefined ? {} : { prompt: { text, mode: 'replace' as const } }),
        ...(input.profileId === null ? {} : { profileId: input.profileId }),
        ...(input.placement.kind !== 'exact' ? {} : {
            placement: {
                serverId: input.placement.placement.executionTarget.serverId,
                machineId: input.placement.placement.executionTarget.machineId,
                ...(input.placement.placement.directory === undefined
                    ? {}
                    : { directory: input.placement.placement.directory }),
            },
        }),
        ...(input.placement.kind !== 'candidates'
            ? {}
            : { candidates: input.placement.candidates.map(projectTriageSessionPlacementCandidateV1) }),
        ...(attachments.length === 0 ? {} : { attachments }),
    };
    return await requestTriageNewSessionSeed(input.host, seed, { signal: input.signal });
}

async function linkRemainingEntries(
    host: TriageSessionStartHostV1,
    sessionId: string,
    entries: readonly TriageBulkSelectedEntryV1[],
    signal: AbortSignal,
): Promise<readonly TriageBulkLinkOutcomeV1[]> {
    const outcomes: TriageBulkLinkOutcomeV1[] = [];
    for (const entry of entries) {
        // A failed link does not abort the unit: the Session exists and is
        // open, and losing it because one of six relationships could not be
        // written would be a worse outcome than a missing row in the cockpit.
        try {
            const result = await host.executeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                v: 1,
                sessionId,
                entryRef: entry.entryRef,
                display: entry.display,
            } as never, { signal });
            outcomes.push(isRecord(result) && result.status === 'linked'
                ? 'created'
                : 'conflictedOrUnavailable');
        } catch {
            outcomes.push('conflictedOrUnavailable');
        }
    }
    return outcomes;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `compose` action's write, which is the one delivery a mount still owns.
 *
 * A `send` never comes through here: it rides the start
 * (`actions/entrySessionProtocol.ts`) so it happens between the link and the
 * open, where no mount can be retired out from under it. A composer write has
 * no owner on the far side — the composer document is a host UI surface — so
 * this arm stays, and it carries EVERY entry of the unit rather than one:
 * "one Session with the whole selection attached" is what the destination
 * promises.
 */
async function composeInto(input: Readonly<{
    host: TriageBulkHostV1;
    action: TriageActionV1;
    sessionId: string;
    promptText: string | null;
    entries: readonly TriageBulkSelectedEntryV1[];
    signal: AbortSignal;
}>): Promise<TriageBulkComposeOutcomeV1> {
    const target = input.action.target;
    if (target.kind !== 'agent' || target.delivery !== 'compose') return 'notRequested';
    const plan = planTriageActionDeliveryV1({
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
    if (plan.kind !== 'compose') return 'notRequested';
    try {
        const ref = { kind: 'session', sessionId: input.sessionId };
        const composerHost = input.host as unknown as Readonly<{
            readComposer: (ref: unknown, options?: unknown) => Promise<unknown>;
            applyComposer: (ref: unknown, transaction: unknown, options?: unknown) => Promise<unknown>;
        }>;
        const read = await composerHost.readComposer(ref);
        if (!isRecord(read) || read.status !== 'ready' || !isRecord(read.snapshot)) return 'refused';
        const revision = read.snapshot.revision;
        if (typeof revision !== 'number') return 'refused';
        const operations: unknown[] = [];
        if (plan.text !== undefined) operations.push({ kind: 'text.set', text: plan.text });
        for (const attachment of plan.attachments) {
            operations.push({ kind: 'attachment.add', ...attachment });
        }
        const applied = await composerHost.applyComposer(ref, { expectedRevision: revision, operations });
        return isRecord(applied) && applied.status === 'applied' ? 'applied' : 'refused';
    } catch {
        // The Session was created, linked and opened. Reporting the press as
        // failed because a prompt could not be placed would be false.
        return 'refused';
    }
}
