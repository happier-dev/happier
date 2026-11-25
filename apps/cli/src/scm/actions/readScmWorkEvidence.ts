import {
    ScmBranchListResponseSchema,
    ScmPullRequestListResponseSchema,
    type ScmBranchListResponse,
    type ScmBranchListRequest,
    type ScmBranchWorkEvidence,
    type ScmPullRequestWorkEvidence,
    type ScmWorkEvidenceReadRequest,
    type ScmWorkEvidenceReadResponse,
    type ScmWorkEvidenceSessionResult,
} from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES, ScmNativeOperationRefusalSchema } from '@happier-dev/protocol/scm/operationError';

import { resolveCwd } from '@/scm/runtime';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { joinRepositoryCheckpointPullRequestEvidence, readRepositoryCheckpointBranchEvidence,
    type ReadSharedRepositoryCheckpointGraph } from '../checkpoints/sessionEvidence';
import { notRepositoryResponse, runScmRoute } from '../rpc/dispatch';
import { executeScmActionOperation, type ExecuteScmActionOperationParams } from './executeScmActionOperation';

type SourceResult = Readonly<{
    status: 'partial' | 'unsupported' | 'error';
    evidence?: ScmPullRequestWorkEvidence[];
    allPullRequestsEvaluated?: boolean;
    branchEvidence?: ScmBranchWorkEvidence[];
    errorCode?: string;
    executionRefused?: true;
}>;

function failedSource(errorCode: string | undefined): SourceResult {
    return { status: 'error', errorCode: errorCode ?? 'work_evidence_failed' };
}

function parseWorkReply<T extends { success: boolean }>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    wire: unknown,
): { data: T } | { failure: SourceResult } {
    const reply = schema.safeParse(wire);
    if (reply.success && reply.data.success) return { data: reply.data };
    const refusal = ScmNativeOperationRefusalSchema.safeParse(wire);
    if (refusal.success) {
        return { failure: { status: 'error', errorCode: refusal.data.actionErrorCode, executionRefused: true } };
    }
    return reply.success ? { data: reply.data } : { failure: failedSource(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST) };
}

function isNativeFailure(errorCode: string | undefined): boolean {
    return errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE
        || errorCode === SCM_OPERATION_ERROR_CODES.COMMAND_FAILED
        || errorCode === SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT
        || errorCode === SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED
        || errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED
        || errorCode === SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED;
}

/** Combine independent native sources without letting a refusal retain private siblings. */
export function combineScmWorkEvidenceSession(input: Readonly<{
    sessionId: string; turnIds: readonly string[]; branchSource: SourceResult; prSources: readonly SourceResult[];
}>): ScmWorkEvidenceSessionResult {
    const { sessionId } = input;
    const sources: readonly SourceResult[] = [input.branchSource, ...input.prSources].map(source => source.status === 'error' && !source.executionRefused
        && (source.errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED || source.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY)
        ? { status: 'unsupported' as const } : source);
    // An unavailable backend can leave independent witnesses usable. An
    // execution refusal, malformed reply or unclassified failure withdraws them.
    const quarantine = sources.find(source => source.status === 'error' && (source.executionRefused || !isNativeFailure(source.errorCode)));
    const errorCode = quarantine?.errorCode ?? sources.find(source => source.errorCode)?.errorCode;
    if (quarantine) {
        return { sessionId, status: 'error', evidence: [], branchEvidence: [], errorCode };
    }
    if (sources.length > 0 && sources.every(source => source.status === 'error')) return { sessionId, status: 'error', errorCode };
    const turns = new Set(input.turnIds);
    return {
        sessionId,
        status: sources.some(source => source.status === 'partial') ? 'partial'
            : sources.some(source => source.status === 'error') ? 'error' : 'unsupported',
        evidence: sources.flatMap(source => source.evidence ?? []).filter(witness => witness.sessionId === sessionId && turns.has(witness.turnId)),
        branchEvidence: sources.flatMap(source => source.branchEvidence ?? []).filter(witness => witness.sessionId === sessionId && turns.has(witness.turnId)),
        ...(input.prSources.length > 0 && input.prSources.every(source => source.allPullRequestsEvaluated === true)
            ? { pullRequestsRead: true } : {}),
        ...(errorCode ? { errorCode } : {}),
    };
}

export async function readScmWorkEvidence(input: Readonly<{
    request: ScmWorkEvidenceReadRequest;
    authorizeSession: (sessionId: string) => Promise<boolean>;
    refusalCode: (sessionId: string) => string | undefined;
}> & Pick<ExecuteScmActionOperationParams, 'workingDirectory' | 'accessPolicy' | 'registry' | 'hostingProviderRegistry' | 'signal'>): Promise<ScmWorkEvidenceReadResponse> {
    const accessPolicy = input.accessPolicy ?? resolveFilesystemAccessPolicy();
    const route = {
        workingDirectory: input.workingDirectory, accessPolicy, registry: input.registry,
        hostingProviderRegistry: input.hostingProviderRegistry, signal: input.signal, rpcCompatibility: true as const,
    };
    const discover = async (cwd: string) => {
        let git = false;
        const request = { cwd, ...(input.request.backendPreference ? { backendPreference: input.request.backendPreference } : {}) };
        const branch = parseWorkReply(ScmBranchListResponseSchema, await runScmRoute<ScmBranchListRequest, ScmBranchListResponse>({
            ...route, request, onNonRepository: () => notRepositoryResponse<ScmBranchListResponse>(),
            runWithBackend: async ({ context, selection }) => {
                git = context.detection.mode === '.git';
                return selection.backend.branchList ? selection.backend.branchList({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED };
            },
        }));
        // A real non-repository has no hosting evidence and needs no PR calls.
        if ('data' in branch && !branch.data.success && branch.data.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY) {
            return { branch, pullRequests: [], git };
        }
        const pullRequests = await Promise.all((['open', 'closed', 'merged'] as const).map(async state =>
            parseWorkReply(ScmPullRequestListResponseSchema, await executeScmActionOperation({
                ...route, actionId: 'scm.pullRequest.list', input: { ...request, state },
            }))));
        return { branch, pullRequests, git };
    };
    // Discovery follows the checkout. Immutable walks follow its canonical Git
    // common-directory identity and exact revision. Both are shared only in this RPC.
    type SuccessfulGraph = Extract<Awaited<ReturnType<ReadSharedRepositoryCheckpointGraph>>, { success: true }>;
    const reads = new Map<string,
        | { kind: 'checkout'; promise: ReturnType<typeof discover> }
        | { kind: 'graph'; promise: Promise<SuccessfulGraph | undefined> }>();
    const readSharedGraph: ReadSharedRepositoryCheckpointGraph = async (repositoryKey, revision, read) => {
        const key = JSON.stringify(['graph', repositoryKey, revision]);
        const incumbent = reads.get(key);
        if (incumbent?.kind === 'graph') {
            const shared = await incumbent.promise;
            if (shared) return shared;

            // A failed walk belongs to that checkout. Each waiting consumer gets its own attempt.
            const own = await read();
            if (own.success && reads.get(key) === incumbent) {
                reads.set(key, { kind: 'graph', promise: Promise.resolve(own) });
            }
            return own;
        }
        const own = read();
        reads.set(key, { kind: 'graph', promise: own.then(graph => graph.success ? graph : undefined, () => undefined) });
        return own;
    };
    const sessions = await Promise.all(input.request.sessions.map(async (session): Promise<ScmWorkEvidenceSessionResult> => {
        const { sessionId } = session;
        if (!await input.authorizeSession(sessionId)) return {
            sessionId, status: 'error', evidence: [], branchEvidence: [],
            errorCode: input.refusalCode(sessionId) ?? SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        };
        const resolved = resolveCwd(session.cwd, input.workingDirectory, accessPolicy);
        if (!resolved.ok) return { sessionId, status: 'error', evidence: [], branchEvidence: [], errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH };
        try {
            const key = JSON.stringify(['checkout', resolved.cwd]);
            let checkout = reads.get(key);
            if (checkout?.kind !== 'checkout') {
                checkout = { kind: 'checkout', promise: discover(resolved.cwd) };
                reads.set(key, checkout);
            }
            const { branch, pullRequests, git } = await checkout.promise;
            if ('data' in branch && !branch.data.success && branch.data.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY) {
                return { sessionId, status: 'unsupported', evidence: [], branchEvidence: [] };
            }
            const scope = { cwd: resolved.cwd, sessionId, signal: input.signal, readSharedGraph };
            const branchSource: SourceResult = 'failure' in branch ? branch.failure
                : !branch.data.success ? failedSource(branch.data.errorCode)
                : !git ? { status: 'unsupported' }
                : await readRepositoryCheckpointBranchEvidence(scope)
                    .then(branchEvidence => ({ status: 'partial' as const, branchEvidence }))
                    .catch(() => ({ status: 'unsupported' as const }));
            const prSources = await Promise.all(pullRequests.map(async (response): Promise<SourceResult> => {
                if ('failure' in response) return response.failure;
                if (!response.data.success) return failedSource(response.data.errorCode);
                if (!response.data.pullRequests) return { status: 'unsupported' };
                return joinRepositoryCheckpointPullRequestEvidence({ ...scope, pullRequests: response.data.pullRequests })
                    .then(({ evidence, allEvaluated }) => ({
                        status: 'partial' as const, evidence, allPullRequestsEvaluated: allEvaluated,
                    }))
                    .catch(() => ({ status: 'unsupported' as const }));
            }));
            input.signal?.throwIfAborted();
            return combineScmWorkEvidenceSession({ ...session, branchSource, prSources });
        } catch {
            return { sessionId, status: 'error', evidence: [], branchEvidence: [], errorCode: 'work_evidence_failed' };
        }
    }));
    return { sessions };
}
