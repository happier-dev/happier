import type {
    BackendSurfaceAvailabilityV1,
    CheckpointCreationCandidateRefV1,
    CheckpointCreationCandidateV1,
    CheckpointOperationReceiptV1,
    CheckpointProviderCreationCandidateRefV1,
    CheckpointRestoreScopeV1,
    CheckpointRestoreSourceV1,
    CheckpointScmCreationCandidateRefV1,
    SanitizedCheckpointCreationCandidateV1,
    SessionCheckpointRequestV1,
    SessionCheckpointResultV1,
} from '@happier-dev/protocol';
import {
    SessionCheckpointRequestV1Schema,
    buildCheckpointOperationReceiptV1,
    sanitizeCheckpointCreationCandidateV1,
} from '@happier-dev/protocol';
import type { CheckpointDescriptorV1 } from '@happier-dev/agents';

type MaybePromise<T> = T | Promise<T>;

type ProviderCheckpointRequest = Readonly<{
    sessionId: string;
    backendId: string;
    scopes: readonly CheckpointRestoreScopeV1[];
    timing: 'idle' | 'activeTurn';
    label?: string;
    signal?: AbortSignal;
}>;

type ScmCheckpointRequest = Readonly<{
    sessionId: string;
    scopes: readonly CheckpointRestoreScopeV1[];
    label?: string;
    signal?: AbortSignal;
}>;

export type ScmCreateCheckpointResult = Readonly<{
    ok: true;
    checkpointRef: string;
}> | Readonly<{
    ok: false;
    code: string;
    message?: string;
}>;

export type CreateSessionCheckpointPorts = Readonly<{
    isSessionIdle: (sessionId: string) => MaybePromise<boolean>;
    collectCreateCandidates: (request: SessionCheckpointRequestV1) => MaybePromise<readonly CheckpointCreationCandidateV1[]>;
    checkpointProvider?: (request: ProviderCheckpointRequest) => MaybePromise<CheckpointDescriptorV1>;
    checkpointScm?: (request: ScmCheckpointRequest) => MaybePromise<ScmCreateCheckpointResult>;
    evaluateProviderAvailability?: (request: Readonly<{
        operation: 'checkpoint';
        sessionId: string;
        scopes: readonly CheckpointRestoreScopeV1[];
        timing: 'idle' | 'activeTurn';
    }>) => MaybePromise<BackendSurfaceAvailabilityV1>;
    createLifecycleId?: (request: SessionCheckpointRequestV1) => string;
    signal?: AbortSignal;
}>;

export type CreateSessionCheckpointParams = Readonly<{
    request: SessionCheckpointRequestV1;
    ports: CreateSessionCheckpointPorts;
}>;

function buildLifecycleId(request: SessionCheckpointRequestV1, ports: CreateSessionCheckpointPorts): string {
    return ports.createLifecycleId?.(request) ?? `checkpoint-create:${request.sessionId}`;
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

function sanitizeCandidates(
    candidates: readonly CheckpointCreationCandidateV1[],
): SanitizedCheckpointCreationCandidateV1[] {
    return candidates.map((candidate) => sanitizeCheckpointCreationCandidateV1(candidate));
}

function failureResult(
    errorCode: Extract<SessionCheckpointResultV1, { ok: false }>['errorCode'],
    options: Readonly<{
        error?: string;
        candidates?: readonly CheckpointCreationCandidateV1[];
        receipts?: readonly CheckpointOperationReceiptV1[];
    }> = {},
): SessionCheckpointResultV1 {
    return {
        ok: false,
        errorCode,
        ...(options.error ? { error: options.error } : {}),
        ...(options.candidates ? { candidates: sanitizeCandidates(options.candidates) } : {}),
        ...(options.receipts ? { receipts: [...options.receipts] } : {}),
    };
}

function buildAdHocCreationCandidate(
    candidate: CheckpointCreationCandidateRefV1,
    scopes: readonly CheckpointRestoreScopeV1[],
): CheckpointCreationCandidateV1 {
    return {
        id: `${candidate.source}:${scopes.join('+')}`,
        source: candidate.source,
        scopes: [...scopes],
        candidate,
    };
}

async function resolveCreateCandidate(
    request: SessionCheckpointRequestV1,
    ports: CreateSessionCheckpointPorts,
): Promise<Readonly<{ candidate?: CheckpointCreationCandidateRefV1; result?: SessionCheckpointResultV1 }>> {
    if (request.candidate) {
        return { candidate: request.candidate };
    }
    const candidates = (await ports.collectCreateCandidates(request))
        .filter((candidate) => candidate.atomic === true
            ? scopesExactlyMatch(candidate.scopes, request.scopes)
            : scopesContainAll(candidate.scopes, request.scopes));
    if (candidates.length === 0) {
        return { result: failureResult('checkpoint_source_unavailable') };
    }
    if (candidates.length > 1) {
        return { result: failureResult('source_choice_required', { candidates }) };
    }
    return { candidate: candidates[0]?.candidate };
}

async function createProviderCheckpoint(
    params: Readonly<{
        request: SessionCheckpointRequestV1;
        candidate: CheckpointProviderCreationCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        ports: CreateSessionCheckpointPorts;
        lifecycleId: string;
    }>,
): Promise<SessionCheckpointResultV1> {
    if (!params.ports.checkpointProvider) {
        return failureResult('checkpoint_source_unavailable');
    }
    if (params.ports.evaluateProviderAvailability) {
        const availability = await params.ports.evaluateProviderAvailability({
            operation: 'checkpoint',
            sessionId: params.request.sessionId,
            scopes: params.scopes,
            timing: params.request.timing,
        });
        if (!availability.available) {
            return failureResult('checkpoint_source_unavailable', { error: availability.reasonCode });
        }
    }
    const descriptor = await params.ports.checkpointProvider({
        sessionId: params.request.sessionId,
        backendId: params.candidate.backendId,
        scopes: params.scopes,
        timing: params.request.timing,
        ...(params.request.label ? { label: params.request.label } : {}),
        ...(params.ports.signal ? { signal: params.ports.signal } : {}),
    });
    const receipt = buildCheckpointOperationReceiptV1({
        operation: 'checkpoint',
        phase: 'succeeded',
        lifecycleId: params.lifecycleId,
        source: 'provider',
        scopes: params.scopes,
        candidate: {
            source: 'provider',
            backendId: params.candidate.backendId,
            target: descriptor.target,
        },
    });
    return {
        ok: true,
        status: 'succeeded',
        source: 'provider',
        checkpointRef: descriptor.id,
        receipts: [receipt],
    };
}

async function createScmCheckpoint(
    params: Readonly<{
        request: SessionCheckpointRequestV1;
        candidate: CheckpointScmCreationCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        ports: CreateSessionCheckpointPorts;
        lifecycleId: string;
    }>,
): Promise<SessionCheckpointResultV1> {
    if (!params.ports.checkpointScm) {
        return failureResult('checkpoint_source_unavailable');
    }
    const result = await params.ports.checkpointScm({
        sessionId: params.request.sessionId,
        scopes: params.scopes,
        ...(params.request.label ? { label: params.request.label } : {}),
        ...(params.ports.signal ? { signal: params.ports.signal } : {}),
    });
    if (!result.ok) {
        return failureResult('checkpoint_failed', { error: result.code });
    }
    const receipt = buildCheckpointOperationReceiptV1({
        operation: 'checkpoint',
        phase: 'succeeded',
        lifecycleId: params.lifecycleId,
        source: 'happier_scm',
        scopes: params.scopes,
        candidate: {
            source: 'happier_scm',
            checkpointRef: result.checkpointRef,
        },
    });
    return {
        ok: true,
        status: 'succeeded',
        source: 'happier_scm',
        checkpointRef: result.checkpointRef,
        receipts: [receipt],
    };
}

function combineCreateResults(
    source: CheckpointRestoreSourceV1,
    results: readonly SessionCheckpointResultV1[],
): SessionCheckpointResultV1 {
    const receipts = results.flatMap((result) => result.receipts ?? []);
    const failed = results.find((result) => !result.ok) as Extract<SessionCheckpointResultV1, { ok: false }> | undefined;
    if (failed) {
        return {
            ...failed,
            receipts: receipts.length > 0 ? receipts : failed.receipts,
        };
    }
    const successfulResults = results as readonly Extract<SessionCheckpointResultV1, { ok: true }>[];
    const status = successfulResults.some((result) => result.status === 'partially_succeeded')
        ? 'partially_succeeded'
        : 'succeeded';
    return {
        ok: true,
        status,
        source,
        receipts,
    };
}

async function createCandidateRef(
    params: Readonly<{
        request: SessionCheckpointRequestV1;
        candidate: CheckpointCreationCandidateRefV1;
        scopes: readonly CheckpointRestoreScopeV1[];
        ports: CreateSessionCheckpointPorts;
        lifecycleId: string;
    }>,
): Promise<SessionCheckpointResultV1> {
    if (params.candidate.source === 'provider') {
        return createProviderCheckpoint({
            request: params.request,
            candidate: params.candidate,
            scopes: params.scopes,
            ports: params.ports,
            lifecycleId: params.lifecycleId,
        });
    }
    if (params.candidate.source === 'happier_scm') {
        return createScmCheckpoint({
            request: params.request,
            candidate: params.candidate,
            scopes: params.scopes,
            ports: params.ports,
            lifecycleId: params.lifecycleId,
        });
    }

    const results: SessionCheckpointResultV1[] = [];
    for (const part of params.candidate.parts) {
        results.push(await createCandidateRef({
            request: params.request,
            candidate: part.candidate,
            scopes: part.scopes,
            ports: params.ports,
            lifecycleId: params.lifecycleId,
        }));
    }
    return combineCreateResults('composed', results);
}

export async function createSessionCheckpoint(
    params: CreateSessionCheckpointParams,
): Promise<SessionCheckpointResultV1> {
    const request = SessionCheckpointRequestV1Schema.parse(params.request);
    const candidateResolution = await resolveCreateCandidate(request, params.ports);
    if (candidateResolution.result) {
        return candidateResolution.result;
    }
    const candidate = candidateResolution.candidate;
    if (!candidate) {
        return failureResult('checkpoint_source_unavailable');
    }
    if (request.confirmation?.sourceChoiceConfirmed !== true) {
        return failureResult('confirmation_required', {
            candidates: [buildAdHocCreationCandidate(candidate, request.scopes)],
        });
    }
    if (request.timing === 'idle' && !await params.ports.isSessionIdle(request.sessionId)) {
        return failureResult('session_not_idle');
    }
    const lifecycleId = buildLifecycleId(request, params.ports);
    return createCandidateRef({
        request,
        candidate,
        scopes: request.scopes,
        ports: params.ports,
        lifecycleId,
    });
}
