import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { deriveApprovalRequestSourceIdFromIdentityV1 } from '@happier-dev/protocol/approvals/creation';
import { deriveAccountScopedArtifactIdV1 } from '@happier-dev/protocol/artifacts/idScope';

/** An Action may create and settle its own Ask, without general Artifact authority. */
export function isExternalActionApprovalArtifactPurpose(input: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1; effectActionId: string;
    method: string; path: string; body: unknown;
}>): boolean {
    const { binding } = input;
    if (input.effectActionId !== binding.actionId) return false;
    const sourceId = deriveApprovalRequestSourceIdFromIdentityV1({
        homeId: binding.serverIdentityId, accountId: binding.accountId,
        requesterId: 'principalId' in binding ? binding.principalId : binding.accountId,
        requestId: binding.requestId, actionId: binding.actionId, target: binding.target,
    });
    const artifactId = deriveAccountScopedArtifactIdV1(binding.accountId, sourceId);
    const method = input.method.toUpperCase();
    if (method === 'GET' && input.body === undefined)
        return input.path === `/v1/artifacts/${artifactId}` || input.path === `/v1/artifacts/${sourceId}`;
    if (method !== 'POST' || !input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return false;
    if (input.path === `/v1/artifacts/${artifactId}` || input.path === `/v1/artifacts/${sourceId}`) return true;
    const body = input.body as Readonly<Record<string, unknown>>;
    return input.path === '/v1/artifacts' && body.id === artifactId;
}
