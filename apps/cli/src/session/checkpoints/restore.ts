import type {
    BackendSurfaceAvailabilityV1,
    CheckpointCandidateRefV1,
    CheckpointFailedScopeV1,
    CheckpointOperationReceiptV1,
    CheckpointProviderCandidateRefV1,
    CheckpointRestoreAnchorV1,
    CheckpointRestoreCandidateV1,
    CheckpointRestoreScopeV1,
    CheckpointRestoreSourceV1,
    CheckpointScmCandidateRefV1,
    SanitizedCheckpointRestoreCandidateV1,
    SessionRestoreRequestV1,
    SessionRestoreResultV1,
    SessionTurnV1,
} from '@happier-dev/protocol';
import {
    SessionRestoreRequestV1Schema,
    buildCheckpointOperationReceiptV1,
    sanitizeCheckpointRestoreCandidateV1,
} from '@happier-dev/protocol';
import type {
    CheckpointProviderTargetRefV1,
    RestoreCheckpointResultV1,
} from '@happier-dev/agents';

type MaybePromise<T> = T | Promise<T>;

type ProviderRestoreRequest = Readonly<{
    sessionId: string;
    backendId: string;
    scopes: readonly CheckpointRestoreScopeV1[];
    anchor?: CheckpointRestoreAnchorV1;
    target?: CheckpointProviderTargetRefV1;
    signal?: AbortSignal;
}>;

export type ScmRestoreCheckpointResult = Readonly<{
    ok: true;
    restoredScopes: readonly CheckpointRestoreScopeV1[];
    failedScopes?: readonly CheckpointFailedScopeV1[];
}> | Readonly<{
    ok: false;
    code: string;
    message?: string;
}>;

type ScmRestoreRequest = Readonly<{
    sessionId: string;
    checkpointRef: string;
    turnId?: string;
    scopes: readonly CheckpointRestoreScopeV1[];
    signal?: AbortSignal;
}>;

export type RestoreSessionCheckpointPorts = Readonly<{
    isSessionIdle: (sessionId: string) => MaybePromise<boolean>;
    collectCandidates: (request: SessionRestoreRequestV1) => MaybePromise<readonly CheckpointRestoreCandidateV1[]>;
    restoreProvider?: (request: ProviderRestoreRequest) => MaybePromise<RestoreCheckpointResultV1>;
    restoreScm?: (request: ScmRestoreRequest) => MaybePromise<ScmRestoreCheckpointResult>;
    evaluateProviderAvailability?: (request: Readonly<{
        operation: 'restore';
        sessionId: string;
        anchor?: CheckpointRestoreAnchorV1;
        target?: CheckpointProviderTargetRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        timing: 'idle';
    }>) => MaybePromise<BackendSurfaceAvailabilityV1>;
    providerAnchorRequiresTurnEvidence?: (request: Readonly<{
        sessionId: string;
        backendId: string;
        anchor: CheckpointRestoreAnchorV1;
        scopes: readonly CheckpointRestoreScopeV1[];
    }>) => MaybePromise<boolean>;
    resolveTurnEvidenceForAnchor?: (request: Readonly<{
        sessionId: string;
        backendId: string;
        anchor: CheckpointRestoreAnchorV1;
    }>) => MaybePromise<SessionTurnV1 | null>;
    createLifecycleId?: (request: SessionRestoreRequestV1) => string;
    signal?: AbortSignal;
}>;

export type RestoreSessionCheckpointParams = Readonly<{
    request: SessionRestoreRequestV1;
    ports: RestoreSessionCheckpointPorts;
}>;

function buildLifecycleId(request: SessionRestoreRequestV1, ports: RestoreSessionCheckpointPorts): string {
    return ports.createLifecycleId?.(request) ?? `checkpoint-restore:${request.sessionId}`;
}

function scopesContainAll(
    candidateScopes: readonly CheckpointRestoreScopeV1[],
    requestedScopes: readonly CheckpointRestoreScopeV1[],
): boolean {
    return requestedScopes.every((scope) => candidateScopes.includes(scope));
}

function scopesExactlyMatch(
    left: readonly CheckpointRestoreScopeV1[],
    right: readonly CheckpointRestoreScopeV1[],
): boolean {
    return left.length === right.length && left.every((scope) => right.includes(scope));
}

function hasDuplicateScopes(scopes: readonly CheckpointRestoreScopeV1[]): boolean {
    return new Set(scopes).size !== scopes.length;
}

function scopesAreSubset(
    scopes: readonly CheckpointRestoreScopeV1[],
    allowed: readonly CheckpointRestoreScopeV1[],
): boolean {
    return scopes.every((scope) => allowed.includes(scope));
}

function scopeListsOverlap(
    left: readonly CheckpointRestoreScopeV1[],
    right: readonly CheckpointRestoreScopeV1[],
): boolean {
    return left.some((scope) => right.includes(scope));
}

function validateRestoreScopeOutcome(params: Readonly<{
    requestedScopes: readonly CheckpointRestoreScopeV1[];
    restoredScopes: readonly CheckpointRestoreScopeV1[];
    failedScopes?: readonly CheckpointFailedScopeV1[];
    mode: 'completed' | 'partial';
}>): boolean {
    const failedScopeValues = params.failedScopes?.map((failure) => failure.scope) ?? [];
    if (
        hasDuplicateScopes(params.restoredScopes)
        || hasDuplicateScopes(failedScopeValues)
        || !scopesAreSubset(params.restoredScopes, params.requestedScopes)
        || !scopesAreSubset(failedScopeValues, params.requestedScopes)
        || scopeListsOverlap(params.restoredScopes, failedScopeValues)
    ) {
        return false;
    }
    if (params.mode === 'completed') {
        return failedScopeValues.length === 0 && scopesExactlyMatch(params.restoredScopes, params.requestedScopes);
    }
    return failedScopeValues.length > 0
        && scopesExactlyMatch([...params.restoredScopes, ...failedScopeValues], params.requestedScopes);
}

function sanitizeCandidates(
    candidates: readonly CheckpointRestoreCandidateV1[],
): SanitizedCheckpointRestoreCandidateV1[] {
    return candidates.map((candidate) => sanitizeCheckpointRestoreCandidateV1(candidate));
}

function failureResult(
    errorCode: Extract<SessionRestoreResultV1, { ok: false }>['errorCode'],
    options: Readonly<{
        error?: string;
        candidates?: readonly CheckpointRestoreCandidateV1[];
        receipts?: readonly CheckpointOperationReceiptV1[];
    }> = {},
): SessionRestoreResultV1 {
    return {
        ok: false,
        errorCode,
        ...(options.error ? { error: options.error } : {}),
        ...(options.candidates ? { candidates: sanitizeCandidates(options.candidates) } : {}),
        ...(options.receipts ? { receipts: [...options.receipts] } : {}),
    };
}

function buildAdHocCandidate(
    candidate: CheckpointCandidateRefV1,
    scopes: readonly CheckpointRestoreScopeV1[],
): CheckpointRestoreCandidateV1 {
    return {
        id: `${candidate.source}:${scopes.join('+')}`,
        source: candidate.source,
        scopes: [...scopes],
        candidate,
    };
}

async function resolveRestoreCandidate(
    request: SessionRestoreRequestV1,
    ports: RestoreSessionCheckpointPorts,
): Promise<Readonly<{
    result?: SessionRestoreResultV1;
    candidate?: CheckpointCandidateRefV1;
}>> {
    if (request.candidate) {
        return { candidate: request.candidate };
    }

    const candidates = (await ports.collectCandidates(request))
        .filter((candidate) => candidate.atomic === true
            ? scopesExactlyMatch(candidate.scopes, request.scopes)
            : scopesContainAll(candidate.scopes, request.scopes));

    if (candidates.length === 0) {
        return {
            result: failureResult('restore_target_missing'),
        };
    }

    if (candidates.length > 1) {
        return {
            result: failureResult('source_choice_required', { candidates }),
        };
    }

    return { candidate: candidates[0]?.candidate };
}

function isTrustedTurnEvidence(
    turn: SessionTurnV1 | null,
    anchor: CheckpointRestoreAnchorV1,
): boolean {
    if (!turn) {
        return false;
    }
    if (turn.status === 'in_progress') {
        return false;
    }
    if (turn.rollback?.state !== 'eligible') {
        return false;
    }
    const expectedMessageSeq = anchor.evidence?.messageSeq;
    if (expectedMessageSeq === undefined) {
        return turn.transcriptAnchors?.startUserMessageSeq !== undefined;
    }
    return turn.transcriptAnchors?.startUserMessageSeq === expectedMessageSeq;
}

async function assertTrustedTurnEvidence(
    params: Readonly<{
        request: SessionRestoreRequestV1;
        ports: RestoreSessionCheckpointPorts;
        candidate: CheckpointProviderCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
    }>,
): Promise<SessionRestoreResultV1 | null> {
    if (!params.candidate.anchor) {
        return null;
    }
    const requiresEvidence = await params.ports.providerAnchorRequiresTurnEvidence?.({
        sessionId: params.request.sessionId,
        backendId: params.candidate.backendId,
        anchor: params.candidate.anchor,
        scopes: params.scopes,
    });
    if (!requiresEvidence) {
        return null;
    }

    const turn = await params.ports.resolveTurnEvidenceForAnchor?.({
        sessionId: params.request.sessionId,
        backendId: params.candidate.backendId,
        anchor: params.candidate.anchor,
    }) ?? null;

    if (isTrustedTurnEvidence(turn, params.candidate.anchor)) {
        return null;
    }
    return failureResult('trusted_turn_evidence_required');
}

function mapProviderFailedScopes(result: Extract<RestoreCheckpointResultV1, { ok: true }>): readonly CheckpointFailedScopeV1[] | undefined {
    return result.failedScopes?.map((failure) => ({
        scope: failure.scope,
        code: failure.code,
        ...(failure.message ? { message: failure.message } : {}),
    }));
}

function buildInvalidScopeFailureReceipt(params: Readonly<{
    lifecycleId: string;
    source: CheckpointRestoreSourceV1;
    scopes: readonly CheckpointRestoreScopeV1[];
    candidate: CheckpointCandidateRefV1;
    code: string;
}>): CheckpointOperationReceiptV1 {
    return buildCheckpointOperationReceiptV1({
        operation: 'restore',
        phase: 'failed',
        lifecycleId: params.lifecycleId,
        source: params.source,
        scopes: params.scopes,
        candidate: params.candidate,
        failedScopes: params.scopes.map((scope) => ({
            scope,
            code: params.code,
        })),
    });
}

async function restoreProviderCandidate(
    params: Readonly<{
        request: SessionRestoreRequestV1;
        candidate: CheckpointProviderCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        ports: RestoreSessionCheckpointPorts;
        lifecycleId: string;
    }>,
): Promise<SessionRestoreResultV1> {
    const evidenceFailure = await assertTrustedTurnEvidence(params);
    if (evidenceFailure) {
        return evidenceFailure;
    }
    if (!params.ports.restoreProvider) {
        return failureResult('provider_restore_unavailable');
    }

    if (params.ports.evaluateProviderAvailability) {
        const availability = await params.ports.evaluateProviderAvailability({
            operation: 'restore',
            sessionId: params.request.sessionId,
            ...(params.candidate.anchor ? { anchor: params.candidate.anchor } : {}),
            ...(params.candidate.target ? { target: params.candidate.target } : {}),
            scopes: params.scopes,
            timing: 'idle',
        });
        if (!availability.available) {
            return failureResult('provider_restore_unavailable', { error: availability.reasonCode });
        }
    }

    const result = await params.ports.restoreProvider({
        sessionId: params.request.sessionId,
        backendId: params.candidate.backendId,
        scopes: params.scopes,
        ...(params.candidate.anchor ? { anchor: params.candidate.anchor } : {}),
        ...(params.candidate.target ? { target: params.candidate.target } : {}),
        ...(params.ports.signal ? { signal: params.ports.signal } : {}),
    });

    if (!result.ok) {
        const receipt = buildCheckpointOperationReceiptV1({
            operation: 'restore',
            phase: 'failed',
            lifecycleId: params.lifecycleId,
            source: 'provider',
            scopes: params.scopes,
            candidate: params.candidate,
            failedScopes: params.scopes.map((scope) => ({
                scope,
                code: result.code,
                ...(result.message ? { message: result.message } : {}),
            })),
        });
        return failureResult('provider_restore_failed', {
            error: result.code,
            receipts: [receipt],
        });
    }

    const failedScopes = mapProviderFailedScopes(result);
    if (!validateRestoreScopeOutcome({
        requestedScopes: params.scopes,
        restoredScopes: result.restoredScopes,
        ...(failedScopes ? { failedScopes } : {}),
        mode: result.outcome,
    })) {
        return failureResult('provider_restore_failed', {
            error: 'invalid_provider_restore_scopes',
            receipts: [buildInvalidScopeFailureReceipt({
                lifecycleId: params.lifecycleId,
                source: 'provider',
                scopes: params.scopes,
                candidate: params.candidate,
                code: 'invalid_provider_restore_scopes',
            })],
        });
    }
    const phase = result.outcome === 'partial' ? 'partially_succeeded' : 'succeeded';
    const receipt = buildCheckpointOperationReceiptV1({
        operation: 'restore',
        phase,
        lifecycleId: params.lifecycleId,
        source: 'provider',
        scopes: params.scopes,
        candidate: params.candidate,
        restoredScopes: result.restoredScopes,
        ...(failedScopes ? { failedScopes } : {}),
    });
    return {
        ok: true,
        status: phase,
        source: 'provider',
        restoredScopes: [...result.restoredScopes],
        ...(failedScopes ? { failedScopes: [...failedScopes] } : {}),
        receipts: [receipt],
    };
}

async function restoreScmCandidate(
    params: Readonly<{
        request: SessionRestoreRequestV1;
        candidate: CheckpointScmCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        ports: RestoreSessionCheckpointPorts;
        lifecycleId: string;
    }>,
): Promise<SessionRestoreResultV1> {
    if (!params.ports.restoreScm) {
        return failureResult('scm_restore_unavailable');
    }
    const result = await params.ports.restoreScm({
        sessionId: params.request.sessionId,
        checkpointRef: params.candidate.checkpointRef,
        ...(params.candidate.turnId ? { turnId: params.candidate.turnId } : {}),
        scopes: params.scopes,
        ...(params.ports.signal ? { signal: params.ports.signal } : {}),
    });
    if (!result.ok) {
        return failureResult('scm_restore_failed', { error: result.code });
    }
    const status = result.failedScopes && result.failedScopes.length > 0 ? 'partially_succeeded' : 'succeeded';
    if (!validateRestoreScopeOutcome({
        requestedScopes: params.scopes,
        restoredScopes: result.restoredScopes,
        ...(result.failedScopes ? { failedScopes: result.failedScopes } : {}),
        mode: status === 'partially_succeeded' ? 'partial' : 'completed',
    })) {
        return failureResult('scm_restore_failed', {
            error: 'invalid_scm_restore_scopes',
            receipts: [buildInvalidScopeFailureReceipt({
                lifecycleId: params.lifecycleId,
                source: 'happier_scm',
                scopes: params.scopes,
                candidate: params.candidate,
                code: 'invalid_scm_restore_scopes',
            })],
        });
    }
    const receipt = buildCheckpointOperationReceiptV1({
        operation: 'restore',
        phase: status,
        lifecycleId: params.lifecycleId,
        source: 'happier_scm',
        scopes: params.scopes,
        candidate: params.candidate,
        restoredScopes: result.restoredScopes,
        ...(result.failedScopes ? { failedScopes: result.failedScopes } : {}),
    });
    return {
        ok: true,
        status,
        source: 'happier_scm',
        restoredScopes: [...result.restoredScopes],
        ...(result.failedScopes ? { failedScopes: [...result.failedScopes] } : {}),
        receipts: [receipt],
    };
}

function combineRestoreResults(
    source: CheckpointRestoreSourceV1,
    results: readonly SessionRestoreResultV1[],
): SessionRestoreResultV1 {
    const accumulatedReceipts = results.flatMap((result) => result.receipts ?? []);
    const failed = results.find((result) => !result.ok) as Extract<SessionRestoreResultV1, { ok: false }> | undefined;
    if (failed) {
        // Preserve the receipts of parts that already succeeded (and mutated) before a later
        // part failed, so the transcript can still see scope-by-scope progress (e.g. provider
        // conversation restored, SCM workspace failed) instead of an ambiguous bare failure.
        return {
            ...failed,
            ...(accumulatedReceipts.length > 0 ? { receipts: accumulatedReceipts } : {}),
        };
    }
    const successfulResults = results as readonly Extract<SessionRestoreResultV1, { ok: true }>[];
    const restoredScopes = successfulResults.flatMap((result) => result.restoredScopes);
    const failedScopes = successfulResults.flatMap((result) => result.failedScopes ?? []);
    const receipts = successfulResults.flatMap((result) => result.receipts);
    const status = failedScopes.length > 0 || successfulResults.some((result) => result.status === 'partially_succeeded')
        ? 'partially_succeeded'
        : 'succeeded';
    return {
        ok: true,
        status,
        source,
        restoredScopes,
        ...(failedScopes.length > 0 ? { failedScopes } : {}),
        receipts,
    };
}

async function restoreCandidateRef(
    params: Readonly<{
        request: SessionRestoreRequestV1;
        candidate: CheckpointCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        ports: RestoreSessionCheckpointPorts;
        lifecycleId: string;
    }>,
): Promise<SessionRestoreResultV1> {
    if (params.candidate.source === 'provider') {
        return restoreProviderCandidate({
            request: params.request,
            candidate: params.candidate,
            scopes: params.scopes,
            ports: params.ports,
            lifecycleId: params.lifecycleId,
        });
    }
    if (params.candidate.source === 'happier_scm') {
        return restoreScmCandidate({
            request: params.request,
            candidate: params.candidate,
            scopes: params.scopes,
            ports: params.ports,
            lifecycleId: params.lifecycleId,
        });
    }

    const results: SessionRestoreResultV1[] = [];
    for (const part of params.candidate.parts) {
        results.push(await restoreCandidateRef({
            request: params.request,
            candidate: part.candidate,
            scopes: part.scopes,
            ports: params.ports,
            lifecycleId: params.lifecycleId,
        }));
    }
    return combineRestoreResults('composed', results);
}

export async function restoreSessionCheckpoint(
    params: RestoreSessionCheckpointParams,
): Promise<SessionRestoreResultV1> {
    const request = SessionRestoreRequestV1Schema.parse(params.request);
    const resolvedCandidate = await resolveRestoreCandidate(request, params.ports);
    if (resolvedCandidate.result) {
        return resolvedCandidate.result;
    }
    const candidate = resolvedCandidate.candidate;
    if (!candidate) {
        return failureResult('restore_target_missing');
    }

    if (request.confirmation?.sourceChoiceConfirmed !== true) {
        return failureResult('confirmation_required', {
            candidates: [buildAdHocCandidate(candidate, request.scopes)],
        });
    }

    if (!await params.ports.isSessionIdle(request.sessionId)) {
        return failureResult('session_not_idle');
    }

    return restoreCandidateRef({
        request,
        candidate,
        scopes: request.scopes,
        ports: params.ports,
        lifecycleId: buildLifecycleId(request, params.ports),
    });
}
