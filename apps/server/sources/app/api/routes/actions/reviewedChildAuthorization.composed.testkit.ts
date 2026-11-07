import { expect } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { invokeHostReviewedChildV1, type ActionExecutorContext, type ActionExecuteResult,
    type HostReviewedChildV1, type HostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createExternalActionMachineRpcExecution, projectExternalActionRequesterHttpAuthorization } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createSignedDiscussionHttpFixture } from './discussionExecutionAuthorization.testkit';
import { projectRequesterAccountActionAuthorization } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';

/** Public Home issuance and the production private child/header/packet issuers; no synthetic binding or proof. */
export async function createReviewedChildAuthorizationFixture(options?: Parameters<typeof createSignedDiscussionHttpFixture>[4]) {
    const fixture = await createSignedDiscussionHttpFixture(undefined, [], false, undefined, options);
    const currentnessRequests: Array<{ method: string | undefined; path: string | undefined; status: number }> = [];
    fixture.app.server.on('request', (request, response) => {
        response.once('finish', () => currentnessRequests.push({ method: request.method, path: request.url, status: response.statusCode }));
    });
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });

    async function root(actionId: ActionId, input: unknown) {
        const issued = await fixture.mint(actionId, input, true);
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: issued,
            serverId: issued.binding.serverIdentityId, serverIdentityId: issued.binding.serverIdentityId,
            serverHttpBaseUrl: origin, target: issued.binding.target, installationId: fixture.machine.installationId!,
            privateKey: fixture.keyPair.secretKey });
        expect(authorization, 'publicly minted root must pass the actual signed Home currentness endpoint').not.toBeNull();
        if (!authorization) throw new Error('reviewed_child_root_projection_required');
        return authorization;
    }

    function context(authorization: ExternalActionExecutionAuthorizationV1): ActionExecutorContext {
        return { surface: 'cli', serverId: authorization.binding.serverIdentityId,
            runtimeAccountId: fixture.account.id, externalActionExecutionAuthorization: authorization,
            externalActionTarget: authorization.binding.target };
    }

    async function withAccountProjection(authorization: ExternalActionExecutionAuthorizationV1) {
        const http = authorization.requesterHttpProjection;
        if (!http) throw new Error('reviewed_child_http_projection_required');
        const projected = await projectRequesterAccountActionAuthorization({ authorization,
            serverIdentityId: authorization.binding.serverIdentityId,
            bootstrap: { credentials: { token: fixture.presentUserToken, encryption: null },
                attribution: { serverId: authorization.binding.serverIdentityId, accountId: fixture.account.id,
                    machineId: fixture.machine.id, installationId: fixture.machine.installationId! },
                serverHttpBaseUrl: origin, isCurrent: http.isCurrent } });
        if (!projected) throw new Error('reviewed_child_account_projection_required');
        const withHttp = await projectExternalActionRequesterHttpAuthorization({ authorization: projected,
            serverId: authorization.binding.serverIdentityId, serverIdentityId: authorization.binding.serverIdentityId,
            serverHttpBaseUrl: origin, target: authorization.binding.target, installationId: fixture.machine.installationId!,
            privateKey: fixture.keyPair.secretKey });
        if (!withHttp) throw new Error('reviewed_child_account_http_projection_required');
        return withHttp;
    }

    async function headers(authorization: ExternalActionExecutionAuthorizationV1,
        request: Readonly<{ effectActionId: string; method: string; path: string; body?: unknown }>) {
        const port = authorization.requesterHttpProjection;
        if (!port) throw new Error('reviewed_child_requester_http_port_required');
        const result = await port.createRequestHeaders(request);
        if (!result) throw new Error('reviewed_child_request_headers_required');
        return result;
    }

    async function child(authorization: ExternalActionExecutionAuthorizationV1, parent: HostReviewedParentV1,
        selected: HostReviewedChildV1, execute: (context: ActionExecutorContext) => Promise<ActionExecuteResult>) {
        return invokeHostReviewedChildV1({ parent, context: context(authorization), child: selected,
            admittedReview: { action: selected.action, role: selected.role, surface: 'cli' },
            execute: async (_input, childContext) => execute(childContext) });
    }

    function rpc(childContext: ActionExecutorContext, effectActionId: string, method: string, params: JsonValue) {
        const requestId = crypto.randomUUID();
        const execution = createExternalActionMachineRpcExecution({ context: childContext, effectActionId,
            installationId: fixture.machine.installationId!, method, requestId, params, privateKey: fixture.keyPair.secretKey });
        if (!execution) throw new Error('reviewed_child_rpc_packet_required');
        return { execution, request: { method, requestId, params } };
    }

    return { ...fixture, root, withAccountProjection, context, headers, child, rpc, currentnessRequests, origin };
}
