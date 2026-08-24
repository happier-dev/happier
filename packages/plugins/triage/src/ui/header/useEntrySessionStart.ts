import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import { mintTriageOpaqueIdV1 } from '../../opaqueId.js';
import type {
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1,
} from '../../actions/entrySessionProtocol.js';
import { planTriageActionDeliveryV1 } from '../../sessions/actionDelivery.js';
import {
    readTriageActionExecutionPlacementV1,
    resolveTriageActionCheckoutV1,
    resolveTriageActionPlacementV1,
    type TriageActionPlacementV1,
} from '../../sessions/actionLaunch.js';
import {
    resolveTriageActionReferencesV1,
    type TriageActionReferencesV1,
    type TriageActionResolutionHostV1,
} from '../../sessions/actionResolution.js';
import type { TriageForgeIdentityV1 } from '../../sessions/launchPlacement.js';
import {
    readTriageAgentExecutionTargetV1,
    type TriageAgentInventoryHostV1,
} from '../../sessions/agentTarget.js';
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
    type TriageNewSessionPreferenceV1,
} from './newSessionDestination.js';
import {
    requestTriageNewSessionDraft,
    type TriageNewSessionDraftHostV1,
} from './newSessionDraftCommand.js';
import {
    requestTriageNewSessionSeed,
    type TriageNewSessionSeedHostV1,
    type TriageNewSessionSeedV1,
} from './newSessionSeedCommand.js';
import {
    submitTriageEntrySessionStart,
    type TriageSessionStartHostV1,
} from './startEntrySessionCommand.js';

/**
 * The common header's transient Session-start controller.
 *
 * One press resolves the pressed action's references and placement. Compose
 * hands those facts to the host's New Session authoring surface and stops;
 * send starts through this plugin's one start Action and delivers there. Each
 * of those belongs to an owner this module composes and none of them lives
 * here: the record's five answers to `settings/actions.ts`, the placement
 * precedence to `sessions/actionLaunch.ts`, the two reference reads to
 * `sessions/actionResolution.ts`, the workspace-mode gate, creation, link and
 * open to `sessions/entrySessionOrchestrator.ts`, and whether a settled start
 * may be reviewed in at all to `sessions/pullRequestReview.ts`.
 *
 * **This is where a configured action stops being a stored record.** Before
 * this, four of the five members A1 defines reached nothing: `profileId`,
 * `promptInvocationId`, `delivery` and `target.kind` were stored, wired and
 * edited, and every press produced the same empty agent Session. They are read
 * here, in that order, and every one of them changes what the press does.
 *
 * It is deliberately the only state in the whole start path, and it is
 * transient: an in-flight press and the last settled verdict, both scoped to
 * this mount. There is no local Session record, no optimistic link, no queue
 * and no retry policy.
 *
 * A press that arrives while one is in flight is ignored rather than queued:
 * two presses of one action are one request, and admitting the second would
 * open a second New Session surface and mint a second creation key for the
 * Session the first is already creating.
 */

export type TriageEntrySessionStartRequestV1 = Readonly<{
    /** The pressed action, whole. Every member of it decides something below. */
    action: TriageActionV1;
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
    /** This mount cannot open the host's New Session surface at all. */
    | 'newSessionUnsupported'
    /** It could not be opened, or settled something no start can be built from. */
    | 'newSessionUnavailable'
    /** The reachable wire cannot request a prepared review workspace. */
    | 'preparedWorkspaceUnsupported'
    /**
     * The action targets `review.start`, and nothing reachable can prepare the
     * workspace that contract scopes to.
     *
     * It is stated as its own reason and refused BEFORE anything is created,
     * because the alternative — the behaviour this replaces — was to start an
     * ordinary agent Session and let the reader believe a formal code review
     * had begun. `review.start` describes exact commits of a pull request in a
     * worktree a source prepared and reread; a Session with an agent in it is a
     * different product, however it is labelled.
     */
    | 'reviewStartUnsupported'
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
    /**
     * The catalog that owns a configured reference did not answer.
     *
     * Deliberately distinct from missing: nothing is known to be wrong with the
     * configuration, and retrying is exactly what can help.
     */
    | 'profileUnavailable'
    | 'promptUnavailable'
    /** The Action dispatch did not happen or did not answer in this contract's shape. */
    | 'dispatch';

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
    /** The canonical Session-input admission verdict, exactly as it answered. */
    | Readonly<{
        kind: 'send';
        status: 'notRequested' | 'none' | 'accepted' | 'alreadyAccepted' | 'rejected' | 'outcomeUnknown';
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
    | Readonly<{ kind: 'unavailable'; reason: TriageEntrySessionStartUnavailableReasonV1 }>;

export type TriageEntrySessionStartControllerV1 = Readonly<{
    phase: TriageEntrySessionStartPhaseV1;
    /** Ignored while a press is in flight; otherwise starts exactly one. */
    start: (request: TriageEntrySessionStartRequestV1) => void;
    /** Returns to `idle` — for dismissing a settled outcome, never for retrying one. */
    reset: () => void;
}>;

const IDLE: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'idle' });
const RESOLVING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'resolving' });
const CHOOSING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'choosing' });
const STARTING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'starting' });

function unavailable(
    reason: TriageEntrySessionStartUnavailableReasonV1,
): TriageEntrySessionStartPhaseV1 {
    return Object.freeze({ kind: 'unavailable', reason });
}

/** The side-effect-free refusal decided entirely by the action record. */
export function triageActionImmediateRefusalV1(
    action: Pick<TriageActionV1, 'target' | 'workspaceMode'>,
): TriageEntrySessionStartUnavailableReasonV1 | null {
    if (action.target.kind === 'reviewStart') return 'reviewStartUnsupported';
    return triageNewSessionWireMaterializationV1(action.workspaceMode) === null
        ? 'preparedWorkspaceUnsupported'
        : null;
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

type TriageStartHostV1 = TriageSessionStartHostV1
    & TriageNewSessionDraftHostV1
    & TriageNewSessionSeedHostV1
    & TriageProjectRegistryHostV1
    & TriageAgentInventoryHostV1
    & TriageActionResolutionHostV1;

/**
 * The minimal mounted fact a retry needs, and nothing more.
 *
 * A press that answered `creationPending`, `linkPending` or `openPending` left
 * something real behind: a creation the daemon may already have settled, a
 * Session with no link, or a linked Session that did not open. The header's
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
    entryKey: string;
    input: TriageStartEntrySessionInputV1;
    /** The phase the settled start stopped at, when it stopped at one. */
    pending?: NonNullable<TriageStartEntrySessionInputV1['resume']>;
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
    return result.type === 'opened' || result.type === 'openPending' ? result.delivery : 'none';
}

/** Component-wise entry identity, never a joined string. */
function sameEntry(left: TriageEntryRefV1, right: TriageEntryRefV1): boolean {
    return left.source.pluginId === right.source.pluginId
        && left.source.localId === right.source.localId
        && left.kindId === right.kindId
        && left.collisionScope === right.collisionScope
        && left.entryId === right.entryId;
}

export function useTriageEntrySessionStart(
    options?: TriageEntrySessionStartOptionsV1,
): TriageEntrySessionStartControllerV1 {
    const host = usePluginHostApi() as unknown as TriageStartHostV1;
    const [phase, setPhase] = React.useState<TriageEntrySessionStartPhaseV1>(IDLE);
    // Read synchronously by `start`, so two presses in one tick cannot both pass
    // the gate the way a state read would.
    const inFlight = React.useRef(false);
    const retired = React.useRef(false);
    // The one identity a retry repeats. Scoped to this mount, like every other
    // fact here: a Session the user navigates back to is reached through its
    // link, not through a remembered start.
    const custody = React.useRef<TriageEntrySessionStartCustodyV1 | null>(null);
    // Absent options resolve to the one module-level default, so the ordinary
    // caller keeps a referentially stable `start`.
    const mintCreationKey = options?.mintCreationKey ?? mintRandomCreationKey;

    React.useEffect(() => {
        retired.current = false;
        return () => { retired.current = true; };
    }, []);

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
    const resolvePlacement = React.useCallback(async (
        request: TriageEntrySessionStartRequestV1,
        preferences: Parameters<typeof resolveTriageActionPlacementV1>[0]['profile'],
    ): Promise<TriageActionPlacementV1> => {
        const registry = await readTriageProjectRegistryV1(host);
        return resolveTriageActionPlacementV1({
            workspaceMode: request.action.workspaceMode,
            ...(preferences === undefined ? {} : { profile: preferences }),
            ...(request.repository === undefined ? {} : { forge: request.repository }),
            projects: registry.status === 'read' ? registry.projects : [],
            registryComplete: registry.status === 'read' && registry.complete,
        });
    }, [host]);

    /**
     * Records a send start's verdict and decides whether a retry still has
     * something to resume. Compose returns before this callback is reachable.
     *
     * The delivery half is read from the start's own result rather than
     * re-asked: a `send` already happened, inside the start and before the open,
     * and the canonical admission verdict it answered with travels on the
     * result. Reporting anything other than that verdict is how a refusal used
     * to reach the reader as success.
     */
    const settle = React.useCallback(async (
        request: TriageEntrySessionStartRequestV1,
        input: TriageStartEntrySessionInputV1,
        result: TriageStartEntrySessionResultV1,
    ): Promise<void> => {
        // Custody is retained for exactly the arms a retry can resume, and
        // released for every terminal one. A `creationFailed` is terminal by the
        // orchestrator's own rule — no Session id is disclosed — so the next
        // visible press is a new logical request with a new key.
        custody.current = result.type === 'creationPending'
            ? { actionId: request.action.actionId, entryKey: input.entryRef.entryId, input }
            : result.type === 'linkPending' || result.type === 'openPending'
                ? {
                    actionId: request.action.actionId,
                    entryKey: input.entryRef.entryId,
                    input,
                    pending: {
                        phase: result.type,
                        sessionId: result.sessionId,
                        disposition: result.disposition,
                    },
                }
                // The Session opened, but delivery did not settle. Reuse the
                // incumbent open-pending resume arm: it re-delivers under the
                // retained key, then idempotently re-opens the same Session.
                : result.type === 'opened'
                    && result.delivery === 'outcomeUnknown'
                    && input.delivery !== undefined
                    ? {
                        actionId: request.action.actionId,
                        entryKey: input.entryRef.entryId,
                        input,
                        pending: {
                            phase: 'openPending',
                            sessionId: result.sessionId,
                            disposition: result.disposition,
                        },
                    }
                : null;

        const sessionId = result.type === 'opened' || result.type === 'openPending'
            ? result.sessionId
            : null;
        const delivery: TriageEntrySessionDeliveryOutcomeV1 = sessionId === null
            ? { kind: 'none' }
            : input.delivery !== undefined
                ? { kind: 'send', status: readSendStatus(result) }
                : { kind: 'none' };
        if (!retired.current) {
            setPhase(Object.freeze({ kind: 'settled', result, delivery }));
        }
    }, []);

    const start = React.useCallback((request: TriageEntrySessionStartRequestV1) => {
        if (inFlight.current) return;
        const action = request.action;
        // Refused before anything opens. Asking the reader to pick an Agent and
        // a directory for a start this wire cannot carry spends their choice on
        // a refusal they could have been told about first.
        // 0. The arm the action DECLARED, read before anything else and never
        //    inferred from its label (`PLAN.md` §0a A1). This is the whole
        //    point of `target.kind` being a member: until now nothing read it,
        //    so a `reviewStart` action started an ordinary agent Session and
        //    called it a review. `review.start` scopes to the exact commits of
        //    a pull request in a source-prepared worktree, and the reachable
        //    start wire cannot request one — so the press is refused here, with
        //    that stated, rather than silently becoming a different product.
        const immediateRefusal = triageActionImmediateRefusalV1(action);
        if (immediateRefusal !== null) {
            setPhase(unavailable(immediateRefusal));
            return;
        }
        inFlight.current = true;

        // A retry of the SAME press on the SAME entry. Everything the first
        // press resolved — its references, its placement, the destination the
        // reader settled on — is already decided, so re-deciding it would spend
        // their choice again and mint a second identity for one Session. It goes
        // straight back to the start Action with the retained input, plus the
        // phase to resume when the first press stopped at one.
        const retained = custody.current;
        if (retained && retained.actionId === action.actionId && sameEntry(retained.input.entryRef, request.entryRef)) {
            setPhase(STARTING);
            void (async () => {
                try {
                    const input: TriageStartEntrySessionInputV1 = retained.pending === undefined
                        ? retained.input
                        : { ...retained.input, resume: retained.pending };
                    const result = await submitTriageEntrySessionStart(host, input);
                    await settle(request, retained.input, result);
                } catch {
                    if (!retired.current) setPhase(unavailable('dispatch'));
                } finally {
                    inFlight.current = false;
                }
            })();
            return;
        }

        setPhase(RESOLVING);
        void (async () => {
            try {
                // 1. BOTH references, resolved before any side effect. A
                //    configured reference that cannot be honoured refuses the
                //    press here — never after a Session exists, and never by
                //    quietly degrading to the default the person configured
                //    away from.
                const references = await resolveTriageActionReferencesV1(host, action);
                if (retired.current) return;
                if (references.status !== 'resolved') {
                    setPhase(unavailable(referenceRefusal(references)));
                    return;
                }
                const preferences = references.profile?.preferences;
                const promptText = references.prompt?.text ?? null;

                // 2. Placement, in the one stated precedence.
                const preference = request.preference ?? {};
                const placement = preference.directory
                    ? null
                    : await resolvePlacement(request, preferences);
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
                //    A one-click launch reuses the resolved checkout, so it can
                //    only answer `reuseWorkspace` and `none`; `createWorktree`
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

                // Compose is authoring, not Session creation. Hand the resolved
                // profile, prompt, placement and entry attachment to the host's
                // incumbent New Session composer and stop. That screen owns all
                // subsequent edits and the eventual send; closing it therefore
                // creates no Session, link or Message and spends no creation key.
                if (action.target.kind === 'agent' && action.target.delivery === 'compose') {
                    const delivery = planTriageActionDeliveryV1({
                        delivery: 'compose',
                        promptText,
                        entries: [{
                            entryRef: request.entryRef,
                            sourceInstance: request.sourceInstance,
                            presentation: request.presentation,
                            ...(request.lastKnownLocator === undefined
                                ? {}
                                : { lastKnownLocator: request.lastKnownLocator }),
                        }],
                    });
                    const seed: TriageNewSessionSeedV1 = {
                        ...(delivery.kind === 'compose' && delivery.text !== undefined
                            ? { prompt: { text: delivery.text, mode: 'replace' as const } }
                            : {}),
                        ...(action.profileId === null ? {} : { profileId: action.profileId }),
                        ...(executionPlacement === null ? {} : {
                            placement: {
                                serverId: executionPlacement.executionTarget.serverId,
                                machineId: executionPlacement.executionTarget.machineId,
                                ...(executionPlacement.directory === undefined
                                    ? {}
                                    : { directory: executionPlacement.directory }),
                            },
                        }),
                        ...(placement !== null && placement.kind === 'prefill' && placement.candidates.length > 0
                            ? { candidates: placement.candidates.map(projectTriageSessionPlacementCandidateV1) }
                            : {}),
                        ...(delivery.kind === 'compose' && delivery.attachments.length > 0
                            ? { attachments: delivery.attachments }
                            : {}),
                    };
                    setPhase(CHOOSING);
                    const seeded = await requestTriageNewSessionSeed(host, seed);
                    if (retired.current) return;
                    setPhase(seeded.status === 'seeded'
                        ? IDLE
                        : unavailable(seeded.status === 'unsupported'
                            ? 'newSessionUnsupported'
                            : 'newSessionUnavailable'));
                    return;
                }

                const checkoutIsDirectlyLaunchable = checkout === 'none' || checkout === 'reuseWorkspace';
                const preferredAgentTargetKey = references.profile?.preferredAgentTargetKey;
                const agent = checkoutIsDirectlyLaunchable
                    && executionPlacement?.directory !== undefined
                    && preferredAgentTargetKey !== undefined
                    ? await readTriageAgentExecutionTargetV1(host, preferredAgentTargetKey)
                    : null;
                if (retired.current) return;

                // Both routes settle the SAME three facts and are admitted by
                // the same grammar below, so a direct launch cannot carry a
                // start shape the host's own settlement could not.
                let settlement: unknown;
                if (agent?.status === 'resolved' && executionPlacement?.directory !== undefined) {
                    settlement = {
                        executionTarget: executionPlacement.executionTarget,
                        agentTarget: agent.agentTarget,
                        directory: executionPlacement.directory,
                    };
                } else {
                    const seed = triageNewSessionDraftSeedV1(
                        preference,
                        ...(placement === null ? [] : [{
                            ...(action.profileId === null ? {} : { profileId: action.profileId }),
                            checkoutIntent: checkout,
                            placement,
                        }]),
                    );
                    setPhase(CHOOSING);
                    const draft = await requestTriageNewSessionDraft(host, seed);
                    if (retired.current) return;
                    if (draft.status === 'cancelled') {
                        // The reader closed the surface. Nothing was chosen,
                        // nothing failed, and no creation key was spent.
                        setPhase(IDLE);
                        return;
                    }
                    if (draft.status !== 'settled') {
                        setPhase(unavailable(
                            draft.status === 'unsupported' ? 'newSessionUnsupported' : 'newSessionUnavailable',
                        ));
                        return;
                    }
                    settlement = draft.settlement;
                }
                const destination = projectTriageNewSessionDestinationV1({
                    workspaceMode: action.workspaceMode,
                    creationKey: mintCreationKey(),
                    settlement,
                    ...(action.profileId === null ? {} : { profileId: action.profileId }),
                });
                if (destination.status === 'refused') {
                    setPhase(unavailable(destination.reason === 'preparedWorkspaceUnsupported'
                        ? 'preparedWorkspaceUnsupported'
                        : 'newSessionUnavailable'));
                    return;
                }
                setPhase(STARTING);
                // 3. A send travels with the start so it settles between link
                //    and open. Compose returned above before anything existed.
                const input: TriageStartEntrySessionInputV1 = {
                    v: 1,
                    workspaceMode: action.workspaceMode,
                    entryRef: request.entryRef,
                    display: request.display,
                    destination: destination.destination,
                    ...(action.target.kind === 'agent' && action.target.delivery === 'send'
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
                            },
                        }
                        : {}),
                };
                const result = await submitTriageEntrySessionStart(host, input);
                await settle(request, input, result);
            } catch {
                if (!retired.current) setPhase(unavailable('dispatch'));
            } finally {
                inFlight.current = false;
            }
        })();
    }, [host, mintCreationKey, resolvePlacement, settle]);

    const reset = React.useCallback(() => { setPhase(IDLE); }, []);

    return React.useMemo(
        () => Object.freeze({ phase, start, reset }),
        [phase, reset, start],
    );
}
