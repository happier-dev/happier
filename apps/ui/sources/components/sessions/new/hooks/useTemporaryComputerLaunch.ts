import * as React from 'react';
import type {
    RunnerActivationCreateRequestV1,
} from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { RunnerMaterializationResponseV1 } from '@happier-dev/protocol/ephemeralRunner/materialization';
import type { RunnerActivationProgressPhaseV1 } from '@happier-dev/protocol/ephemeralRunner/progress';
import { EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { TemporaryComputerActivationRefV1 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';

import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    isLaunchProfileIncompatibility,
    resolveLaunchProfileIncompatibility,
    type LaunchProfileIncompatibility,
} from '../modules/profileHelpers';

export type TemporaryComputerLaunchStatus = RunnerActivationProgressPhaseV1
    /**
     * Launch steps this surface derives itself. `connected`,
     * `installing_agent` and `creating_session` come from the activation
     * projection's own state/review/readiness; `preparing_encryption` is the
     * creator's local work before it publishes the materialization. None of
     * them is an endpoint-reported phase.
     */
    | 'connected'
    | 'installing_agent'
    | 'preparing_encryption'
    | 'creating_session'
    /**
     * The creator preflight refused the frozen submission because the target
     * Account no longer resolves the reviewed Profile or its exact secrets.
     * These are deliberately distinct from `failed`: nothing was created, the
     * answer is deterministic, and the only recovery is editing the request.
     */
    | LaunchProfileIncompatibility
    | 'idle'
    /**
     * A reopened draft already carries an activation reference, and the
     * canonical server projection has not answered yet. The composer must stay
     * frozen through this window: showing an editable draft here invites the
     * user to edit and resend a request whose package is already live on
     * someone else's computer.
     */
    | 'reconciling'
    | 'preparing'
    | 'waiting_for_computer'
    | 'review_unavailable'
    | 'waiting_for_approval'
    | 'materialization_unavailable'
    | 'canceling'
    | 'cancel_failed'
    | 'failed'
    | 'succeeded';

export class TemporaryComputerLaunchDependencyUnavailableError extends Error {
    constructor(readonly dependency: 'activation' | 'review' | 'materialization') {
        super(`runner_creator_${dependency}_dependency_unavailable`);
        this.name = 'TemporaryComputerLaunchDependencyUnavailableError';
    }
}

type RunnerMaterializationFailureV1 = Exclude<
    RunnerMaterializationResponseV1,
    { status: 'materialized' }
>;

/** A definitive materialization domain result is not a transient transport failure. */
export class TemporaryComputerMaterializationResultError extends Error {
    readonly retryable = false;
    readonly status: RunnerMaterializationFailureV1['status'];
    readonly reason: RunnerMaterializationFailureV1['reason'];

    constructor(result: RunnerMaterializationFailureV1) {
        super(`runner_materialization_${result.status}_${result.reason}`);
        this.name = 'TemporaryComputerMaterializationResultError';
        this.status = result.status;
        this.reason = result.reason;
    }
}

export class TemporaryComputerActivationClosedError extends Error {
    readonly retryable = false;

    constructor(readonly reason: RunnerActivationProjectionV1['closeReason']) {
        super(`runner_activation_closed_${reason ?? 'unknown'}`);
        this.name = 'TemporaryComputerActivationClosedError';
    }
}

export function isTemporaryComputerLaunchErrorRetryable(error: unknown): boolean {
    if (error instanceof TemporaryComputerMaterializationResultError) return false;
    if (error instanceof TemporaryComputerActivationClosedError) return false;
    // A Profile the target Account changed, deleted, or can no longer supply
    // secrets for answers the same way on every attempt. Only transient and
    // transport failures keep the ordinary retry.
    if (resolveLaunchProfileIncompatibility(error) !== null) return false;
    return !(error instanceof RunnerActivationClientError) || error.retryable;
}

export type TemporaryComputerPublicActivationRef = TemporaryComputerActivationRefV1;

export type TemporaryComputerPreparedActivation = Readonly<{
    request: RunnerActivationCreateRequestV1;
    createdOnDeviceLabel: string;
    acceptCreated?: (projection: RunnerActivationProjectionV1) => Promise<void>;
    /** Removes unbound local custody when create is definitively rejected. */
    discard?: () => Promise<void>;
}>;

export type TemporaryComputerLaunchController = Readonly<{
    status: TemporaryComputerLaunchStatus;
    projection: RunnerActivationProjectionV1 | null;
    error: unknown;
    start: () => Promise<void>;
    retry: () => Promise<void>;
    cancel: () => Promise<void>;
    refresh: () => Promise<void>;
    dismissTerminal: () => void;
    /** Dismisses one acknowledged pre-materialization close and creates a fresh package. */
    replaceTerminal: () => Promise<void>;
}>;

export type TemporaryComputerLaunchObservation = Pick<
    TemporaryComputerLaunchController,
    'status' | 'projection' | 'error' | 'refresh'
>;

// A React remount can overlap the preceding hook instance while its asynchronous
// preparation is still populating exact draft custody. Keep that one same-process
// operation authoritative until it reaches terminal cleanup; the successor then
// reconciles the canonical server row before it may prepare or allocate again.
const activeDraftLaunchFences = new Map<string, Promise<void>>();

async function runWithDraftLaunchFence<T>(key: string, operation: () => Promise<T>): Promise<T> {
    while (true) {
        const incumbent = activeDraftLaunchFences.get(key);
        if (incumbent) {
            await incumbent;
            continue;
        }
        let release!: () => void;
        const fence = new Promise<void>((resolve) => { release = resolve; });
        activeDraftLaunchFences.set(key, fence);
        try {
            return await operation();
        } finally {
            if (activeDraftLaunchFences.get(key) === fence) activeDraftLaunchFences.delete(key);
            release();
        }
    }
}

export function projectTemporaryComputerLaunchStatus(
    projection: RunnerActivationProjectionV1,
): TemporaryComputerLaunchStatus {
    switch (projection.state) {
        case 'pending': return 'waiting_for_computer';
        // The creator must freeze the exact Lane 10 credential selection into
        // the review before the endpoint can consent. A claim without that
        // review is not "waiting for approval": no approval can happen yet.
        // Keep this truthful and fail closed until the canonical Lane 10
        // producer is wired; never fabricate resource or broker identities in
        // this consumer.
        case 'claimed': return projection.review === null ? 'connected' : 'waiting_for_approval';
        // Readiness is the durable fact that the endpoint finished installing
        // and probing and is now creating the Session. Between consent and
        // readiness the only step no durable column expresses is the AI-access
        // check, which is the one phase the endpoint still reports.
        case 'consented': return projection.readiness !== null
            ? 'creating_session'
            : projection.progressPhase ?? 'installing_agent';
        case 'materialized': return 'succeeded';
        case 'closed': return 'failed';
    }
}

/**
 * Mounted lifecycle owner for one canonical draft entry. It reopens by draft id,
 * keeps failed cancellation visible, and publishes only the public reference.
 * Signing-key allocation and package custody stay behind `prepareActivation`.
 */
export function useTemporaryComputerLaunch(input: Readonly<{
    client: RunnerActivationClient | null;
    /** Exact Home whose content-free Account-change wake invalidates this projection. */
    serverId: string | null;
    draftId: string;
    /** Exact Account/Home/draft identity used to fence overlapping creator mounts. */
    draftLaunchOperationKey?: string;
    existingPublicRef: TemporaryComputerPublicActivationRef | null;
    prepareActivation: (signal: AbortSignal) => Promise<TemporaryComputerPreparedActivation>;
    persistPublicRef: (reference: TemporaryComputerPublicActivationRef) => void;
    /** Exact reviewed-authoring producer. Omission is a typed fail-closed dependency state. */
    prepareReview?: (projection: RunnerActivationProjectionV1, signal: AbortSignal) => Promise<void>;
    /** Exact materialization producer. It is invoked only after reviewed endpoint readiness exists. */
    materialize?: (projection: RunnerActivationProjectionV1) => Promise<RunnerMaterializationResponseV1>;
    /**
     * Retires creator-only signing custody once the creator's own proof is
     * published. The activation signing identity signs the scoped Machine
     * content-key proof carried by the review, so it is retained through review
     * publication rather than dropped at the endpoint claim.
     */
    onClaimed?: (projection: RunnerActivationProjectionV1) => Promise<void> | void;
    onMaterialized: (sessionId: string, projection: RunnerActivationProjectionV1) => Promise<void> | void;
    /** Removes exact device-local/public custody only after server-acknowledged closure. */
    onClosed?: (projection: RunnerActivationProjectionV1) => Promise<void> | void;
    /** Abandons private custody when creation failed before a server activation existed. */
    onAbandoned?: () => Promise<void> | void;
    /**
     * Sends the composer again, through the one submission owner.
     *
     * A replacement package is a fresh submission: closure released this draft's
     * creator settlement custody, and only the Send owner allocates another one.
     * Restarting this controller directly would prepare an activation whose
     * custody no longer exists. An observing device supplies none, so its
     * replacement action only clears the acknowledged terminal projection.
     */
    requestReplacementLaunch?: () => Promise<void> | void;
}>): TemporaryComputerLaunchController {
    const [status, setStatus] = React.useState<TemporaryComputerLaunchStatus>('idle');
    const [projection, setProjection] = React.useState<RunnerActivationProjectionV1 | null>(null);
    const latestProjectionRef = React.useRef(projection);
    latestProjectionRef.current = projection;
    const [error, setError] = React.useState<unknown>(null);
    const inFlightRef = React.useRef(false);
    const preparationAbortControllerRef = React.useRef<AbortController | null>(null);
    const preparationCanceledRef = React.useRef(false);
    const activationCreateStartedRef = React.useRef(false);
    const pendingPreparedRef = React.useRef<TemporaryComputerPreparedActivation | null>(null);
    const completedActivationIdsRef = React.useRef(new Set<string>());
    const completingActivationIdsRef = React.useRef(new Set<string>());
    const closedActivationIdsRef = React.useRef(new Set<string>());
    const dismissedClosedActivationIdsRef = React.useRef(new Set<string>());
    const closureCleanupFailedIdsRef = React.useRef(new Set<string>());
    const claimedActivationIdsRef = React.useRef(new Set<string>());
    const claimingActivationIdsRef = React.useRef(new Set<string>());
    const [claimRetirementRevision, setClaimRetirementRevision] = React.useState(0);
    const materializingActivationIdsRef = React.useRef(new Set<string>());
    const refreshAbortControllerRef = React.useRef<AbortController | null>(null);
    const mountedRef = React.useRef(true);
    const lifecycleCallbacksRef = React.useRef({
        prepareReview: input.prepareReview,
        materialize: input.materialize,
        onClaimed: input.onClaimed,
        onMaterialized: input.onMaterialized,
        onClosed: input.onClosed,
    });
    lifecycleCallbacksRef.current = {
        prepareReview: input.prepareReview,
        materialize: input.materialize,
        onClaimed: input.onClaimed,
        onMaterialized: input.onMaterialized,
        onClosed: input.onClosed,
    };
    React.useEffect(() => () => {
        mountedRef.current = false;
        refreshAbortControllerRef.current?.abort(new Error('runner_activation_projection_read_unmounted'));
        refreshAbortControllerRef.current = null;
    }, []);

    const completeMaterialized = React.useCallback((next: RunnerActivationProjectionV1) => {
        if (
            next.state !== 'materialized'
            || !next.materialization
            || completedActivationIdsRef.current.has(next.activationId)
            || completingActivationIdsRef.current.has(next.activationId)
        ) return;
        completingActivationIdsRef.current.add(next.activationId);
        if (mountedRef.current) {
            setError(null);
            setStatus('creating_session');
        }
        void Promise.resolve(lifecycleCallbacksRef.current.onMaterialized(next.materialization.sessionId, next)).then(() => {
            completedActivationIdsRef.current.add(next.activationId);
            if (!mountedRef.current) return;
            setError(null);
            setStatus('succeeded');
        }).catch((caught) => {
            if (!mountedRef.current) return;
            setError(caught);
            setStatus('failed');
        }).finally(() => {
            completingActivationIdsRef.current.delete(next.activationId);
        });
    }, []);

    const acceptProjection = React.useCallback((next: RunnerActivationProjectionV1) => {
        if (!mountedRef.current) return;
        const closureAlreadyHandled = next.state === 'closed'
            && closedActivationIdsRef.current.has(next.activationId);
        setProjection(next);
        setError(null);
        const onClaimed = lifecycleCallbacksRef.current.onClaimed;
        // Retirement is owed by the first projection that carries the published
        // review: that proof is signed with the activation signing key, so the
        // claim alone must not retire it.
        const claimRetirementRequired = next.state !== 'closed'
            && next.review !== null
            && onClaimed !== undefined;
        const claimRetirementComplete = !claimRetirementRequired
            || claimedActivationIdsRef.current.has(next.activationId);
        if (claimRetirementRequired
            && !claimRetirementComplete
            && !claimingActivationIdsRef.current.has(next.activationId)) {
            claimingActivationIdsRef.current.add(next.activationId);
            void Promise.resolve(onClaimed(next)).then(() => {
                claimedActivationIdsRef.current.add(next.activationId);
                if (!mountedRef.current) return;
                setError(null);
                if (next.state === 'materialized') completeMaterialized(next);
                else setStatus(projectTemporaryComputerLaunchStatus(next));
                setClaimRetirementRevision((current) => current + 1);
            }).catch((caught) => {
                // Make the retry slot available before publishing the retryable
                // failure. A user retry triggered by that render must not still
                // observe this completed attempt as in flight.
                claimingActivationIdsRef.current.delete(next.activationId);
                if (!mountedRef.current) return;
                setError(caught);
                setStatus('failed');
            }).finally(() => {
                claimingActivationIdsRef.current.delete(next.activationId);
            });
        }
        // Custody retirement is a security-sensitive local commit.
        // Materialization and materialized-session presentation cannot race it.
        if (!claimRetirementComplete) return;
        if (next.state === 'materialized') completeMaterialized(next);
        else if (!closureAlreadyHandled) setStatus(projectTemporaryComputerLaunchStatus(next));
        if (next.state === 'closed' && !closureAlreadyHandled) {
            closedActivationIdsRef.current.add(next.activationId);
            // An observer without custody cleanup must retain the authoritative
            // closed projection. Only the mounted creator flow that supplies
            // `onClosed` may clear its exact local/public custody after ACK.
            const onClosed = lifecycleCallbacksRef.current.onClosed;
            if (!onClosed) return;
            void Promise.resolve(onClosed(next)).then(() => {
                closureCleanupFailedIdsRef.current.delete(next.activationId);
                if (!mountedRef.current) return;
                // Preserve the acknowledged terminal outcome until the user
                // dismisses it. Cleanup and draft unfreezing are already done;
                // this is presentation of the one canonical close fact, not a
                // second lifecycle or a retryable failure.
                setProjection(next);
                setError(new TemporaryComputerActivationClosedError(next.closeReason));
                setStatus('failed');
            }).catch((caught) => {
                // Preserve the acknowledged closed projection and wait for an
                // explicit retry. Polling the same server row must not turn a
                // failed local custody cleanup into an invisible auto-retry.
                closureCleanupFailedIdsRef.current.add(next.activationId);
                if (!mountedRef.current) return;
                setError(caught);
                setStatus('cancel_failed');
            });
        }
    }, [completeMaterialized]);

    // One reconciliation identity per (draft, referenced activation). Until the
    // canonical projection for the *current* identity has answered, a draft that
    // advertises an activation stays frozen rather than briefly editable.
    const reconciliationKey = `${input.draftId}\u0000${input.existingPublicRef?.activationId ?? ''}`;
    const [reconciledKey, setReconciledKey] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        // Explicit start/cancel owns its own reconciliation and terminal
        // outcome. A mount/wake observer that begins during that operation must
        // not race it and later reset a visible failure or acknowledged close.
        if (!input.client || inFlightRef.current) return;
        // One in-flight safe projection read at a time. A superseded or unmounted
        // read is cancellation, never a failed launch attempt.
        refreshAbortControllerRef.current?.abort(new Error('runner_activation_projection_read_superseded'));
        const refreshAbortController = new AbortController();
        refreshAbortControllerRef.current = refreshAbortController;
        try {
            const next = input.existingPublicRef
                ? await input.client.read(input.existingPublicRef.activationId, refreshAbortController.signal)
                : await input.client.readByDraft(input.draftId, refreshAbortController.signal);
            acceptProjection(next);
        } catch (caught) {
            if (!mountedRef.current || refreshAbortController.signal.aborted) return;
            if (
                !input.existingPublicRef
                && caught instanceof RunnerActivationClientError
                && caught.code === 'not_found'
            ) {
                // An automatic recovery read may finish after the user has
                // canceled preparation. Do not overwrite that truthful
                // in-flight cancellation state with an idle projection.
                if (inFlightRef.current) return;
                setProjection(null);
                setError(null);
                setStatus('idle');
                return;
            }
            // Without a reference, this read only asks whether an older client
            // left an activation behind for the draft. A Home that never answered
            // is not evidence of one, so it must not freeze a draft the user never
            // sent to a temporary computer. Send repeats the same recovery read
            // before creating anything and fails there if it still cannot answer.
            if (
                !input.existingPublicRef
                && latestProjectionRef.current === null
                && caught instanceof RunnerActivationClientError
                && (caught.code === 'request_failed' || caught.code === 'unavailable')
            ) return;
            setError(caught);
            setStatus((current) => current === 'canceling' ? 'cancel_failed' : 'failed');
        } finally {
            if (refreshAbortControllerRef.current === refreshAbortController) {
                refreshAbortControllerRef.current = null;
                // A superseded read must not settle reconciliation: only the read
                // that still owns the transport answered for this identity.
                if (mountedRef.current && !refreshAbortController.signal.aborted) {
                    setReconciledKey(reconciliationKey);
                }
            }
        }
    }, [acceptProjection, input.client, input.draftId, input.existingPublicRef, reconciliationKey]);

    const refreshRef = React.useRef(refresh);
    refreshRef.current = refresh;
    // One reconciliation read per transport and activation identity. Keying this
    // on the `refresh` closure instead would refetch on every render, because
    // the mounted owner passes fresh lifecycle callbacks each time — a
    // render-driven request loop, and a freshness signal that lies about where
    // currentness comes from.
    React.useEffect(() => {
        if (!input.client) return;
        void refreshRef.current();
    }, [input.client, input.draftId, input.existingPublicRef?.activationId]);

    // Endpoint-driven transitions (claim, endpoint facts, consent, readiness,
    // decline) are the only activation facts this creator cannot learn from its
    // own request result. The Home already publishes a content-free
    // Account-change wake for them, so freshness is that wake plus one exact
    // refetch of the canonical projection — never a timer. `refresh` also
    // remains the manual retry the surface offers when a wake is missed.
    React.useEffect(() => {
        if (!input.client || !input.serverId) return;
        if (!projection || !['pending', 'claimed', 'consented'].includes(projection.state)) return;
        const serverId = input.serverId;
        return subscribeHomeAccountChange((event) => {
            if (event.serverId !== serverId) return;
            // A conservative wake omits entity ids and must still refetch.
            if (event.entityIds !== undefined
                && !event.entityIds.includes(EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1)) return;
            void refreshRef.current();
        });
    }, [input.client, input.serverId, projection?.state]);

    // One live review producer per claimed, still-unreviewed activation. An
    // identical refetch (a wake, a manual refresh) keeps that producer instead
    // of cancelling it: nothing would start a replacement while it still held
    // the activation. A finished or failed attempt releases its own ownership
    // only, so the next projection read retries a failure exactly as before.
    // The producer is aborted only when its activation leaves that state, is
    // replaced by another activation, or the owner unmounts.
    const reviewOwnerRef = React.useRef<Readonly<{ activationId: string; controller: AbortController }> | null>(null);
    React.useEffect(() => {
        if (!projection || projection.state !== 'claimed' || projection.review !== null) return;
        const prepareReview = lifecycleCallbacksRef.current.prepareReview;
        if (!prepareReview) {
            setStatus('review_unavailable');
            return;
        }
        if (reviewOwnerRef.current?.activationId === projection.activationId) {
            // The live producer continues; the refetched projection must not
            // present this activation as idle while it is still preparing.
            setStatus('preparing_encryption');
            return;
        }
        reviewOwnerRef.current?.controller.abort(new Error('runner_activation_review_superseded'));
        const owner = { activationId: projection.activationId, controller: new AbortController() } as const;
        reviewOwnerRef.current = owner;
        setStatus('preparing_encryption');
        setError(null);
        void prepareReview(projection, owner.controller.signal).then(() => refreshRef.current()).catch((caught) => {
            if (owner.controller.signal.aborted) return;
            if (!mountedRef.current) return;
            setError(caught);
            setStatus(caught instanceof TemporaryComputerLaunchDependencyUnavailableError && caught.dependency === 'review'
                ? 'review_unavailable'
                : 'failed');
        }).finally(() => {
            if (reviewOwnerRef.current === owner) reviewOwnerRef.current = null;
        });
    }, [input.prepareReview !== undefined, projection]);
    const reviewTargetActivationId = projection?.state === 'claimed' && projection.review === null
        ? projection.activationId
        : null;
    React.useEffect(() => () => {
        const owner = reviewOwnerRef.current;
        if (owner && owner.activationId === reviewTargetActivationId) {
            owner.controller.abort(new Error('runner_activation_review_superseded'));
            reviewOwnerRef.current = null;
        }
    }, [reviewTargetActivationId]);

    React.useEffect(() => {
        if (!projection || projection.state !== 'consented' || projection.readiness === null) return;
        if (input.onClaimed && !claimedActivationIdsRef.current.has(projection.activationId)) return;
        const materialize = lifecycleCallbacksRef.current.materialize;
        if (!materialize) {
            setStatus('materialization_unavailable');
            return;
        }
        if (materializingActivationIdsRef.current.has(projection.activationId)) return;
        materializingActivationIdsRef.current.add(projection.activationId);
        setStatus('creating_session');
        setError(null);
        void materialize(projection).then(async (result) => {
            if (result.status === 'unavailable' && [
                'activation_closed',
                'activation_expired',
                'consent_required',
                'readiness_required',
            ].includes(result.reason)) {
                // These results say our observed projection lost currentness.
                // Re-read the one canonical lifecycle instead of retrying the
                // effect or inventing a parallel terminal state locally.
                await refresh();
                return;
            }
            if (result.status !== 'materialized') {
                throw new TemporaryComputerMaterializationResultError(result);
            }
            if (result.result.activationId !== projection.activationId) {
                throw new RunnerActivationClientError('malformed_response', 502, true);
            }
            await refresh();
        }).catch((caught) => {
            if (!mountedRef.current) return;
            setError(caught);
            setStatus(caught instanceof TemporaryComputerLaunchDependencyUnavailableError && caught.dependency === 'materialization'
                ? 'materialization_unavailable'
                : 'failed');
        }).finally(() => {
            materializingActivationIdsRef.current.delete(projection.activationId);
        });
    }, [claimRetirementRevision, input.materialize !== undefined, input.onClaimed !== undefined, projection, refresh]);

    const start = React.useCallback(async () => {
        if (!input.client) {
            const unavailable = new TemporaryComputerLaunchDependencyUnavailableError('activation');
            setError(unavailable);
            setStatus('failed');
            throw unavailable;
        }
        if (inFlightRef.current) return;
        // The fenced continuation below is a nested closure: hold the narrowed
        // client so its non-null proof survives into it.
        const activationClient = input.client;
        // An explicit launch owns a fresh canonical recovery read below. Stop a
        // mount-time observer from settling `not_found` after this attempt and
        // erasing its truthful failure/cancellation state back to `idle`.
        refreshAbortControllerRef.current?.abort(new Error('runner_activation_projection_read_superseded_by_start'));
        refreshAbortControllerRef.current = null;
        inFlightRef.current = true;
        preparationCanceledRef.current = false;
        const preparationAbortController = new AbortController();
        preparationAbortControllerRef.current = preparationAbortController;
        setStatus('preparing');
        setError(null);
        const draftLaunchOperationKey = input.draftLaunchOperationKey
            ?? `${input.serverId ?? ''}\u0000${input.draftId}`;
        await runWithDraftLaunchFence(draftLaunchOperationKey, async () => {
        try {
            // Recover the canonical server-owned activation first. This also
            // protects drafts written by an older client that did not retain
            // the public activation reference.
            // Deliberately not signal-bound: this read is the reconciliation step
            // that tells cancel whether a server activation already exists.
            // Aborting it would settle to idle while a live package stays open.
            if (!pendingPreparedRef.current) try {
                const recovered = input.existingPublicRef
                    ? await activationClient.read(input.existingPublicRef.activationId)
                    : await activationClient.readByDraft(input.draftId);
                if (preparationCanceledRef.current && recovered.state !== 'closed' && recovered.state !== 'materialized') {
                    if (mountedRef.current) {
                        setProjection(recovered);
                        setStatus('canceling');
                    }
                    try {
                        acceptProjection(await activationClient.cancel(recovered.activationId));
                    } catch (caught) {
                        if (mountedRef.current) {
                            setError(caught);
                            setStatus('cancel_failed');
                        }
                    }
                    return;
                }
                if (!(recovered.state === 'closed'
                    && dismissedClosedActivationIdsRef.current.has(recovered.activationId))) {
                    acceptProjection(recovered);
                    return;
                }
            } catch (caught) {
                if (!(caught instanceof RunnerActivationClientError) || caught.code !== 'not_found') {
                    throw caught;
                }
            }
            const prepared = pendingPreparedRef.current ?? await input.prepareActivation(preparationAbortController.signal);
            pendingPreparedRef.current = prepared;
            if (preparationCanceledRef.current) {
                await prepared.discard?.();
                pendingPreparedRef.current = null;
                await input.onAbandoned?.();
                if (mountedRef.current) {
                    setError(null);
                    setStatus('idle');
                }
                return;
            }
            // Once the create request begins we deliberately stop aborting the
            // transport. A canceled fetch has an unknowable server outcome; an
            // exact completed activation can instead be closed canonically.
            preparationAbortControllerRef.current = null;
            activationCreateStartedRef.current = true;
            let next: RunnerActivationProjectionV1;
            try {
                next = await activationClient.create(prepared.request);
            } catch (caught) {
                if (!preparationCanceledRef.current && !isTemporaryComputerLaunchErrorRetryable(caught)) {
                    await prepared.discard?.();
                    pendingPreparedRef.current = null;
                }
                throw caught;
            } finally {
                activationCreateStartedRef.current = false;
            }
            await prepared.acceptCreated?.(next);
            pendingPreparedRef.current = null;
            input.persistPublicRef({
                v: 1,
                activationId: next.activationId,
                createdOnDeviceLabel: prepared.createdOnDeviceLabel,
            });
            if (preparationCanceledRef.current) {
                setProjection(next);
                setStatus('canceling');
                try {
                    const canceled = await activationClient.cancel(next.activationId);
                    acceptProjection(canceled);
                } catch (caught) {
                    if (mountedRef.current) {
                        setError(caught);
                        setStatus('cancel_failed');
                    }
                }
                return;
            }
            acceptProjection(next);
        } catch (caught) {
            if (preparationCanceledRef.current) {
                if (activationCreateStartedRef.current || pendingPreparedRef.current) {
                    if (mountedRef.current) {
                        setError(caught);
                        setStatus('cancel_failed');
                    }
                    return;
                }
                // Reaching here means no prepared custody was retained and the
                // create request never started, so only the abandoned draft and
                // the idle presentation remain to settle.
                await input.onAbandoned?.();
                if (mountedRef.current) {
                    setError(null);
                    setStatus('idle');
                }
                return;
            }
            if (!preparationCanceledRef.current && !isTemporaryComputerLaunchErrorRetryable(caught)) {
                await input.onAbandoned?.();
            }
            const incompatibility = resolveLaunchProfileIncompatibility(caught);
            if (mountedRef.current) {
                setError(caught);
                setStatus(incompatibility ?? 'failed');
            }
            // A deterministic authoring incompatibility is fully owned here: the
            // local custody is abandoned above, the draft is unfrozen, and the
            // surface states the exact selection with its one real recovery. The
            // Send caller has nothing left to report, so re-throwing would only
            // add a second, generic presentation of the same handled outcome.
            if (incompatibility !== null) return;
            throw caught;
        } finally {
            preparationAbortControllerRef.current = null;
            if (pendingPreparedRef.current === null) preparationCanceledRef.current = false;
            inFlightRef.current = false;
        }
        });
    }, [acceptProjection, input.client, input.draftId, input.draftLaunchOperationKey, input.onAbandoned, input.persistPublicRef, input.prepareActivation, input.serverId]);

    const cancel = React.useCallback(async () => {
        if (inFlightRef.current) {
            preparationCanceledRef.current = true;
            if (mountedRef.current) setStatus('canceling');
            const preparationAbortController = preparationAbortControllerRef.current;
            if (preparationAbortController) {
                preparationAbortController.abort(new Error('runner_activation_preparation_canceled'));
            }
            return;
        }
        if (!projection) {
            inFlightRef.current = true;
            const pending = pendingPreparedRef.current;
            try {
                if (pending && input.client) {
                    preparationCanceledRef.current = true;
                    setStatus('canceling');
                    let recovered: RunnerActivationProjectionV1;
                    try {
                        recovered = await input.client.readByDraft(input.draftId);
                    } catch (caught) {
                        if (!(caught instanceof RunnerActivationClientError) || caught.code !== 'not_found') throw caught;
                        recovered = await input.client.create(pending.request);
                        await pending.acceptCreated?.(recovered);
                    }
                    pendingPreparedRef.current = null;
                    input.persistPublicRef({
                        v: 1,
                        activationId: recovered.activationId,
                        createdOnDeviceLabel: pending.createdOnDeviceLabel,
                    });
                    setProjection(recovered);
                    const canceled = await input.client.cancel(recovered.activationId);
                    acceptProjection(canceled);
                    return;
                }
                pendingPreparedRef.current = null;
                await pending?.discard?.();
                await input.onAbandoned?.();
                if (mountedRef.current) {
                    setError(null);
                    setStatus('idle');
                }
            } catch (caught) {
                if (mountedRef.current) {
                    setError(caught);
                    setStatus('cancel_failed');
                }
            } finally {
                if (pendingPreparedRef.current === null) preparationCanceledRef.current = false;
                inFlightRef.current = false;
            }
            return;
        }
        if (!input.client) return;
        inFlightRef.current = true;
        setStatus('canceling');
        setError(null);
        try {
            const canceled = await input.client.cancel(projection.activationId);
            acceptProjection(canceled);
        } catch (caught) {
            if (mountedRef.current) {
                setError(caught);
                setStatus('cancel_failed');
            }
        } finally {
            inFlightRef.current = false;
        }
    }, [acceptProjection, input.client, input.onAbandoned, projection]);

    const retry = React.useCallback(async () => {
        // Re-sending the same frozen submission would repeat the same refusal.
        if (isLaunchProfileIncompatibility(status)) return;
        if (status === 'failed' && !isTemporaryComputerLaunchErrorRetryable(error)) return;
        if (
            projection?.state === 'closed'
            && closureCleanupFailedIdsRef.current.has(projection.activationId)
        ) {
            closureCleanupFailedIdsRef.current.delete(projection.activationId);
            closedActivationIdsRef.current.delete(projection.activationId);
            acceptProjection(projection);
        } else if (projection?.state === 'materialized') completeMaterialized(projection);
        else if (projection) await refresh();
        else if (preparationCanceledRef.current) await cancel();
        else await start();
    }, [acceptProjection, cancel, completeMaterialized, error, projection, refresh, start, status]);

    const dismissTerminal = React.useCallback(() => {
        if (projection === null) {
            // A deterministic authoring incompatibility never reached the Home,
            // so there is no activation to acknowledge. Custody was already
            // abandoned and the draft unfrozen when the attempt refused, which
            // makes this acknowledgement exactly "return to the composer".
            if (!isLaunchProfileIncompatibility(status)) return;
            setError(null);
            setStatus('idle');
            return;
        }
        if (projection.state !== 'closed' || closureCleanupFailedIdsRef.current.has(projection.activationId)) return;
        dismissedClosedActivationIdsRef.current.add(projection.activationId);
        setProjection(null);
        setError(null);
        setStatus('idle');
    }, [projection, status]);

    const requestReplacementLaunch = input.requestReplacementLaunch;
    const replaceTerminal = React.useCallback(async () => {
        if (projection?.state !== 'closed' || closureCleanupFailedIdsRef.current.has(projection.activationId)) return;
        // The dismissed-id fence lets `start` distinguish this explicit user
        // replacement from ordinary remount recovery of the same closed row.
        dismissedClosedActivationIdsRef.current.add(projection.activationId);
        setProjection(null);
        setError(null);
        setStatus('idle');
        await requestReplacementLaunch?.();
    }, [projection, requestReplacementLaunch]);

    // The frozen reopen window. `status` is still the internal lifecycle; only
    // the presented status is widened, so no transition logic has to learn a
    // second state name.
    // Without a transport there is nothing to reconcile against, and reporting
    // an indefinite "checking" would freeze a draft row or composer forever.
    const effectiveStatus: TemporaryComputerLaunchStatus = status === 'idle'
        && input.client !== null
        && input.existingPublicRef !== null
        && reconciledKey !== reconciliationKey
        ? 'reconciling'
        : status;

    return {
        status: effectiveStatus,
        projection,
        error,
        start,
        retry,
        cancel,
        refresh,
        dismissTerminal,
        replaceTerminal,
    };
}

const rejectObservedActivationStart = async (): Promise<never> => {
    throw new Error('runner_activation_observer_cannot_start');
};
const ignoreObservedActivationReference = () => undefined;
const ignoreObservedMaterialization = () => undefined;

/**
 * Read-only consumer of the same mounted Runner lifecycle used by New Session.
 * It deliberately exposes no start/cancel operation: draft deletion remains the
 * single atomic draft + pending-activation tombstone owned by the server.
 */
export function useTemporaryComputerLaunchObservation(input: Readonly<{
    client: RunnerActivationClient | null;
    serverId: string | null;
    draftId: string;
    existingPublicRef: TemporaryComputerPublicActivationRef | null;
}>): TemporaryComputerLaunchObservation {
    const controller = useTemporaryComputerLaunch({
        client: input.client,
        serverId: input.serverId,
        draftId: input.draftId,
        existingPublicRef: input.existingPublicRef,
        prepareActivation: rejectObservedActivationStart,
        persistPublicRef: ignoreObservedActivationReference,
        onMaterialized: ignoreObservedMaterialization,
    });
    return {
        status: controller.status,
        projection: controller.projection,
        error: controller.error,
        refresh: controller.refresh,
    };
}
