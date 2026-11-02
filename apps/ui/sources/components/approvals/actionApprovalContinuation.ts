import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { resolveApprovalPresentationInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ApprovalExecutionOriginV1, ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionBoardActionIdV1Schema } from '@happier-dev/protocol/sessions/board/actionIds';
import { isSessionBoardActionInputCorrespondingV1 } from '@happier-dev/protocol/sessions/board/actions';

import { readManagedMachineActionOutputV1 } from '@/sync/api/machines/managedMachineResponse';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type ActionApprovalTerminalStatus = 'rejected' | 'failed' | 'canceled' | 'invalid';

/**
 * Process-local custody for one result-bearing Action approval.
 *
 * The Artifact remains the durable lifecycle owner. This callback is deliberately
 * not serializable: losing the mounted origin safely falls back to its ordinary
 * projection refresh instead of replaying an already executed mutation.
 */
export type ActionApprovalContinuation = Readonly<{
    artifactId: string;
    /** The Account that admitted this result-bearing invocation. */
    scope?: ServerAccountScope;
    /** False when the caller owns completion beyond this Action receipt and its later refresh. */
    refreshAfterExecution?: boolean;
    /** Ends only the mounted caller's interest, not the durable approval. */
    signal?: AbortSignal;
    onExecuted: (artifact: DecryptedArtifact) => Promise<'consumed' | 'ignored'>;
    onTerminal?: (status: ActionApprovalTerminalStatus, artifact?: DecryptedArtifact | null) => void;
}>;

/** Existing non-result-bearing callers may continue registering only the Artifact id. */
export type ActionApprovalRegistration = string | ActionApprovalContinuation;

export type ActionApprovalResultCallbacks<TValue> = Readonly<{
    signal?: AbortSignal;
    onApprovalSucceeded: (value: TValue) => void;
    onApprovalFailed: (code: string, failure?: ActionExecuteFailure) => void;
}>;

/**
 * Keep a mounted read pending until its existing continuation delivers a result.
 * Domain clients retain their own result envelopes; this owner only joins the
 * immediate and deferred paths and releases local interest on cancellation.
 */
export function awaitActionApprovalResult<TValue, TResult extends object>(input: Readonly<{
    execute: (callbacks: ActionApprovalResultCallbacks<TValue>) => Promise<TResult | Readonly<{ approvalPending: true }>>;
    succeeded: (value: TValue) => TResult;
    failed: (code: string, failure?: ActionExecuteFailure) => TResult;
    aborted: () => TResult;
    signal?: AbortSignal;
}>): Promise<TResult> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result: TResult) => {
            if (settled) return;
            settled = true;
            input.signal?.removeEventListener('abort', abort);
            resolve(result);
        };
        const abort = () => finish(input.aborted());
        if (input.signal?.aborted) { abort(); return; }
        input.signal?.addEventListener('abort', abort, { once: true });
        void (async () => await input.execute({
            ...(input.signal ? { signal: input.signal } : {}),
            onApprovalSucceeded: (value) => finish(input.succeeded(value)),
            onApprovalFailed: (code, failure) => finish(input.failed(code, failure)),
        }))().then((result) => {
            if (!('approvalPending' in result)) finish(result);
        }, (error: unknown) => {
            if (settled) return;
            settled = true;
            input.signal?.removeEventListener('abort', abort);
            reject(error);
        });
    });
}

export function normalizeActionApprovalRegistration(
    registration: ActionApprovalRegistration,
): Readonly<{ artifactId: string; continuation: ActionApprovalContinuation | null }> {
    return typeof registration === 'string'
        ? { artifactId: registration, continuation: null }
        : { artifactId: registration.artifactId, continuation: registration };
}

/** Join an already-admitted Action to the same typed continuation used by mounted authors. */
export async function resumeActionExecutionResult(input: Readonly<{
    result: ActionExecuteResult;
    actionId: ActionId;
    actionInput: unknown;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    requestId?: string;
    onApprovalPending(registration: ActionApprovalContinuation): void;
}>): Promise<ActionExecuteResult> {
    if (!input.result.ok) return input.result;
    const pending = ActionApprovalRequestCreatedResultSchema.safeParse(input.result.result);
    if (!pending.success) return input.result;
    return await awaitActionApprovalResult<unknown, ActionExecuteResult>({
        signal: input.signal,
        execute: async callbacks => {
            input.onApprovalPending(createActionApprovalContinuation({
                artifactId: pending.data.artifactId, actionId: input.actionId,
                scope: input.scope, expectedInput: input.actionInput,
                ...(input.requestId ? { expectedRequestId: input.requestId } : {}),
                signal: input.signal,
                onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
            }));
            return { approvalPending: true };
        },
        succeeded: value => ({ ok: true, result: value }),
        failed: (code, failure) => failure ?? { ok: false, errorCode: code, error: code },
        aborted: () => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }),
    });
}

type RegisteredApproval = ReturnType<typeof normalizeActionApprovalRegistration>;
type ApprovalSettlement = Readonly<{ registration: RegisteredApproval; artifact: DecryptedArtifact | null;
    status: 'executed' | ActionApprovalTerminalStatus }>;

/**
 * Process-local result custody, independent of React. The Artifact remains the
 * durable owner; adapters feed exact-Home observations, never execute/replay here.
 */
export function createActionApprovalContinuationObserver(input: Readonly<{ onExecuted(): void }>) {
    let registrations: RegisteredApproval[] = [];
    let settlement: ApprovalSettlement | null = null;
    let deliveredSettlement: ApprovalSettlement | null = null;
    let snapshot: Readonly<{ approval: RegisteredApproval | null; settlement: ApprovalSettlement | null }> = { approval: null, settlement: null };
    let disposed = false;
    let signalsAttached = true;
    const listeners = new Set<() => void>();
    const cleanups = new Map<RegisteredApproval, () => void>();
    const publish = () => {
        const approval = settlement ? null : registrations[0] ?? null;
        if (snapshot.approval === approval && snapshot.settlement === settlement) return;
        snapshot = { approval, settlement };
        for (const listener of listeners) listener();
    };
    const remove = (registration: RegisteredApproval) => {
        cleanups.get(registration)?.();
        cleanups.delete(registration);
        registrations = registrations.filter(entry => entry !== registration);
    };
    const attachSignal = (registration: RegisteredApproval) => {
        const signal = registration.continuation?.signal;
        if (!signalsAttached || !signal || cleanups.has(registration)) return;
        if (signal.aborted) { remove(registration); return; }
        const abort = () => { remove(registration); publish(); };
        signal.addEventListener('abort', abort, { once: true });
        cleanups.set(registration, () => signal.removeEventListener('abort', abort));
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        requestApproval(registration: ActionApprovalRegistration) {
            if (disposed) return;
            const normalized = normalizeActionApprovalRegistration(registration);
            const signal = normalized.continuation?.signal;
            if (signal?.aborted || settlement?.registration.artifactId === normalized.artifactId
                || registrations.some(entry => entry.artifactId === normalized.artifactId)) return;
            registrations.push(normalized);
            attachSignal(normalized);
            publish();
        },
        observeArtifact(artifact: DecryptedArtifact | null, invalidArtifact = false) {
            const approval = registrations[0];
            if (disposed || settlement || !approval || (artifact && artifact.id !== approval.artifactId)) return;
            const headerStatus = artifact?.header?.approvalStatus;
            const status = invalidArtifact ? 'invalid' : headerStatus === 'executed' ? 'executed'
                : headerStatus === 'rejected' || headerStatus === 'failed' || headerStatus === 'canceled' ? headerStatus : null;
            if (!status || (approval.continuation && status !== 'invalid' && (!artifact || typeof artifact.body !== 'string'))) return;
            // Claim before invoking callbacks; a callback may synchronously enqueue another Action.
            remove(approval);
            settlement = { registration: approval, status, artifact };
            publish();
        },
        deliverSettlement() {
            const claimed = settlement;
            if (disposed || !claimed || deliveredSettlement === claimed) return;
            deliveredSettlement = claimed;
            try {
                const { status, artifact } = claimed;
                const continuation = claimed.registration.continuation;
                if (continuation?.signal?.aborted) return;
                if (status !== 'executed') {
                    try { continuation?.onTerminal?.(status, artifact); } catch { /* The caller owns terminal recovery. */ }
                    return;
                }
                if (continuation && artifact) void continuation.onExecuted(artifact).catch(() => {
                    // A result callback cannot authorize replay of an executed Action.
                });
                if (continuation?.refreshAfterExecution !== false) input.onExecuted();
            } finally { settlement = null; publish(); }
        },
        attachSignals() {
            if (disposed) return;
            signalsAttached = true;
            for (const registration of [...registrations]) attachSignal(registration);
            publish();
        },
        detachSignals() {
            // StrictMode may restore this same mounted observer. Preserve its
            // custody, but never leave an externally owned signal retaining it.
            signalsAttached = false;
            for (const cleanup of cleanups.values()) cleanup();
            cleanups.clear();
        },
        dispose() {
            disposed = true;
            for (const cleanup of cleanups.values()) cleanup();
            cleanups.clear(); registrations = []; listeners.clear(); settlement = null;
            snapshot = { approval: null, settlement: null };
        },
    };
}

type ApprovalRequestInspection =
    | Readonly<{ kind: 'different_artifact' }>
    | Readonly<{ kind: 'invalid_artifact' }>
    | Readonly<{ kind: 'binding_mismatch' }>
    | Readonly<{
        kind: 'matched';
        request: ApprovalRequestV2;
    }>;

function canonicalApprovalInputIdentity(value: unknown): string | null {
    try {
        return createCanonicalJsonSigningInput(value);
    } catch {
        return null;
    }
}

/**
 * The observed identity of one approval's input: exactly what the host wrote
 * into the durable record: its declared private review, or observation projection.
 *
 * This is an operand check inside one already-selected Artifact, not the
 * identity binding: `inspectActionApprovalRequest` first requires the exact
 * captured Artifact id, then the Action, origin, Account/Home and request id,
 * so two distinct approvals can never satisfy each other even when their
 * inputs differ only in a redacted secret. The Artifact owner keeps the input
 * immutable until settlement. The raw input cannot be compared: an Action
 * declaring `approvalInputCustody: 'live_only'`, and any settled request,
 * durably carries only the projection.
 */
function canonicalObservedApprovalInput(actionId: ActionId, input: unknown): string | null {
    const spec = getActionSpec(actionId);
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) return null;
    try {
        const review = spec.approvalPresentation;
        // Use the producer's same declared, validated private review when present.
        const projected = review?.inputSchema && review.projectInput
            ? review.inputSchema.parse(review.projectInput(parsed.data))
            : resolveApprovalPresentationInput({ actionId, actionArgs: parsed.data });
        // Compare the schema-admitted native operand as the Artifact transport records it.
        // Unsupported carriers still refuse; only optional undefined object members disappear.
        return canonicalApprovalInputIdentity(projectNativeJsonValueForTransport(projected));
    } catch {
        return null;
    }
}

function inspectActionApprovalRequest<TActionId extends ActionId>(input: Readonly<{
    artifact: DecryptedArtifact;
    artifactId: string;
    actionId: TActionId;
    scope: ServerAccountScope;
    expectedInputCanonical?: string | null;
    expectedRequestId?: string;
    expectedExecutionOriginCanonical?: string | null;
}>): ApprovalRequestInspection {
    if (input.artifact.id !== input.artifactId) return { kind: 'different_artifact' };
    if (typeof input.artifact.body !== 'string') return { kind: 'invalid_artifact' };
    const parsed = approvalArtifactBodyMatchesHeaderV1(input.artifact.header ?? {}, input.artifact.body);
    if (!parsed || parsed.family !== 'built_in' || parsed.request.v !== 2) return { kind: 'invalid_artifact' };
    const request = parsed.request;
    const origin = request.executionOriginV1;
    const binding = origin.externalActionExecutionAuthorization?.binding;
    // An Account UI request can retain its admitted automation ceiling on the
    // daemon. Observing its exact receipt neither grants nor changes authority.
    const signedAccountUiOrigin = binding && 'authentication' in binding
        && binding.authentication.kind === 'account'
        && !binding.sessionActionOrigin && !binding.workflowActionOrigin;
    // The daemon's device-local profile id is not an app profile id. The stored
    // portable Home identity is already bound to the signed originating root.
    const originHomeId = origin.serverIdentityId ?? origin.serverId;
    if (
        request.actionId !== input.actionId
        || request.executionOriginV1.actionId !== input.actionId
        || (input.expectedExecutionOriginCanonical === undefined && (
            (origin.authority !== 'present_user' && !signedAccountUiOrigin)
            || request.executionOriginV1.surface !== 'ui'
            || request.requestedSurface !== 'ui'
            || request.executionOriginV1.caller.kind !== 'host'
        ))
        || (input.expectedExecutionOriginCanonical !== undefined && (
            input.expectedExecutionOriginCanonical === null
            || canonicalApprovalInputIdentity(request.executionOriginV1) !== input.expectedExecutionOriginCanonical
        ))
        || request.executionOriginV1.accountId !== input.scope.accountId
        || (
            input.expectedRequestId !== undefined
            && request.executionOriginV1.requestId !== input.expectedRequestId
        )
        || (
            originHomeId !== input.scope.serverId
            && !areServerProfileIdentifiersEquivalent(
                originHomeId,
                input.scope.serverId,
            )
        )
    ) return { kind: 'binding_mismatch' };
    if (input.expectedInputCanonical !== undefined) {
        const projected = resolveApprovalPresentationInput({
            actionId: input.actionId,
            actionArgs: request.actionArgs,
            ...(request.preview !== undefined ? { preview: request.preview } : {}),
        });
        const review = getActionSpec(input.actionId).approvalPresentation;
        const validatedReview = review?.projectInput && review.inputSchema ? review.inputSchema.safeParse(projected) : null;
        if (validatedReview && !validatedReview.success) return { kind: 'binding_mismatch' };
        const recordedInput = canonicalApprovalInputIdentity(validatedReview?.success ? validatedReview.data : projected);
        if (input.expectedInputCanonical === null || recordedInput === null) return { kind: 'binding_mismatch' };
        if (recordedInput !== input.expectedInputCanonical) {
            const boardAction = SessionBoardActionIdV1Schema.safeParse(input.actionId);
            // Board admission captures host review facts before approval. Reuse
            // its exact operand correspondence, as acknowledgement recovery does.
            if (!boardAction.success || !isSessionBoardActionInputCorrespondingV1(
                boardAction.data,
                JSON.parse(input.expectedInputCanonical),
                JSON.parse(recordedInput),
            )) return { kind: 'binding_mismatch' };
        }
    }
    return { kind: 'matched', request };
}

type CreateActionApprovalContinuationInput<TValue, TActionId extends ActionId> = Readonly<{
    artifactId: string;
    refreshAfterExecution?: boolean;
    actionId: TActionId;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    /** Bind settlement to the originating invocation when its caller received that identity. */
    expectedRequestId?: string;
    /** Exact immutable origin obtained from an already validated Artifact, never reconstructed from a renderer caller. */
    expectedExecutionOrigin?: ApprovalExecutionOriginV1;
    /**
     * The originating Action input. When present, settlement compares the
     * canonical JSON of its observation projection against the projection the
     * durable record carries, without logging either value. This prevents a
     * same-Action approval for another resource or mutation from satisfying
     * this continuation. See `canonicalObservedApprovalInput` for the one
     * operand that projection deliberately drops.
     */
    expectedInput?: unknown;
    onSucceeded: (value: TValue) => void | Promise<void>;
    onFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>;

/**
 * Bind an exact Action approval Artifact back to the UI operation that created it.
 *
 * Action identity, input and output all come from the one canonical ActionSpec
 * registry. Domain-specific callers may expose a narrower wrapper, but must not
 * recreate settlement parsing or principal/scope checks.
 */
export function createActionApprovalContinuation<TValue, TActionId extends ActionId>(
    input: CreateActionApprovalContinuationInput<TValue, TActionId>,
): ActionApprovalContinuation;
export function createActionApprovalContinuation(
    input: CreateActionApprovalContinuationInput<unknown, ActionId>,
): ActionApprovalContinuation {
    const expectedInputCanonical = Object.prototype.hasOwnProperty.call(input, 'expectedInput')
        ? canonicalObservedApprovalInput(input.actionId, input.expectedInput)
        : undefined;
    const expectedExecutionOriginCanonical = Object.prototype.hasOwnProperty.call(input, 'expectedExecutionOrigin')
        ? canonicalApprovalInputIdentity(input.expectedExecutionOrigin)
        : undefined;
    const inspect = (artifact: DecryptedArtifact) => inspectActionApprovalRequest({
        artifact, artifactId: input.artifactId, actionId: input.actionId, scope: input.scope,
        ...(expectedInputCanonical !== undefined ? { expectedInputCanonical } : {}),
        ...(input.expectedRequestId !== undefined ? { expectedRequestId: input.expectedRequestId } : {}),
        ...(expectedExecutionOriginCanonical !== undefined ? { expectedExecutionOriginCanonical } : {}),
    });
    return Object.freeze({
        artifactId: input.artifactId,
        scope: input.scope,
        ...(input.refreshAfterExecution !== undefined ? { refreshAfterExecution: input.refreshAfterExecution } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        onExecuted: async (artifact: DecryptedArtifact) => {
            const inspection = inspect(artifact);
            if (inspection.kind === 'different_artifact') return 'ignored';
            if (inspection.kind === 'invalid_artifact') {
                input.onFailed?.('approval_invalid');
                return 'consumed';
            }
            if (inspection.kind === 'binding_mismatch' || inspection.request.status !== 'executed') {
                input.onFailed?.('approval_binding_mismatch');
                return 'consumed';
            }

            const execution = inspection.request.execution;
            const nativeOptions = input.actionId === 'machines.provisioners.options' && execution?.ok === true
                ? readManagedMachineActionOutputV1(input.actionId, execution.result) : null;
            const request = nativeOptions?.success && execution
                ? { ...inspection.request, execution: { ...execution, result: nativeOptions.data } } : inspection.request;
            const failure = readApprovalExecutionFailure(request);
            if (failure) {
                input.onFailed?.(failure.errorCode, failure);
                return 'consumed';
            }

            const outputSchema = getActionSpec(input.actionId).outputSchema;
            const output = nativeOptions ?? outputSchema?.safeParse(execution?.result);
            if (!output?.success) {
                input.onFailed?.('invalid_action_output');
                return 'consumed';
            }
            try {
                await input.onSucceeded(output.data);
            } catch {
                input.onFailed?.('operation_failed');
            }
            return 'consumed';
        },
        onTerminal: (status, artifact) => {
            if (status === 'invalid') {
                input.onFailed?.('approval_invalid');
                return;
            }
            if (!artifact) {
                input.onFailed?.(`approval_${status}`);
                return;
            }
            const inspection = inspect(artifact);
            if (inspection.kind === 'different_artifact') return;
            if (inspection.kind === 'invalid_artifact') {
                input.onFailed?.('approval_invalid');
                return;
            }
            if (inspection.kind === 'binding_mismatch' || inspection.request.status !== status) {
                input.onFailed?.('approval_binding_mismatch');
                return;
            }
            const failure = status === 'failed'
                ? readApprovalExecutionFailure(inspection.request)
                : null;
            input.onFailed?.(failure?.errorCode ?? `approval_${status}`, failure ?? undefined);
        },
    });
}

/** Home/Team callers retain their narrower compile-time Action family. */
export function createHomeActionApprovalContinuation<
    TValue,
    TActionId extends HomeDomainActionIdV1,
>(input: CreateActionApprovalContinuationInput<TValue, TActionId>): ActionApprovalContinuation {
    return createActionApprovalContinuation(input);
}
