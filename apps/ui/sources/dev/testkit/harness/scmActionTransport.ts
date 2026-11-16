import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmComparisonCaptureInputSchema, ScmDiffSummaryGenerateInputSchema, buildScmReviewedMarksKey, buildScmReviewScopeId, createScmReviewedMarksRecordPort, type ScmReviewedMarksSelection } from '@happier-dev/protocol/scm';
import { createScmReviewedMarksOperations } from '@/sync/ops/scmDiffSummary/reviewedMarks';
import { createScmDiffSummaryOperations, type ScmDiffSummaryGenerateRpc, type ScmComparisonCaptureRpc } from '@/sync/ops/scmDiffSummary/generate';
import {
    createScmDiffSummaryResultOperations,
    type ScmDiffSummaryResultRpc,
} from '@/sync/ops/scmDiffSummary/results';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import nacl from 'tweetnacl';
import type { HomeGovernanceHarness } from './homeGovernanceHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExternalActionAccountHttpBoundary } from './externalActionAccountHttpBoundary';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';

/** Run admission crosses Home HTTP; result reads and other SCM RPCs remain separate boundaries. */
export async function createScmRunActionHttpBoundary(params: Readonly<{
    serverUrl: string; serverIdentityId: string; accountId: string; machineId: string;
    actionIds: readonly ActionId[];
    execute(actionId: ActionId, input: unknown): unknown | Promise<unknown>;
}>) {
    const boundaries = await Promise.all(params.actionIds.map(actionId => createExternalActionAccountHttpBoundary({
        ...params, actionId, tokenEpoch: 0, execute: input => params.execute(actionId, input),
        failure: readActionFailureEnvelope,
    })));
    const paths = ['/v1/machines', '/v1/machines/read-batch', `/v1/machines/${encodeURIComponent(params.machineId)}`,
        ...params.actionIds.flatMap(actionId => [`/v1/actions/${actionId}`, `/v1/actions/${actionId}/execution-authorization`])];
    const handle = async (url: URL, init?: RequestInit) => {
        for (const boundary of boundaries) {
            const response = await boundary.handle(url, init);
            if (response) return response;
        }
        return null;
    };
    return { handle, installOn(homes: HomeGovernanceHarness, serverId: string) {
        for (const path of paths) homes.answer(serverId, path, { select: async input => {
            const response = await handle(new URL(path, params.serverUrl), input === undefined ? undefined
                : { method: 'POST', body: JSON.stringify(input) });
            if (!response) throw new Error(`Unexpected SCM Run Action fixture path: ${path}`);
            return { body: await response.json() };
        } });
    } };
}

/** Home HTTP is the boundary; requester sealing and Account Action admission remain real. */
export function answerScmRunMachineCustodyForTests(homes: HomeGovernanceHarness, serverId: string, actionId: ActionId,
    binding: Readonly<{ homeId: string; accountId: string; machineId: string; installationId: string }>) {
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const machine = { ...createPlainMachineRowFixture({ id: binding.machineId, accountId: binding.accountId }),
        installationId: binding.installationId, installationPublicKey: encodeBase64(installation.publicKey) };
    homes.answer(serverId, `/v1/machines/${binding.machineId}`, { body: { machine } });
    homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: binding.accountId, custodianAccountId: binding.accountId, authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', serverIdentityId: binding.homeId, machineId: binding.machineId,
            installationId: binding.installationId, actionId, requestId: mint.envelope.requestId, target: mint.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
        } }) };
    } });
    return installation;
}

/** Keep Action policy, schemas and result normalization real above the Machine RPC boundary. */
export function createScmDiffSummaryResultOperationsWithTransport(
    params: Parameters<typeof createScmDiffSummaryResultOperations>[0] & Readonly<{ rpc?: ScmDiffSummaryResultRpc }>,
) {
    const { rpc, ...captured } = params;
    const actionExecutor = captured.actionExecutor ?? (rpc ? createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
        scmActionExecute: ({ actionId, input, context }) => {
            const method = getActionSpec(actionId).bindings?.rpcMethod;
            if (!method) throw new Error(`Missing SCM transport for ${actionId}`);
            // The real Action owner has validated this saved-result request before transport.
            return rpc(method, input as Readonly<{ cwd: string }>, { signal: context.signal });
        },
    // Unrelated transports are intentionally absent from this boundary fixture.
    }))) : undefined);
    return createScmDiffSummaryResultOperations({ ...captured, ...(actionExecutor ? { actionExecutor } : {}) });
}

/** Generator/capture network replies remain below real Action schema and policy admission. */
export function createScmDiffSummaryOperationsWithTransport(
    params: Parameters<typeof createScmDiffSummaryOperations>[0] & Readonly<{
        generateSummary?: ScmDiffSummaryGenerateRpc; draftPullRequest?: ScmDiffSummaryGenerateRpc; captureComparison?: ScmComparisonCaptureRpc;
    }> = {},
) {
    const { generateSummary, draftPullRequest, captureComparison, ...captured } = params;
    const actionExecutor = captured.actionExecutor ?? ((generateSummary || draftPullRequest || captureComparison) ? createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
        scmActionExecute: ({ actionId, input, context }) => {
            const accountId = context.runtimeAccountId ?? context.expectedAccountId;
            const options = { ...(accountId && context.serverId ? { scope: { serverId: context.serverId, accountId } }
                : context.serverId ? { serverId: context.serverId.trim() } : {}),
                ...(context.signal ? { signal: context.signal } : {}) };
            const sessionId = context.externalActionTarget?.kind === 'session'
                ? context.externalActionTarget.sessionId : context.defaultSessionId ?? '';
            if (actionId === 'scm.diffSummary.generate' && generateSummary)
                return generateSummary(sessionId, ScmDiffSummaryGenerateInputSchema.parse(input), options);
            if (actionId === 'scm.diffSummary.draftPullRequest' && draftPullRequest)
                return draftPullRequest(sessionId, ScmDiffSummaryGenerateInputSchema.parse(input), options);
            if (actionId === 'scm.diffSummary.capture' && captureComparison)
                return captureComparison(sessionId, ScmComparisonCaptureInputSchema.parse(input), options);
            throw new Error(`Unexpected SCM transport for ${actionId}`);
        },
    // These suites own generator/capture boundaries, not unrelated Action transports.
    }))) : undefined);
    return createScmDiffSummaryOperations({ ...captured, ...(actionExecutor ? { actionExecutor } : {}) });
}

/** These Account transport fixtures host the real admitted record owner beneath Action policy/schema admission. */
export function createScmReviewedMarksOperationsWithTransport(params: ScmReviewedMarksSelection & Omit<Parameters<typeof createScmReviewedMarksOperations>[0], 'comparison' | 'source' | 'setReviewedAction'>
    & Partial<Pick<Parameters<typeof createScmReviewedMarksOperations>[0], 'setReviewedAction'>>) {
    const scope = params.comparison ? { repositoryRootPath: params.comparison.repository.rootPath, source: params.comparison.source } : params.source!;
    const transport = createAccountKvJsonTransport({ ...params, key: buildScmReviewedMarksKey(buildScmReviewScopeId(scope)) });
    const port = createScmReviewedMarksRecordPort({ ...(params.comparison ? { comparison: params.comparison } : { source: params.source! }),
        transport, ...(params.getSelection ? { getSelection: params.getSelection } : {}) });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        scmActionExecute: async ({ actionId, input }) => {
            const { ScmReviewedUnmarkInputSchema } = await import('@happier-dev/protocol/scm');
            const request = ScmReviewedUnmarkInputSchema.parse(input);
            try {
                return await ('reset' in request ? port.clear() : 'changeKeys' in request
                    ? port.setReviewedKeys(request.changeKeys, actionId === 'scm.diffSummary.reviewed.mark')
                    : port.setReviewed(request.changeRefs, actionId === 'scm.diffSummary.reviewed.mark'));
            } catch (error) {
                return { success: false, errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                    ? error.code : 'reviewed_marks_unavailable', error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' };
            }
        },
    }));
    return createScmReviewedMarksOperations({ ...params, setReviewedAction: params.setReviewedAction ?? (async (input, reviewed) => {
        const response = await executor.execute(reviewed ? 'scm.diffSummary.reviewed.mark' : 'scm.diffSummary.reviewed.unmark', input,
            { surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'fixture-machine' } });
        return response.ok ? (await import('@happier-dev/protocol/scm')).ScmReviewedMarkResponseSchema.parse(response.result)
            : { success: false, errorCode: response.errorCode ?? 'reviewed_marks_unavailable', error: response.error };
    }) });
}
