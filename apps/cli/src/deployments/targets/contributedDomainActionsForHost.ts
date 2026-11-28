import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import axios from '@/api/client/credentialAxios';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1,
    isDeploymentDomainChildActionIdV1, type ActionExecutorContext, type ActionExecutorDeps, type ActionExecuteResult, type DeploymentDomainChildActionIdV1 } from '@happier-dev/protocol';
import { deploymentTargetDomainRoleForActionV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentDomainTransitionInputV1Schema, DeploymentDomainProviderObservationBodyV1Schema,
    deploymentDomainProviderObservationProofPayloadV1, type DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentTargetDomainResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { readDeploymentDomainHostnameV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { type DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { readDeploymentDomainArtifactV1 } from '@happier-dev/deployments';
import type { HostReviewedChildInvocationV1 } from '@happier-dev/protocol/actions/executor/types';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { projectDeploymentException, projectDeploymentFailure } from '../deploymentFailure';
import type { createAccountArtifactStore, ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import type { createOwnServerDomainActions, ObservedDomainReview } from './ownServer/ownServerDomainActions';
import type { createContributedDeploymentTargetForHost } from './contributedDeploymentTargetForHost';

type NativeHost = Parameters<typeof createOwnServerDomainActions>[0];
type Preparation = Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0];
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };

/** Platform placement is another consumer of the existing Domain record, reviewed child port and Artifact codec. */
export function createContributedDomainActionsForHost(host: NativeHost & Readonly<{
    target: ReturnType<typeof createContributedDeploymentTargetForHost>;
    artifacts: Pick<ReturnType<typeof createAccountArtifactStore>, 'readForUpdate'>;
}>) {
    async function settle(domain: DeploymentDomainHeaderV1, content: DeploymentDomainContentV1,
        child: HostReviewedChildInvocationV1, input: Readonly<{ serverId: string; environmentId: string; domainId: string }>,
        actionId: DeploymentDomainChildActionIdV1, context: ActionExecutorContext): Promise<ActionExecuteResult> {
        if (!context.hostReviewedChild || !domain.providerPlacement) return refuse('action_forbidden');
        const result = await context.hostReviewedChild.invoke(child);
        if (!result.ok) return result;
        const observation = DeploymentTargetDomainResultV1ProtocolSchema.parse(result.result);
        const reviewed = isRecord(child.input) && isRecord(child.input.domain) && child.input.domain.providerAssigned === true
            && typeof child.input.domain.hostname === 'string' ? child.input.domain.hostname : undefined;
        const hostname = content.hostname ?? reviewed ?? readDeploymentDomainHostnameV1(observation.hostname);
        if (!hostname || hostname !== observation.hostname || (content.hostname === null && observation.state === 'removed'))
            return refuse(content.hostname === null ? 'outcome_unknown' : 'target_mismatch');
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity || domain.providerPlacement.controller.machineId !== host.machineId
            || domain.providerPlacement.controller.installationId !== identity.installationId) return refuse('installation_mismatch');
        const changed = content.hostname === null || !sameStrictJsonValue(normalizeStrictJsonValue(content.providerObservation ?? null), normalizeStrictJsonValue(observation));
        const authorizationHeaders: ArtifactRequestAuthorizationHeaders = async request => ({ ...await host.headers(context, actionId, request) });
        const resource = changed ? await host.artifacts.readForUpdate(domain.contentArtifactId, {
            signal: context.signal, prepareRecipients: false, includeSharedAudience: false, authorizationHeaders }) : null;
        if (changed && !resource) return refuse('deployment_content_unavailable');
        const prepared = resource ? await resource.prepareJsonUpdate({ header: resource.artifact.header,
            body: JSON.stringify({ ...content, hostname, providerObservation: observation }), beforeWrite: () => context.signal?.throwIfAborted() }) : null;
        if (prepared && !prepared.ok) return refuse(prepared.errorCode);
        const body = DeploymentDomainProviderObservationBodyV1Schema.parse({ placement: domain.providerPlacement,
            state: observation.state === 'pending' ? 'warning' : observation.state,
            ...(prepared?.ok ? { contentUpdate: { body: prepared.mutation.body,
                expectedBodyVersion: prepared.mutation.expectedBodyVersion, expectedHeaderVersion: prepared.mutation.expectedHeaderVersion,
                ...(prepared.mutation.kind === undefined ? {} : { kind: prepared.mutation.kind }),
                ...(prepared.mutation.provenance === undefined ? {} : { provenance: prepared.mutation.provenance }),
                ...(prepared.mutation.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: prepared.mutation.provenanceDataEncryptionKey }) } } : {}) });
        const wire = DeploymentDomainTransitionInputV1Schema.parse({ serverId: input.serverId, environmentId: input.environmentId,
            domainId: input.domainId, expectedDomainRevision: domain.revision, observations: [], providerObservation: { ...body,
                proof: signMachineInstallationProof({ payload: deploymentDomainProviderObservationProofPayloadV1({
                    expectedDomainRevision: domain.revision, observation: body }), privateKey: identity.privateKey }) } });
        const path = `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/domains/${encodeURIComponent(input.domainId)}/transitions`;
        const headers = await host.headers(context, actionId, { method: 'POST', path, body: wire });
        if (prepared?.ok) await prepared.assertCurrent();
        context.signal?.throwIfAborted();
        const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
            headers, data: wire, ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
        const settled = DeploymentActionOutputSchemasV1[actionId].parse(response.data);
        if (settled.ok && prepared?.ok) await prepared.afterCommit();
        return { ok: true, result: settled };
    }
    async function retire(request: Readonly<{ domain: DeploymentDomainHeaderV1; content: DeploymentDomainContentV1;
        context: ActionExecutorContext }>): Promise<Awaited<ReturnType<NativeHost['storage']>>> {
        const { domain, content, context } = request;
        const child = context.hostReviewedChild?.preparedChildren?.find(child => child.role === 'domains.remove'
            && isRecord(child.input) && child.input.domainId === domain.id);
        if (!child) return projectDeploymentFailure('action_forbidden');
        try {
            const result = await settle(domain, content, child, { serverId: host.serverId,
                environmentId: domain.environmentId, domainId: domain.id }, 'deployments.domains.remove', context);
            return result.ok ? DeploymentActionOutputSchemasV1['deployments.domains.remove'].parse(result.result) : result;
        } catch (error) { return projectDeploymentFailure(context.signal?.aborted ? 'cancelled'
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'outcome_unknown', error); }
    }
    async function prepare(request: Preparation,
        prepareNative?: (observed: ObservedDomainReview) => ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>,
    ): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
        if (!isDeploymentDomainChildActionIdV1(request.actionId)) return null;
        const actionId = request.actionId;
        const role = deploymentTargetDomainRoleForActionV1(actionId);
        if (!role) return null;
        const input = DeploymentActionInputSchemasV1[actionId].parse(request.input);
        if ('mode' in input) return null;
        const add = 'targetLinkId' in input ? input : undefined;
        const assignedHostname = 'assignedHostname' in input ? input.assignedHostname : undefined;
        let retained: DeploymentDomainHeaderV1 | undefined;
        if (!add) {
            const read = await host.storage('deployments.domains.get', { serverId: input.serverId,
                environmentId: input.environmentId, domainId: input.domainId }, request.context);
            if ('ok' in read && !read.ok && 'errorCode' in read) return read;
            const parsed = DeploymentActionOutputSchemasV1['deployments.domains.get'].parse(read);
            if (!parsed.ok) return projectDeploymentFailure(parsed.error);
            retained = parsed.domain;
        }
        const targetLinkId = add?.targetLinkId ?? retained?.targetLinkId ?? refuse('target_mismatch');
        const environment = await host.readEnvironment({ environmentId: input.environmentId,
            targetLinkId, targetLinkScope: 'selected', context: request.context });
        const link = environment.targetLinks.find(row => row.targetLink.id === targetLinkId)?.targetLink;
        if (!link) return refuse('target_mismatch');
        if (link.source.kind !== 'plugin') {
            if (assignedHostname !== undefined) return refuse('target_mismatch');
            return prepareNative?.({ input, environment, ...(retained ? { domain: retained } : {}) }) ?? null;
        }
        const opened = add && 'content' in add ? { ok: true as const, content: add.content }
            : readDeploymentDomainArtifactV1(add && 'contentArtifactId' in add ? add : retained!,
                await host.open(add && 'contentArtifactId' in add ? add.contentArtifactId : retained!.contentArtifactId, request.context));
        if (!opened.ok) return projectDeploymentFailure(opened.error, opened);
        const content = opened.content;
        if (content.target.kind !== 'provider') return refuse('target_mismatch');
        const target = content.target;
        return host.target.withTargetRole({ environmentId: input.environmentId, targetLinkId, context: request.context }, environment, role, async scope => {
            const recoveryHostname = assignedHostname === undefined ? undefined : readDeploymentDomainHostnameV1(assignedHostname);
            if (recoveryHostname !== undefined && (recoveryHostname === null || content.hostname !== null || !scope.generatedDomains))
                return refuse('target_mismatch');
            if (content.hostname === null && !recoveryHostname && (role !== 'domains.add' || !scope.generatedDomains || !add || !('content' in add)))
                return refuse('deployment_unavailable');
            const childInput = { ...scope.common, domainId: input.domainId, domain: { hostname: recoveryHostname ?? content.hostname,
                ...(recoveryHostname ? { providerAssigned: true } : {}), ...(target.zone ? { zone: target.zone } : {}) } };
            await scope.admit(childInput, 'execution');
            return { children: [{ action: scope.action, role, input: normalizeStrictJsonValue(childInput) }],
                ...(role === 'domains.remove' && childInput.domain.hostname ? {
                    approvalPreview: { deploymentReview: { removal: { subject: { kind: 'domain', hostname: childInput.domain.hostname },
                        environment: environment.content.name } } },
                } : {}) };
        });
    }
    async function execute(actionId: string, raw: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult | null> {
        if (!isDeploymentDomainChildActionIdV1(actionId)) return null;
        const role = deploymentTargetDomainRoleForActionV1(actionId);
        const input = DeploymentActionInputSchemasV1[actionId].parse(raw);
        if ('mode' in input) return null;
        const child = context.hostReviewedChild?.preparedChildren?.find(child => child.role === role
            && isRecord(child.input) && child.input.domainId === input.domainId);
        if (!child) return null;
        let effectStarted = false;
        try {
            const add = 'targetLinkId' in input ? input : undefined;
            let retained: DeploymentDomainHeaderV1 | undefined;
            let retainedResult: Awaited<ReturnType<NativeHost['storage']>> | undefined;
            if (!add) {
                const read = await host.storage('deployments.domains.get', { serverId: input.serverId,
                    environmentId: input.environmentId, domainId: input.domainId }, context);
                if ('ok' in read && !read.ok && 'errorCode' in read) return read;
                const loaded = DeploymentActionOutputSchemasV1['deployments.domains.get'].parse(read);
                if (!loaded.ok) return projectDeploymentFailure(loaded.error);
                retained = loaded.domain;
                retainedResult = read;
            }
            const opened = add && 'content' in add ? { ok: true as const, content: add.content }
                : readDeploymentDomainArtifactV1(add && 'contentArtifactId' in add ? add : retained!,
                    await host.open(add && 'contentArtifactId' in add ? add.contentArtifactId : retained!.contentArtifactId, context));
            if (!opened.ok) return projectDeploymentFailure(opened.error, opened);
            const content = opened.content;
            let accepted: Awaited<ReturnType<NativeHost['storage']>>;
            if (actionId === 'deployments.domains.verify') {
                if (!('expectedDomainRevision' in input) || retained?.revision !== input.expectedDomainRevision) return refuse('deployment_conflict');
                accepted = retainedResult!;
            } else {
                const prepared = add && 'content' in add ? await (async () => {
                    const { content: _content, ...metadata } = add;
                    const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
                    return { ...metadata, ...await host.createContent(content, environment.environment.owner, context) };
                })() : input;
                accepted = await host.storage(actionId, { ...prepared, ...(add ? { provider: true, placements: [] } : {}) }, context);
            }
            if ('ok' in accepted && !accepted.ok && 'errorCode' in accepted) return accepted;
            const loaded = DeploymentActionOutputSchemasV1['deployments.domains.add'].parse(accepted);
            if (!loaded.ok) return projectDeploymentFailure(loaded.error);
            if (loaded.domain.deletedAtMs !== undefined) return { ok: true, result: loaded };
            effectStarted = actionId !== 'deployments.domains.verify';
            return await settle(loaded.domain, content, child, input, actionId, context);
        } catch (error) {
            if (effectStarted && !context.signal?.aborted
                && !(error instanceof Error && 'code' in error && typeof error.code === 'string')) {
                return projectDeploymentFailure('outcome_unknown', error);
            }
            return projectDeploymentException(error, { signal: context.signal });
        }
    }
    return Object.assign(prepare, { retire, execute });
}
