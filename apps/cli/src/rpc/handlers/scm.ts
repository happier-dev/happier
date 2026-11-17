import { prepareProjectCheckoutRemoval, requireProjectCheckoutRemovalOperation } from '@/workspaces/projectSetup/projectCheckoutRemoval';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { runHostActionOperation } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';
import { createRpcCallError, RpcError } from '@happier-dev/protocol/rpcErrors';
import { ScmWorktreeRemoveResponseSchema } from '@happier-dev/protocol/scm';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createMemberWorkspaceReadSource } from '@/workspaces/activation/memberWorkspaceSource';
import type { ScmRepositoryDiscoverRequest, ScmRepositoryDiscoverResponse } from '@happier-dev/protocol/scm/repositoryDiscovery';
import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchListRequest,
    ScmBranchListResponse,
    ScmBranchOperationControlRequest,
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
    ScmChangeDiscardRequest,
    ScmChangeDiscardResponse,
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmLogListRequest,
    ScmLogListResponse,
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmRemoteSetUrlRequest,
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmPullRequestCheckoutRequest,
    ScmPullRequestCheckoutResponse,
    ScmPullRequestPrepareWorktreeRequest,
    ScmPullRequestPrepareWorktreeResponse,
    ScmPullRequestRunStackedRequest,
    ScmPullRequestRunStackedResponse,
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmRepositoryCloneInput,
    ScmRepositoryCloneOutput,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
    ScmStashApplyRequest,
    ScmStashApplyResponse,
    ScmStashDropRequest,
    ScmStashCreateRequest,
    ScmStashCreateResponse,
    ScmStashDropResponse,
    ScmStashListRequest,
    ScmStashListResponse,
    ScmStashPopRequest,
    ScmStashPopResponse,
    ScmStashShowRequest,
    ScmStashShowResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';
import type { ScmCommitUndoLastRequest, ScmCommitUndoLastResponse, ScmConflictAcceptSideRequest, ScmConflictMarkResolvedRequest } from '@happier-dev/protocol/scm';
import type { ScmSuggestionApplyRequest, ScmSuggestionApplyResponse } from '@happier-dev/protocol/scm';
import type { ScmFileAtRevisionRequest, ScmFileReadResponse } from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { ScmLogListRequestSchema, ScmStatusSnapshotRequestSchema, ScmWorkEvidenceAdmissionSchema, ScmWorkEvidenceReadRequestSchema, summarizeScmChanges } from '@happier-dev/protocol/scm';
import type { ScmWorkEvidenceAdmission } from '@happier-dev/protocol/scm';
import { projectScmStatusSnapshot } from './scmStatusSnapshotProjection';
import { ScmHistoryEntriesRequestSchema, type ScmHistoryEntriesRequest, type ScmHistoryEntriesResponse } from '@happier-dev/protocol/scm/entriesHistoryV1';
import type { ScmStatusSnapshotTransportResponse } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { scmRpcOperationContextStorage } from '@/scm/rpc/operationContext';

import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    executeScmActionOperation,
} from '@/scm/actions/executeScmActionOperation';
import { readScmWorkEvidence } from '@/scm/actions/readScmWorkEvidence';
import { resolveFilesystemAccessPolicy, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ResolvedScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import type { ScmHostingRepositoryResolveAddressRequestV1, ScmHostingRepositoryResolveAddressResponseV1 } from '@happier-dev/protocol/scm/repositoryClone';
import type { ScmHostingRepositoryGetRequestV1, ScmHostingRepositoryGetResponseV1 } from '@happier-dev/protocol/scm/repositoryClone';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { readStoredCredentials } from '@/persistence';
import { sendFileReviewNoteToSession } from '@/session/services/sendFileReviewNote';
import type { FileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createHostScmCommandRunner, isRequesterScmCommandRunnerSelected, resolveCwd, runWithRequesterScmCommandRunner } from '@/scm/runtime';
import { isHostRequesterUnrestrictedOwner, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { FilesystemEffectRequester } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { ApiMachineClient } from '@/api/apiMachine';
import { isScmHostingCredentialRpcMethod, isScmLocalRepositoryReadRpcMethod, isScmLocalRepositoryRpcMethod } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { isScmActionId } from '@happier-dev/protocol/actions/executor/actionFamilies';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { registerScmWorkspaceWatchHandler } from './scmWorkspaceWatch';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { bindWorkspaceSourceRegistrar, currentWorkspaceSource, runWithWorkspaceSource, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import { runWithScmComparisonOperations } from '@/scm/comparisons/comparisonOperations';
import { createMemberScmComparisonOperations } from '@/scm/rpc/memberScmComparison';
import { runWithScmAccountScope } from '@/scm/accountScope';

export function registerScmHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    deps?: Readonly<{
        accessPolicy?: FilesystemAccessPolicy;
        registry?: ScmBackendRegistry;
        hostingProviderRegistry?: ResolvedScmHostingProviderRegistry;
        machineId?: string;
        actionExecutor?: RpcActionExecutor;
        deliverFileAtRevision?: Parameters<typeof executeScmActionOperation>[0]['deliverFileAtRevision'];
        prepareFileBytesExport?: Parameters<typeof executeScmActionOperation>[0]['prepareFileBytesExport'];
        /** The filesystem admission's source decision, shared so SCM reads the same workspace. */
        selectWorkspaceSource?: (context: RpcHandlerContext | undefined, input: unknown) => WorkspaceSource;
        /** The filesystem admission's requester decision, shared so SCM runs where that person may run. */
        resolveRequester?: (context: RpcHandlerContext) => Promise<FilesystemEffectRequester>;
        /** The member execution owner (as bash, Project Open and Sync use it). */
        nativeOperationRuntime?: Pick<ApiMachineClient, 'prepareNativeOperation'> & Partial<Pick<ApiMachineClient, 'readMemberFolderOwner'>>;
        /** The member Workspace effect child: the daemon already admitted this one local repository operation. */
        admittedLocalRepositoryOperation?: true;
        resolveProjectRuntime?: (ingress: RpcHandlerContext) => Promise<ProjectFiniteActionRuntime | null>;
        /** Private member worker callback to the original host Account/operation owner. */
        admittedRemoveWorktree?: Parameters<typeof executeScmActionOperation>[0]['removeWorktree'];
    }>,
): void {
    const refused = (actionErrorCode: string) => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        actionErrorCode, error: 'Source control could not run on this Machine' });
    const readErrorCode = (error: unknown): string => {
        const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        return typeof code === 'string' ? code : 'agent_isolation_unavailable';
    };
    // Can use runs as the person's own member user, only in their own folder (owner rulings
    // 2026-11-02, 2026-11-14), and Manage's repository work in a member folder runs as that folder's
    // member. The whole operation (Git and every repository metadata read) runs in the member
    // Workspace effect child: the daemon never opens a member-controlled path
    // (SEC-FORKC-1115F F1: a symlinked or FIFO Git state file).
    const runAsMember = async (context: RpcHandlerContext, identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>,
        method: string, projectRoot: string | undefined, input: unknown, comparisons?: () => unknown, requesterAccountId?: string): Promise<unknown> => {
        if (!deps?.nativeOperationRuntime) return refused('agent_isolation_unavailable');
        const material = Object.freeze({ materializationKey: context.transportRequestId ?? context.localActionContext?.actionRequestId
            ?? context.callerInputAuthorization?.binding.requestId ?? randomUUID(), environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
        let native: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>>;
        try {
            // This consumes the existing member binding; a person without one has no folder here.
            native = await deps.nativeOperationRuntime.prepareNativeOperation({ requesterIdentity: identity, ingress: context,
                signal: context.signal, readMaterial: () => material, allowMemberPreparation: false });
        } catch (error) { return refused(readErrorCode(error)); }
        try {
            if (!native.memberIdentity) return refused('agent_isolation_unavailable');
            if (comparisons) return await runWithScmAccountScope(requesterAccountId,
                () => runWithScmComparisonOperations(createMemberScmComparisonOperations({ native, signal: context.signal }), comparisons), context.callerInputAuthorization);
            const { readScmAsMember } = await import('@/scm/rpc/memberScmRead');
            const memberRoot = native.memberIdentity.workspaceRoot;
            const removeMemberWorktree: import('@/scm/rpc/memberScmRead').MemberScmRemovalService | undefined = deps.resolveProjectRuntime
                ? async (removal, workspace) => {
                    try {
                        return await runWithWorkspaceSource(createMemberWorkspaceReadSource(workspace, memberRoot),
                            () => removeProjectWorktree(removal, context, { requesterIdentity: identity, agentIsolation: native.agentIsolation }));
                    } catch (error) {
                        const code = readRpcErrorCode(error) ?? readErrorCode(error);
                        const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
                        throw new PluginError({ code, message: code,
                            ...(details === undefined ? {} : { details: projectNativeJsonValueForTransport(details) }) });
                    }
                } : undefined;
            return await readScmAsMember({ agentIsolation: native.agentIsolation, requesterIdentity: identity,
                workspaceRoot: memberRoot, ...(projectRoot !== undefined ? { root: projectRoot } : {}),
                method, input, signal: context.signal,
                ...(removeMemberWorktree ? { removeWorktree: removeMemberWorktree } : {}) });
        } catch (error) {
            return refused(readErrorCode(error));
        } finally { await native.dispose(); }
    };
    const readRequestCwd = (input: unknown, projectRoot: string | undefined): string => {
        // A clone names its folder as the destination parent.
        const cwd: unknown = input && typeof input === 'object'
            ? Reflect.get(input, 'cwd') ?? Reflect.get(input, 'destinationParentPath') : undefined;
        // Lexical, against the same base the handler resolves it on; the member child resolves links.
        const base = projectRoot ? resolvePath(workingDirectory, expandHomeDirPath(projectRoot)) : workingDirectory;
        return typeof cwd === 'string' && cwd ? resolvePath(base, expandHomeDirPath(cwd)) : base;
    };
    // Manage is full control of this Machine (owner ruling 2026-10-31): an admitted Manage
    // requester's Project SCM runs as the daemon user, like its file effects and shell.
    // Ingress admits anyone else only to a local repository read; closed host calls keep their runner.
    const runAsAdmittedRequester = async (context: RpcHandlerContext | undefined, method: string,
        projectRoot: string | undefined, input: unknown, selected: WorkspaceSource, run: () => unknown): Promise<unknown> => {
        if (!deps?.resolveRequester || !context) return await run();
        const requester = await deps.resolveRequester(context);
        try {
            const identity = requester.identity;
            const comparisons = method.startsWith('scm.diffSummary.') || method === RPC_METHODS.SCM_DIFF_FILE
                && input !== null && typeof input === 'object' && Reflect.get(input, 'captured') !== undefined;
            if (isHostRequesterUnrestrictedOwner(identity)) {
                // Manage keeps full access to a member folder, but daemon Git never runs a member
                // repository's config or hooks (F-A ruling, MEMBER-CHILD-READS-1115): its repository
                // reads and writes (F-B) run in that member's own child, as that member. Happier never
                // adds a safe.directory exception for it. The clone refusal is a consistency guard:
                // clone writes a new directory with this Machine's hosting credentials, and Git cannot
                // check ownership of a directory that does not yet exist. It protects no other person
                // and is not a credential or security boundary (SEC-FORKC-1116B subtraction note).
                const target = readRequestCwd(input, projectRoot);
                const readOwner = deps.nativeOperationRuntime?.readMemberFolderOwner;
                const hosting = isScmHostingCredentialRpcMethod(method);
                const member = readOwner && target !== undefined && (hosting || comparisons || isScmLocalRepositoryRpcMethod(method))
                    ? await readOwner(target).catch(() => 'unavailable' as const) : null;
                if (member === 'unavailable') return refused('agent_isolation_unavailable');
                if (member && hosting) return refused('credential_scope_denied');
                // A member's placed Session already selected its target source: Git runs there, never
                // on this Machine as the member (SEC1116H §4b).
                if (member) return selected.kind === 'local'
                    ? await runAsMember(context, member, method, projectRoot, input, comparisons ? run : undefined, identity.requester.accountId) : await run();
                return await runWithRequesterScmCommandRunner(createHostScmCommandRunner({ isCurrent: () => !context.signal.aborted }), run);
            }
            if (!comparisons && !isScmLocalRepositoryReadRpcMethod(method)) return await run();
            if (identity.kind !== 'isolated') return refused('agent_isolation_unavailable');
            // The member's own placed Session already selected its target: their read runs there, never
            // on this Machine as them (SEC1116I item 1). Another person's placed root stays in the
            // member's own child, whose OS account decides.
            if (selected.kind !== 'local') {
                const owner = await deps.nativeOperationRuntime?.readMemberFolderOwner?.(readRequestCwd(input, projectRoot))
                    .catch(() => null);
                if (owner && owner.requester.serverId === identity.requester.serverId
                    && owner.requester.accountId === identity.requester.accountId) return await run();
            }
            return await runAsMember(context, identity, method, projectRoot, input, comparisons ? run : undefined, identity.requester.accountId);
        } finally { await requester.dispose(); }
    };
    const selectSource = (request: unknown, context: RpcHandlerContext | undefined): WorkspaceSource => {
        const targeted = request && typeof request === 'object' && 'kind' in request && request.kind === 'targeted_action_rpc'
            ? TargetedActionRpcRequestV1Schema.safeParse(request) : null;
        const directory = targeted?.success && targeted.data.target.kind === 'machine' ? targeted.data.target.project?.directory : undefined;
        return deps?.selectWorkspaceSource?.(context, directory ? { rootPath: directory } : request) ?? localWorkspaceSource;
    };
    const sourceBoundRegistrar = bindWorkspaceSourceRegistrar(rpcHandlerManager,
        (context: RpcHandlerContext | undefined, request) => selectSource(request, context));
    const scopedRegistrar = (unwrapTarget: boolean): RpcHandlerRegistrar => ({
        registerHandler<TRequest, TResponse>(
            method: string,
            handler: RpcHandler<TRequest, TResponse>,
        ): void {
            rpcHandlerManager.registerHandler(method, (request, context) => {
                const selected = selectSource(request, context);
                return runWithWorkspaceSource(selected, () => {
                const operationContext = context ?? Object.freeze({ signal: new AbortController().signal });
                const machinePolicy = deps?.accessPolicy ?? resolveFilesystemAccessPolicy();
                const wrapped = request && typeof request === 'object' && 'kind' in request
                    && request.kind === 'targeted_action_rpc';
                const target = wrapped ? TargetedActionRpcRequestV1Schema.safeParse(request) : null;
                if (target && (!target.success || target.data.target.kind !== 'machine'
                    || target.data.target.machineId !== deps?.machineId)) {
                    return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST };
                }
                const root = target?.success && target.data.target.kind === 'machine'
                    ? target.data.target.project?.directory : undefined;
                // A member read never resolves the selected root here: the member child does.
                return runAsAdmittedRequester(context, method, root, target?.success ? target.data.input : request, selected, () => {
                const scoped = root ? resolveCwd(root, workingDirectory, machinePolicy) : null;
                // A selected root can narrow Machine access, never expand it.
                // Resolve this on the receiving filesystem, including symlinks.
                if (scoped && !scoped.ok) {
                    return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH, error: scoped.error };
                }
                const accessPolicy: FilesystemAccessPolicy = scoped
                    ? { kind: 'restrictedRoots', roots: [scoped.cwd] } : machinePolicy;
                return scmRpcOperationContextStorage.run(
                    { context: operationContext, workingDirectory: scoped?.cwd ?? workingDirectory, accessPolicy },
                    // Raw SCM methods consume semantic input; Action-spec RPCs
                    // retain the same envelope for their canonical target parser.
                    () => handler((unwrapTarget && target?.success ? target.data.input : request) as TRequest, operationContext));
                });
                });
            });
        },
    });
    const scmRpcHandlerManager = scopedRegistrar(true);
    const removeProjectWorktree = async (input: Parameters<NonNullable<Parameters<typeof executeScmActionOperation>[0]['removeWorktree']>>[0],
        ingress: RpcHandlerContext | undefined, member?: Pick<ProjectFiniteActionRuntime, 'requesterIdentity' | 'agentIsolation'>): Promise<ScmWorktreeRemoveResponse> => {
            const source = currentWorkspaceSource();
            const installed = ingress ? await deps?.resolveProjectRuntime?.(ingress) : null;
            const runtime = installed && member ? { ...installed, ...member } : installed;
            if (!ingress || !runtime) throw new RpcError('Project cleanup runtime is unavailable', 'project_setup_operation_unavailable');
            const context = buildActionExecutorContextForRpc({ ...ingress, actionId: 'scm.worktree.remove', serverId: runtime.serverId });
            const result = await runHostActionOperation(runtime.operationRuntime.observeExecution, {
                actionId: 'scm.worktree.remove', input: input.request, context,
                execute: async current => {
                    let preparation: ReturnType<typeof prepareProjectCheckoutRemoval> | undefined;
                    const removed = await input.remove(missingWorktree => runWithWorkspaceSource(source, async () => {
                        preparation ??= prepareProjectCheckoutRemoval({ runtime, ingress, context: current,
                            operation: requireProjectCheckoutRemovalOperation(current), worktreePath: input.worktreePath,
                            skipCleanup: input.request.skipCleanup === true, ...(missingWorktree ? { missingWorktree } : {}) });
                        await preparation;
                    }));
                    const prepared = preparation ? await preparation : undefined;
                    if (removed.success) prepared?.settle('deleted');
                    return { ok: true, result: removed };
                },
            }, ingress);
            if (!result.ok) throw createRpcCallError({ error: result.error, errorCode: result.errorCode,
                failureCause: result.failureCause, details: result.details });
            return ScmWorktreeRemoveResponseSchema.parse(result.result);
    };
    const removeWorktree: Parameters<typeof executeScmActionOperation>[0]['removeWorktree'] = deps?.admittedRemoveWorktree
        ?? (deps?.resolveProjectRuntime ? input => removeProjectWorktree(input, scmRpcOperationContextStorage.getStore()?.context) : undefined);
    const routeBase = {
        removeWorktree,
        emitFileReviewNote: async ({ sessionId, ...note }: FileReviewNoteV1 & Readonly<{ sessionId: string }>) => {
            const credentials = await readStoredCredentials();
            if (!credentials) throw new Error('File review note credentials are unavailable');
            await sendFileReviewNoteToSession({ credentials, sessionId, note });
        },
        get sessionId(): string | undefined {
            const authorization = scmRpcOperationContextStorage.getStore()?.context.authorization;
            return authorization?.kind === 'session.write' ? authorization.sessionId : undefined;
        },
        get workingDirectory() { return scmRpcOperationContextStorage.getStore()?.workingDirectory ?? workingDirectory; },
        get accessPolicy() { return scmRpcOperationContextStorage.getStore()?.accessPolicy ?? deps?.accessPolicy; },
        registry: deps?.registry,
        hostingProviderRegistry: deps?.hostingProviderRegistry,
        deliverFileAtRevision: deps?.deliverFileAtRevision,
        prepareFileBytesExport: deps?.prepareFileBytesExport,
        get signal(): AbortSignal | undefined {
            return scmRpcOperationContextStorage.getStore()?.context.signal;
        },
    } as const;
    const authorizeWorkSession = async (sessionId: string | undefined): Promise<boolean> => {
        const ingress = scmRpcOperationContextStorage.getStore()?.context;
        if (!ingress || ingress.signal.aborted) return false;
        if (ingress.authorization?.kind === 'session.write') return ingress.authorization.sessionId === sessionId;
        if (ingress.authorization?.kind === 'scm.workEvidence.admitted') {
            const decision = sessionId ? scmRpcOperationContextStorage.getStore()?.workAdmissions?.get(sessionId) : undefined;
            return decision?.kind === 'session.write';
        }
        return false;
    };
    scmRpcHandlerManager.registerHandler(RPC_METHODS.SCM_WORK_EVIDENCE_READ, async (request: unknown) => {
        const parsed = ScmWorkEvidenceReadRequestSchema.safeParse(request);
        if (!parsed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST };
        const admission = ScmWorkEvidenceAdmissionSchema.safeParse(scmRpcOperationContextStorage.getStore()?.context.authorization);
        if (!admission.success) return { sessions: parsed.data.sessions.map(({ sessionId }) => ({
            sessionId, status: 'error' as const, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, evidence: [], branchEvidence: [],
        })) };
        const workAdmissions = new Map<string, ScmWorkEvidenceAdmission['admissions'][number] | null>();
        for (const decision of admission.data.admissions) {
            workAdmissions.set(decision.sessionId, workAdmissions.has(decision.sessionId) ? null : decision);
        }
        const scope = scmRpcOperationContextStorage.getStore()!;
        return scmRpcOperationContextStorage.run({ ...scope, workAdmissions }, () => readScmWorkEvidence({
            request: parsed.data, ...routeBase, authorizeSession: authorizeWorkSession,
            refusalCode: sessionId => {
                const decision = workAdmissions.get(sessionId);
                return decision?.kind === 'refused' ? decision.errorCode : undefined;
            },
        }));
    });
    registerActionSpecRpcHandlers({
        rpcHandlerManager: scopedRegistrar(false),
        actionIds: ['scm.blame.get', 'scm.diff.file', 'scm.diffSummary.capture', 'scm.diffSummary.generate', 'scm.diffSummary.draftPullRequest',
            'scm.diffSummary.result.list', 'scm.diffSummary.result.clear',
            'scm.diffSummary.result.read', 'scm.diffSummary.result.edit',
            'scm.diffSummary.result.undo', 'scm.diffSummary.result.delete',
            'scm.diffSummary.refine', 'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss',
            'scm.diffSummary.commitPlan.accept', 'scm.diffSummary.commitPlan.stop',
            'scm.diffSummary.commitPlan.includeHookChanges', 'scm.diffSummary.commitPlan.cancel',
            'scm.diffSummary.commitPlan.recover', 'scm.commit.resolveOutcome',
            'scm.diffSummary.reviewed.mark', 'scm.diffSummary.reviewed.unmark'],
        ...(deps?.machineId ? { targetMachineId: deps.machineId } : {}),
        defaultMachineTarget: true,
        mapRequestForMethod: async ({ actionId, method, input }) => {
            // In the member child. Ingress admitted the request and the daemon chose the member; no Action
            // policy or approval runs for it. That is sound only because the child is same-person only: it
            // holds no Account credentials and acts with the folder owner's own OS powers, nobody else's.
            if (deps?.admittedLocalRepositoryOperation && isScmLocalRepositoryRpcMethod(method) && isScmActionId(actionId)) return { accepted: false,
                response: await executeScmActionOperation({ actionId, input, ...routeBase, rpcCompatibility: true }) };
            if (actionId !== 'scm.diff.file') return { accepted: true, input };
            // The scoped registrar already admitted the target. Preserve its
            // envelope for captured evidence's canonical Action admission.
            const request = input && typeof input === 'object' && 'kind' in input
                && input.kind === 'targeted_action_rpc' && 'input' in input ? input.input : input;
            if (request && typeof request === 'object' && 'captured' in request) return { accepted: true, input };
            // Released live file diffs retain their direct backend/response ABI.
            return { accepted: false, response: await executeScmActionOperation({
                actionId: 'scm.diff.file', input: request, ...routeBase, rpcCompatibility: true,
            }) };
        },
        ...(deps?.actionExecutor ? { actionExecutor: deps.actionExecutor } : {}),
        resolveActionExecutor: async () => {
            const credentials = await readStoredCredentials().catch(() => null);
            if (!credentials) return {
                execute: async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' }),
            };
            const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
            return createCliActionExecutorFromCredentials({
                credentials,
                scmFilesystemAccessPolicy: routeBase.accessPolicy ?? resolveFilesystemAccessPolicy(),
                readCredentials: async () => await readStoredCredentials().catch(() => null),
                sessionLogAccess: { workingDirectory: routeBase.workingDirectory, accessPolicy: routeBase.accessPolicy ?? resolveFilesystemAccessPolicy() },
            });
        },
    });
    const statusSnapshotInFlight = new Map<string, Promise<ScmStatusSnapshotResponse>>();
    const statusSnapshotCache = new Map<string, { value: ScmStatusSnapshotResponse; expiresAtMs: number }>();
    let statusSnapshotCacheGeneration = 0;
    const statusSnapshotCacheTtlMs = (() => {
        const raw = (process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS ?? '').trim();
        if (!raw) return 1_000;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1_000;
    })();
    const statusSnapshotKey = (request: ScmStatusSnapshotRequest): string => JSON.stringify({
        // The same path in two workspace sources is two working copies.
        source: currentWorkspaceSource().id,
        // The same path read under another execution placement is another answer.
        requesterPlacement: isRequesterScmCommandRunnerSelected(),
        workingDirectory: routeBase.workingDirectory,
        accessPolicy: routeBase.accessPolicy,
        cwd: request.cwd ?? null,
        backendPreference: request.backendPreference ?? null,
        includeWorktreeStatus: request.includeWorktreeStatus === true,
        operationStateVersion: request.operationStateVersion ?? null,
        outcomeVersion: request.outcomeVersion ?? null,
        // Facts skip the working-copy scan; summary and list pages share the full computation.
        detail: request.detail === 'facts' ? 'facts' : null,
    });
    const invalidateStatusSnapshotCache = (): void => {
        statusSnapshotCacheGeneration += 1;
        statusSnapshotInFlight.clear();
        statusSnapshotCache.clear();
    };
    if (deps?.machineId) registerScmWorkspaceWatchHandler(sourceBoundRegistrar, workingDirectory, {
        accessPolicy: deps.accessPolicy ?? resolveFilesystemAccessPolicy(),
        registry: deps.registry,
        invalidateStatusSnapshot: invalidateStatusSnapshotCache,
    });
    const runWithStatusSnapshotCacheInvalidation = async <T>(operation: () => Promise<T>): Promise<T> => {
        invalidateStatusSnapshotCache();
        try {
            return await operation();
        } finally {
            invalidateStatusSnapshotCache();
        }
    };
    const runStatusSnapshot = (request: ScmStatusSnapshotRequest): Promise<ScmStatusSnapshotResponse> => {
        const key = statusSnapshotKey(request);
        const cached = statusSnapshotCache.get(key);
        if (cached && cached.expiresAtMs > Date.now()) {
            return Promise.resolve(cached.value);
        }
        const existing = statusSnapshotInFlight.get(key);
        if (existing) return existing;
        const cacheGeneration = statusSnapshotCacheGeneration;
        const promise = executeScmActionOperation({
            actionId: 'scm.status.snapshot',
            input: { ...request, detail: request.detail === 'facts' ? 'facts' : undefined, entriesPage: undefined },
            ...routeBase,
            rpcCompatibility: true,
        }).then((result) => {
            const response = result as ScmStatusSnapshotResponse;
            // Compute the full change summary once with the cached domain result, then
            // project only the entries demanded by each response.
            const value: ScmStatusSnapshotResponse = request.detail !== 'facts' && response.snapshot && response.snapshot.entries.length > 0 ? {
                ...response,
                snapshot: {
                    ...response.snapshot,
                    summary: summarizeScmChanges(response.snapshot.entries, response.snapshot.totals),
                },
            } : response;
            if (statusSnapshotCacheTtlMs > 0 && statusSnapshotCacheGeneration === cacheGeneration) {
                statusSnapshotCache.set(key, { value, expiresAtMs: Date.now() + statusSnapshotCacheTtlMs });
            }
            return value;
        });
        statusSnapshotInFlight.set(key, promise);
        void promise.finally(() => {
            if (statusSnapshotInFlight.get(key) === promise) {
                statusSnapshotInFlight.delete(key);
            }
        });
        return promise;
    };

    scmRpcHandlerManager.registerHandler<ScmBackendDescribeRequest, ScmBackendDescribeResponse>(
        RPC_METHODS.SCM_BACKEND_DESCRIBE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.backend.describe',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmBackendDescribeResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStatusSnapshotRequest, ScmStatusSnapshotTransportResponse>(
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        async (request) => {
            const parsed = ScmStatusSnapshotRequestSchema.safeParse(request);
            if (!parsed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST };
            return projectScmStatusSnapshot(await runStatusSnapshot(parsed.data), parsed.data);
        }
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreesEnrichmentRequest, ScmWorktreesEnrichmentResponse>(
        RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktrees.enrichment',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmWorktreesEnrichmentResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmFileAtRevisionRequest, ScmFileReadResponse>(
        RPC_METHODS.SCM_FILE_READ,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.file.read', input: request, ...routeBase,
        }) as ScmFileReadResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmDiffCommitRequest, ScmDiffCommitResponse>(
        RPC_METHODS.SCM_DIFF_COMMIT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.diff.commit',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmDiffCommitResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_INCLUDE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.change.include',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmChangeApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.change.exclude',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmChangeApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmChangeDiscardRequest, ScmChangeDiscardResponse>(
        RPC_METHODS.SCM_CHANGE_DISCARD,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.change.discard',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmChangeDiscardResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmSuggestionApplyRequest, ScmSuggestionApplyResponse>(
        'scm.suggestion.apply',
        async request => await executeScmActionOperation({
            actionId: 'scm.suggestion.apply', input: request, ...routeBase,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmSuggestionApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmCommitCreateRequest, ScmCommitCreateResponse>(
        RPC_METHODS.SCM_COMMIT_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.commit.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmCommitCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmLogListRequest, ScmLogListResponse>(
        RPC_METHODS.SCM_LOG_LIST,
        async (request) => {
            const parsed = ScmLogListRequestSchema.safeParse(request);
            if (!parsed.success) {
                return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid SCM log-list request' };
            }
            return await executeScmActionOperation({
                actionId: 'scm.log.list',
                input: parsed.data,
                ...routeBase,
                rpcCompatibility: true,
            }) as ScmLogListResponse;
        },
    );

    scmRpcHandlerManager.registerHandler<ScmHistoryEntriesRequest, ScmHistoryEntriesResponse>(
        RPC_METHODS.SCM_HISTORY_ENTRIES,
        async request => {
            const parsed = ScmHistoryEntriesRequestSchema.safeParse(request);
            if (!parsed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid SCM entry-history request' };
            // This new wire operation has no predecessor reader. Preserve its closed
            // result and typed witness errors rather than applying released-read projection.
            return await executeScmActionOperation({ actionId: 'scm.history.entries', input: parsed.data,
                ...routeBase }) as ScmHistoryEntriesResponse;
        },
    );

    scmRpcHandlerManager.registerHandler<ScmBranchListRequest, ScmBranchListResponse>(
        RPC_METHODS.SCM_BRANCH_LIST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.list',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
        }) as ScmBranchListResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchCreateRequest, ScmBranchCreateResponse>(
        RPC_METHODS.SCM_BRANCH_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>(
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.checkout',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchCheckoutResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_MERGE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.merge',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_REBASE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.rebase',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.operation.continue',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.operation.abort',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_SKIP,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.operation.skip',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmConflictAcceptSideRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_CONFLICT_ACCEPT_SIDE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.conflict.acceptSide',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmConflictMarkResolvedRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_CONFLICT_MARK_RESOLVED,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.conflict.markResolved',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>(
        RPC_METHODS.SCM_WORKTREE_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktree.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmWorktreeCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>(
        RPC_METHODS.SCM_WORKTREE_REMOVE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktree.remove',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmWorktreeRemoveResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreePruneRequest, ScmWorktreePruneResponse>(
        RPC_METHODS.SCM_WORKTREE_PRUNE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktree.prune',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmWorktreePruneResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmCommitBackoutRequest, ScmCommitBackoutResponse>(
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.commit.backout',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmCommitBackoutResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmCommitUndoLastRequest, ScmCommitUndoLastResponse>(
        RPC_METHODS.SCM_COMMIT_UNDO_LAST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.commit.undoLast',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmCommitUndoLastResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteAddRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_ADD,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.add',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteManagementResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_SET_URL,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.setUrl',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteManagementResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_REMOVE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.remove',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteManagementResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_FETCH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.fetch',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PUSH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.push',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PULL,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.pull',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemotePublishRequest, ScmRemotePublishResponse>(
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.publish',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemotePublishResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestListRequest, ScmPullRequestListResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_LIST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.list',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
        }) as ScmPullRequestListResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestGetRequest, ScmPullRequestGetResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_GET,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.get',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
        }) as ScmPullRequestGetResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.openCompose',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmPullRequestOpenComposeResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.openOrReuse',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestOpenOrReuseResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.checkout',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestCheckoutResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.prepareWorktree',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestPrepareWorktreeResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.runStacked',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestRunStackedResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryDiscoverRequest, ScmRepositoryDiscoverResponse>(
        RPC_METHODS.SCM_REPOSITORY_DISCOVER,
        async request => await executeScmActionOperation({ actionId: 'scm.repository.discover',
            input: request, ...routeBase }) as ScmRepositoryDiscoverResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryInitRequest, ScmRepositoryInitResponse>(
        RPC_METHODS.SCM_REPOSITORY_INIT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.repository.init',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRepositoryInitResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryCloneInput, ScmRepositoryCloneOutput>(
        RPC_METHODS.SCM_REPOSITORY_CLONE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.repository.clone',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRepositoryCloneOutput,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryGetRequestV1, ScmHostingRepositoryGetResponseV1>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_GET,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.get', input: request, ...routeBase,
        }) as ScmHostingRepositoryGetResponseV1,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryResolveAddressRequestV1, ScmHostingRepositoryResolveAddressResponseV1>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_RESOLVE_ADDRESS,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.resolveAddress', input: request, ...routeBase,
        }) as ScmHostingRepositoryResolveAddressResponseV1,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.describePublishTargets',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmHostingRepositoryDescribePublishTargetsResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.publish',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmHostingRepositoryPublishResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>(
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.repository.removeIndexLock',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRepositoryRemoveIndexLockResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashListRequest, ScmStashListResponse>(
        RPC_METHODS.SCM_STASH_LIST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.list',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmStashListResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashDropRequest, ScmStashDropResponse>(
        RPC_METHODS.SCM_STASH_DROP,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.drop',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashDropResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashCreateRequest, ScmStashCreateResponse>(
        RPC_METHODS.SCM_STASH_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashPopRequest, ScmStashPopResponse>(
        RPC_METHODS.SCM_STASH_POP,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.pop',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashPopResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashApplyRequest, ScmStashApplyResponse>(
        RPC_METHODS.SCM_STASH_APPLY,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.apply',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashShowRequest, ScmStashShowResponse>(
        RPC_METHODS.SCM_STASH_SHOW,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.show',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmStashShowResponse,
    );
}
