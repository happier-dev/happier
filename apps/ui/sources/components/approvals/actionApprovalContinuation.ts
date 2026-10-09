import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { resolveApprovalPresentationInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ApprovalExecutionOriginV1, ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

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
 * into the durable record, which is the Action's own observation projection.
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
    const parsed = getActionSpec(actionId).inputSchema.safeParse(input);
    if (!parsed.success) return null;
    // No `preview`: the same owner then answers with what the host would have
    // recorded for this input, which is what the durable record carries.
    try {
        // Compare the schema-admitted native operand as the Artifact transport records it.
        // Unsupported carriers still refuse; only optional undefined object members disappear.
        return canonicalApprovalInputIdentity(projectNativeJsonValueForTransport(
            resolveApprovalPresentationInput({ actionId, actionArgs: parsed.data }),
        ));
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
    if (
        request.actionId !== input.actionId
        || request.executionOriginV1.actionId !== input.actionId
        || (input.expectedExecutionOriginCanonical === undefined && (
            request.executionOriginV1.authority !== 'present_user'
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
            request.executionOriginV1.serverId !== input.scope.serverId
            && !areServerProfileIdentifiersEquivalent(
                request.executionOriginV1.serverId,
                input.scope.serverId,
            )
        )
    ) return { kind: 'binding_mismatch' };
    if (input.expectedInputCanonical !== undefined) {
        const recordedInput = canonicalApprovalInputIdentity(resolveApprovalPresentationInput({
            actionId: input.actionId,
            actionArgs: request.actionArgs,
            ...(request.preview !== undefined ? { preview: request.preview } : {}),
        }));
        if (
            input.expectedInputCanonical === null
            || recordedInput === null
            || recordedInput !== input.expectedInputCanonical
        ) return { kind: 'binding_mismatch' };
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
    return Object.freeze({
        artifactId: input.artifactId,
        scope: input.scope,
        ...(input.refreshAfterExecution !== undefined ? { refreshAfterExecution: input.refreshAfterExecution } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        onExecuted: async (artifact: DecryptedArtifact) => {
            const inspection = inspectActionApprovalRequest({
                artifact,
                artifactId: input.artifactId,
                actionId: input.actionId,
                scope: input.scope,
                ...(expectedInputCanonical !== undefined ? { expectedInputCanonical } : {}),
                ...(input.expectedRequestId !== undefined ? { expectedRequestId: input.expectedRequestId } : {}),
                ...(expectedExecutionOriginCanonical !== undefined ? { expectedExecutionOriginCanonical } : {}),
            });
            if (inspection.kind === 'different_artifact') return 'ignored';
            if (inspection.kind === 'invalid_artifact') {
                input.onFailed?.('approval_invalid');
                return 'consumed';
            }
            if (inspection.kind === 'binding_mismatch' || inspection.request.status !== 'executed') {
                input.onFailed?.('approval_binding_mismatch');
                return 'consumed';
            }

            const outputSchema = getActionSpec(input.actionId).outputSchema;
            const output = outputSchema?.safeParse(inspection.request.execution?.result);
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
            const inspection = inspectActionApprovalRequest({
                artifact,
                artifactId: input.artifactId,
                actionId: input.actionId,
                scope: input.scope,
                ...(expectedInputCanonical !== undefined ? { expectedInputCanonical } : {}),
                ...(input.expectedRequestId !== undefined ? { expectedRequestId: input.expectedRequestId } : {}),
                ...(expectedExecutionOriginCanonical !== undefined ? { expectedExecutionOriginCanonical } : {}),
            });
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
