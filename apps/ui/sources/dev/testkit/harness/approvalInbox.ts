import { act } from 'react-test-renderer';

/**
 * The two real approval writers a surface test needs around the Home
 * governance harness's stateful Artifact store.
 *
 * Both run the shipped generic executor over the harness's network boundary,
 * so the Artifact codec, the approval subject/transition owner, its CAS writer
 * and the Home family transport all stay real. A test therefore observes only
 * states the product itself can write — never a hand-built terminal record.
 *
 * The executor is imported lazily: the harness installs its boundaries with
 * `vi.doMock`, which only reaches modules imported afterwards.
 */

type Execute = ReturnType<
    typeof import('@/sync/ops/actions/defaultActionExecutor')['createDefaultActionExecutor']
>['execute'];
type ExecuteResult = Awaited<ReturnType<Execute>>;
/** Filesystem execution lives on the remote daemon, outside this UI process. */
type MachineFilesystemEffects = Pick<import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps,
    'languageIntelligenceApply' | 'workspaceFilesReplace' | 'workspaceFilesReplacePreview'>;

/**
 * An explicit UI proposal through the public approval Action. Ordinary UI
 * presses answer Ask in their native confirmation and do not create an Inbox item.
 */
export async function createUiApprovalRequest(input: Readonly<{
    serverId: string;
    actionId: Parameters<Execute>[0];
    actionInput: Parameters<Execute>[1];
    actionRequestId: string;
    externalActionTarget?: NonNullable<Parameters<Execute>[2]>['externalActionTarget'];
}>): Promise<string> {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
    let result: ExecuteResult | undefined;
    await act(async () => {
        result = await executor.execute('approval.request.create', {
            actionId: input.actionId,
            actionArgs: input.actionInput,
            summary: 'Review the UI proposal',
            createdBy: { surface: 'system' },
        }, {
            serverId: input.serverId,
            surface: 'ui',
            actionRequestId: input.actionRequestId,
            ...(input.externalActionTarget ? { externalActionTarget: input.externalActionTarget } : {}),
        });
    });
    const created = result as { ok?: unknown; result?: { artifactId?: unknown } } | undefined;
    if (created?.ok !== true || typeof created.result?.artifactId !== 'string') {
        throw new Error(`approval_request_not_created:${JSON.stringify(result)}`);
    }
    return created.result.artifactId;
}

/**
 * Creates an agent's explicit proposal through the public approval Action.
 * A person's own UI press supplies admission and cannot stand in for the
 * remote request an approval surface needs to display.
 */
export async function createAgentApprovalRequest(input: Readonly<{
    serverId: string;
    actionId: Parameters<Execute>[0];
    actionInput: Parameters<Execute>[1];
    actionRequestId: string;
    externalActionTarget?: NonNullable<Parameters<Execute>[2]>['externalActionTarget'];
    defaultSessionId?: string;
    defaultSessionMachineId?: string;
}>): Promise<string> {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
    let result: ExecuteResult | undefined;
    await act(async () => {
        result = await executor.execute('approval.request.create', {
            actionId: input.actionId,
            actionArgs: input.actionInput,
            summary: 'Review the agent request',
            createdBy: { surface: 'agent' },
        }, {
            serverId: input.serverId,
            surface: 'agent',
            authority: 'account_automation',
            actionRequestId: input.actionRequestId,
            ...(input.externalActionTarget ? { externalActionTarget: input.externalActionTarget } : {}),
            ...(input.defaultSessionId ? { defaultSessionId: input.defaultSessionId } : {}),
            ...(input.defaultSessionMachineId ? { defaultSessionMachineId: input.defaultSessionMachineId } : {}),
        });
    });
    const created = result as { ok?: unknown; result?: { artifactId?: unknown } } | undefined;
    if (created?.ok !== true
        || typeof created.result?.artifactId !== 'string') {
        throw new Error(`approval_request_not_created:${JSON.stringify(result)}`);
    }
    return created.result.artifactId;
}

/**
 * Decides a pending approval the way Approval Detail, the Prompt Card and the
 * Inbox do (`useApprovalDecisionHandler`): a generic executor with no mounted
 * port, addressed to the Artifact's Home. Any effect it runs is a replay
 * through the captured Home scope, so a mounted surface can only learn the
 * outcome through the shared approval lifecycle.
 */
export async function decideApprovalAsInbox(
    serverId: string,
    artifactId: string,
    decision: 'approve' | 'reject' | 'cancel',
): Promise<ExecuteResult> {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
    let result: ExecuteResult | undefined;
    await act(async () => {
        result = await executor.execute('approval.request.decide', { artifactId, decision }, {
            surface: 'ui',
            serverId,
        });
    });
    return result!;
}

/**
 * An exact-daemon RPC boundary for an approved host-origin Machine Action.
 * The real Protocol executor claims and settles the real Home Artifact; only
 * the process IO remains in the test's existing daemon RPC boundary.
 */
export async function replayApprovedAsDaemon(input: Readonly<{
    serverId: string;
    machineId: string;
    artifactId: string;
    signal?: AbortSignal;
    /** Runtime-native Actions use their real owner over the caller's daemon IO boundary. */
    runtimeActionExecute?: import('@happier-dev/protocol/actions/executor/types').RuntimeActionExecute;
    artifactAction?: import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps['artifactAction'];
    machineFilesystemEffects?: MachineFilesystemEffects;
    /** The Home external-Action ingress decides before replaying at that daemon. */
    decision?: 'approve';
}>): Promise<ExecuteResult> {
    const [{ createActionExecutor }, { approvalArtifactBodyMatchesHeaderV1 },
        { captureLazyActionAccountContext }, { createMachineConnectionActionDeps },
        { writeApprovalRequestArtifact }, { isApprovalExecutionOriginCurrentForAccountContext },
        { createUiConnectedServiceAction }, { executeActionOperationActionV1 }, { machineRpcWithServerScope },
        { resolveServerProfileScopeIdForIdentifier }, { createUiProviderActionExecuteV1 }, { createUiProjectWorkerActionV1 },
        { createUiFilesystemAction }, { createUiScmAction }, { sessionStopWithServerScope }] = await Promise.all([
        import('@happier-dev/protocol/actions/actionExecutor'),
        import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1'),
        import('@/sync/ops/actions/actionAccountContext'),
        import('@/sync/ops/actions/machineConnectionActionDeps'),
        import('@/sync/ops/actions/approvalArtifactWriter'),
        import('@/sync/ops/actions/defaultActionExecutor'),
        import('@/sync/ops/actions/connectedServiceActionDeps'),
        import('@happier-dev/protocol/actions/executor/actionOperationActions'),
        import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'),
        import('@/sync/domains/server/serverProfiles'),
        import('@/sync/ops/actions/providerActionDeps'),
        import('@/sync/ops/actions/projectWorkerAction'),
        import('@/sync/ops/actions/filesystemActionDeps'),
        import('@/sync/ops/actions/scmActionDeps'),
        import('@/sync/ops/sessions'),
    ]);
    const account = await captureLazyActionAccountContext(input.serverId, input.signal);
    try {
        const read = (artifactId: string) => account.fetchArtifact(artifactId);
        const deps = {
            ...input.machineFilesystemEffects,
            ...createMachineConnectionActionDeps(),
            resolveServerProfileScopeId: resolveServerProfileScopeIdForIdentifier,
            ...(input.runtimeActionExecute ? { runtimeActionExecute: input.runtimeActionExecute } : {}),
            ...(input.artifactAction ? { artifactAction: input.artifactAction } : {}),
            connectedServiceAction: createUiConnectedServiceAction(account),
            providerActionExecute: createUiProviderActionExecuteV1(account),
            projectWorkerAction: createUiProjectWorkerActionV1(account),
            filesystemActionExecute: createUiFilesystemAction(),
            scmActionExecute: createUiScmAction(account),
            sessionStop: ({ sessionId, stopIntent, context, signal }) => sessionStopWithServerScope(sessionId, {
                serverId: account.serverId, scope: account.accountLifetime.scope, stopIntent, signal,
                actionContext: context, isCurrent: account.accountLifetime.isCurrent,
            }),
            actionOperationAction: args => executeActionOperationActionV1({ ...args,
                transport: request => machineRpcWithServerScope({ ...request, accountId: account.accountId }),
            }),
            approvalsGet: async ({ artifactId }) => {
                const artifact = await read(artifactId);
                if (!artifact?.header || typeof artifact.body !== 'string') return null;
                const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
                return matched?.family === 'built_in' ? matched.request : null;
            },
            approvalsUpdate: async ({ artifactId, request }) => writeApprovalRequestArtifact({
                artifactId, request, read,
                write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis),
            }),
            isApprovalExecutionOriginCurrent: async ({ origin }) => {
                account.assertCurrent();
                return origin.caller.kind === 'host' && origin.machineId === input.machineId
                    && isApprovalExecutionOriginCurrentForAccountContext({ origin,
                        accountServerId: account.serverId, accountId: account.accountId });
            },
        } satisfies Partial<import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps>;
        // This boundary exposes only Machine and approval effects; unrelated
        // required executor ports cannot be reached by its admitted Action.
        const executor = createActionExecutor(deps as import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps);
        if (input.decision) return await executor.execute('approval.request.decide', { artifactId: input.artifactId, decision: input.decision }, {
            surface: 'ui', authority: 'present_user', serverId: account.serverId, runtimeAccountId: account.accountId,
            ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        return await executor.replayApprovedApprovalRequest({ artifactId: input.artifactId, callerAuthority: 'present_user',
            ...(input.signal ? { signal: input.signal } : {}) });
    } finally { account.dispose(); }
}

/** The Home's own-Machine HTTP decision endpoint, backed by the real approval replay owner. */
export async function executeOwnMachineApprovalDecisionBoundary(input: Readonly<{
    serverId: string;
    machineId: string;
    body: unknown;
    signal?: AbortSignal | null;
    runtimeActionExecute?: import('@happier-dev/protocol/actions/executor/types').RuntimeActionExecute;
    machineFilesystemEffects?: MachineFilesystemEffects;
}>) {
    const [{ ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema }, { getActionSpec }] = await Promise.all([
        import('@happier-dev/protocol/actions/externalActionApi'),
        import('@happier-dev/protocol/actions/actionSpecs'),
    ]);
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input.body);
    if (envelope.target?.kind !== 'machine' || envelope.target.machineId !== input.machineId) throw new Error('Wrong approval Machine');
    const decision = getActionSpec('approval.request.decide').inputSchema.parse(envelope.input);
    if (typeof decision !== 'object' || decision === null || !('artifactId' in decision)
        || typeof decision.artifactId !== 'string') throw new Error('Missing approval Artifact');
    const result = await replayApprovedAsDaemon({ serverId: input.serverId, machineId: input.machineId,
        artifactId: decision.artifactId, decision: 'approve', ...(input.signal ? { signal: input.signal } : {}),
        ...(input.runtimeActionExecute ? { runtimeActionExecute: input.runtimeActionExecute } : {}),
        ...(input.machineFilesystemEffects ? { machineFilesystemEffects: input.machineFilesystemEffects } : {}),
    });
    return ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide', requestId: envelope.requestId, execution: result });
}

/** Home HTTP and Machine RPC remain boundaries; approval/Artifact/effect owners are real. */
export async function installOwnMachineApprovalReplayBoundary(input: Readonly<{
    harness: import('./homeGovernanceHarness').HomeGovernanceHarness;
    serverId: string;
    accountId: string;
    machineId: string;
    runtimeActionExecute?: import('@happier-dev/protocol/actions/executor/types').RuntimeActionExecute;
    machineFilesystemEffects?: MachineFilesystemEffects;
}>) {
    const { createPlainMachineRowFixture } = await import('../fixtures/machineFixtures');
    const machine = {
        ...createPlainMachineRowFixture({ id: input.machineId, accountId: input.accountId }),
        installationId: `${input.machineId}-installation`,
    };
    input.harness.answer(input.serverId, '/v1/machines', { body: [machine] });
    input.harness.answer(input.serverId, `GET /v1/machines/${input.machineId}`, { body: { machine } });
    input.harness.answer(input.serverId, '/v1/actions/approval.request.decide', { select: async (body, request) => {
        return { body: await executeOwnMachineApprovalDecisionBoundary({ ...input, body, signal: request.signal }) };
    } });
}
