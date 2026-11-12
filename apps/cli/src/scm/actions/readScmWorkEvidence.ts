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
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';

import { resolveCwd } from '@/scm/runtime';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { readRepositoryCheckpointBranchEvidence, readRepositoryCheckpointPullRequestEvidence } from '../checkpoints/sessionEvidence';
import { notRepositoryResponse, runScmRoute } from '../rpc/dispatch';
import { executeScmActionOperation, type ExecuteScmActionOperationParams } from './executeScmActionOperation';

type SourceResult = Readonly<{
    status: 'partial' | 'unsupported' | 'error';
    evidence?: ScmPullRequestWorkEvidence[];
    branchEvidence?: ScmBranchWorkEvidence[];
    errorCode?: string;
}>;

// Native read failures can leave independent local/hosting witnesses usable.
// Admission, malformed replies and unclassified failures withdraw the Session.
function failedSource(errorCode: string | undefined): SourceResult {
    return { status: 'error', errorCode: errorCode ?? 'work_evidence_failed' };
}

function isNativeFailure(errorCode: string | undefined): boolean {
    return errorCode === SCM_OPERATION_ERROR_CODES.COMMAND_FAILED
        || errorCode === SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT
        || errorCode === SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED
        || errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED
        || errorCode === SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED;
}

/** Combine independent native sources without letting a refusal retain private siblings. */
export function combineScmWorkEvidenceSession(input: Readonly<{
    sessionId: string; turnIds: readonly string[]; sources: readonly SourceResult[];
}>): ScmWorkEvidenceSessionResult {
    const { sessionId } = input;
    const sources: readonly SourceResult[] = input.sources.map(source => source.status === 'error'
        && (source.errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED || source.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY)
        ? { status: 'unsupported' as const } : source);
    const quarantine = sources.find(source => source.status === 'error' && !isNativeFailure(source.errorCode));
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
        const branch = ScmBranchListResponseSchema.safeParse(await runScmRoute<ScmBranchListRequest, ScmBranchListResponse>({
            ...route, request, onNonRepository: () => notRepositoryResponse<ScmBranchListResponse>(),
            runWithBackend: async ({ context, selection }) => {
                git = context.detection.mode === '.git';
                return selection.backend.branchList ? selection.backend.branchList({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED };
            },
        }));
        // A real non-repository has no hosting evidence and needs no PR calls.
        if (branch.success && !branch.data.success && branch.data.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY) {
            return { branch, pullRequests: [], git };
        }
        const pullRequests = await Promise.all((['open', 'closed', 'merged'] as const).map(async state =>
            ScmPullRequestListResponseSchema.safeParse(await executeScmActionOperation({
                ...route, actionId: 'scm.pullRequest.list', input: { ...request, state },
            }))));
        return { branch, pullRequests, git };
    };
    // This request owns discovery sharing; no retained cache or freshness policy.
    const repositories = new Map<string, ReturnType<typeof discover>>();
    const sessions = await Promise.all(input.request.sessions.map(async (session): Promise<ScmWorkEvidenceSessionResult> => {
        const { sessionId } = session;
        if (!await input.authorizeSession(sessionId)) return {
            sessionId, status: 'error', evidence: [], branchEvidence: [],
            errorCode: input.refusalCode(sessionId) ?? SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        };
        const resolved = resolveCwd(session.cwd, input.workingDirectory, accessPolicy);
        if (!resolved.ok) return { sessionId, status: 'error', evidence: [], branchEvidence: [], errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH };
        try {
            let repository = repositories.get(resolved.cwd);
            if (!repository) {
                repository = discover(resolved.cwd);
                repositories.set(resolved.cwd, repository);
            }
            const { branch, pullRequests, git } = await repository;
            if (branch.success && !branch.data.success && branch.data.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY) {
                return { sessionId, status: 'unsupported', evidence: [], branchEvidence: [] };
            }
            const scope = { cwd: resolved.cwd, sessionId, signal: input.signal };
            const branchSource: SourceResult = !branch.success ? failedSource(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST)
                : !branch.data.success ? failedSource(branch.data.errorCode)
                : !git ? { status: 'unsupported' }
                : await readRepositoryCheckpointBranchEvidence(scope)
                    .then(branchEvidence => ({ status: 'partial' as const, branchEvidence }))
                    .catch(() => ({ status: 'unsupported' as const }));
            const prSources = await Promise.all(pullRequests.map(async (response): Promise<SourceResult> => {
                if (!response.success) return failedSource(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
                if (!response.data.success) return failedSource(response.data.errorCode);
                if (!response.data.pullRequests) return { status: 'unsupported' };
                return readRepositoryCheckpointPullRequestEvidence({ ...scope, pullRequests: response.data.pullRequests })
                    .then(evidence => ({ status: 'partial' as const, evidence }))
                    .catch(() => ({ status: 'unsupported' as const }));
            }));
            input.signal?.throwIfAborted();
            return combineScmWorkEvidenceSession({ ...session, sources: [branchSource, ...prSources] });
        } catch {
            return { sessionId, status: 'error', evidence: [], branchEvidence: [], errorCode: 'work_evidence_failed' };
        }
    }));
    return { sessions };
}
