import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, isDeploymentDomainChildActionIdV1, type DeploymentDomainChildActionIdV1, type ActionExecutorContext, type ActionExecutorDeps, type DeploymentDomainChildRpcV1, type DeploymentDomainDiscoverChildRpcV1 } from '@happier-dev/protocol';
import { DeploymentDomainObservationV1Schema, DeploymentDomainTransitionInputV1Schema, DeploymentDomainMachineTopologyV1Schema, type DeploymentDomainHeaderV1, type DeploymentDomainTopologyV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { selectDomainCaddyPlacements } from './domainRouteSelection';
import { DeploymentDomainPreparedContentInputV1Schema, type DeploymentDomainPlacementV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { readDeploymentDomainArtifactV1, type DeploymentDomainContentV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import { readCloudflareNamedControllerSelection } from '@happier-dev/cli-common/relayAccess';
import type { StoredCredentials } from '@/persistence';
import type { ArtifactRequestAuthorizationHeaders, createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareCloudflareDomainForHost, disableCloudflareDomainForHost, cloudflareDomainConnectorForTarget } from './cloudflareDomainPreparation';

import { ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';

type DomainAction = DeploymentDomainChildActionIdV1;
const failure = (reason: string, details?: unknown, failureCause?: unknown) => {
    const errorCode = reason === 'mode_none' ? 'machine_admin_access_required' : reason;
    const parsedCause = ActionFailureCauseV1Schema.safeParse(failureCause);
    return { ok: false as const, errorCode, error: errorCode, ...(details === undefined ? {} : { details }),
        ...(parsedCause.success ? { failureCause: parsedCause.data } : {}) };
};

/** Review the Account role before admission; native topology supplies its concrete origin later. */
export async function prepareOwnServerDomainReviewedChildren(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    host: Readonly<{ storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
        open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null> }>,
): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
    const actionId = request.actionId;
    if (actionId !== 'deployments.domains.add' && actionId !== 'deployments.domains.remove') return null;
    const input = DeploymentActionInputSchemasV1[actionId].parse(request.input);
    let content: DeploymentDomainContentV1;
    const add = actionId === 'deployments.domains.add' ? DeploymentActionInputSchemasV1[actionId].parse(input) : undefined;
    if (add && 'content' in add) content = add.content;
    else {
        let reference: { contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number };
        if (add && 'contentArtifactId' in add) reference = add;
        else {
            const loaded = await host.storage('deployments.domains.get', { serverId: input.serverId,
                environmentId: input.environmentId, domainId: input.domainId }, request.context);
            if ('errorCode' in loaded) return loaded;
            const parsed = DeploymentActionOutputSchemasV1['deployments.domains.get'].parse(loaded);
            if (!parsed.ok) return failure(parsed.error);
            reference = parsed.domain;
        }
        const opened = readDeploymentDomainArtifactV1(reference, await host.open(reference.contentArtifactId, request.context));
        if (!opened.ok) return failure(opened.error);
        content = opened.content;
    }
    const selected = readCloudflareNamedControllerSelection(content.ingress);
    if (!selected) return null;
    const purpose = selected.selection.credentialRefs.find(item => item.purpose === 'tunnel.manage');
    if (purpose?.credentialRef.kind !== 'connectedAccount') return failure('connected_account_required');
    const { accountId, zoneId, tunnel } = selected.controller;
    const prepared = content.cloudflarePreparation;
    if (actionId === 'deployments.domains.remove' && !prepared) return failure('required_fact_unavailable');
    const role = actionId === 'deployments.domains.add' ? 'configure' : 'disable';
    return { children: [{ action: { pluginId: 'happier.deploy.cloudflare', localId: `cloudflare-named/${role}` }, role,
        scopeInput: { credentialRef: purpose.credentialRef.account, accountId, zoneId,
            owned: prepared?.owned ?? selected.controller.owned,
            dnsOwnership: prepared?.dnsOwnership ?? selected.controller.dnsOwnership,
            ...(role === 'disable' && prepared ? { tunnelId: prepared.tunnelId }
                : { tunnel: prepared ? { kind: 'adopt', tunnelId: prepared.tunnelId, name: tunnel.name } : tunnel }) } }] };
}

/** Prepare with the incumbent Artifact codec; Home commits its body and capture refs atomically. */
export function createOwnServerDomainContentWriter(host: Readonly<{
    serverId: string;
    serverHttpBaseUrl: string;
    artifacts: Pick<ReturnType<typeof createAccountArtifactStore>, 'readForUpdate' | 'prepareJsonUpdate'>;
    headers(context: ActionExecutorContext, actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>): Promise<Readonly<Record<string, string>>>;
}>) {
    return (input: Readonly<{ domain: DeploymentDomainHeaderV1; capture: DeploymentDomainPlacementV1;
        content: DeploymentDomainContentV1; context: ActionExecutorContext }>): Promise<DeploymentDomainHeaderV1> =>
        runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => {
            const { domain, capture, content, context } = input;
            const actionId = 'deployments.domains.add';
            const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
            const authorizationHeaders: ArtifactRequestAuthorizationHeaders = async request =>
                ({ ...await host.headers(context, actionId, request) });
            const resource = await host.artifacts.readForUpdate(domain.contentArtifactId, { signal: context.signal,
                prepareRecipients: false, includeSharedAudience: false, authorizationHeaders });
            const opened = readDeploymentDomainArtifactV1(domain, resource?.artifact ?? null);
            if (!opened.ok) return refuse(opened.error);
            if (!resource) return refuse('deployment_content_unavailable');
            const prepared = await host.artifacts.prepareJsonUpdate({ artifactId: domain.contentArtifactId,
                expectedRevision: resource.artifact.revision, header: resource.artifact.header, body: JSON.stringify(content),
                signal: context.signal, beforeWrite: () => context.signal?.throwIfAborted(), authorizationHeaders });
            if (!prepared.ok) return refuse(prepared.errorCode);
            // Only the body advances: retained predecessors still pin the original readable header.
            const body = DeploymentDomainPreparedContentInputV1Schema.parse({ serverId: host.serverId,
                environmentId: domain.environmentId, domainId: domain.id, expectedDomainRevision: domain.revision,
                actionOperationId: capture.placement.actionOperationId, capture,
                contentUpdate: { body: prepared.mutation.body, expectedBodyVersion: prepared.mutation.expectedBodyVersion,
                    expectedHeaderVersion: prepared.mutation.expectedHeaderVersion,
                    ...(prepared.mutation.kind === undefined ? {} : { kind: prepared.mutation.kind }) } });
            const path = `/v1/deployments/environments/${encodeURIComponent(domain.environmentId)}/domains/${encodeURIComponent(domain.id)}/prepared-content`;
            const headers = await host.headers(context, actionId, { method: 'POST', path, body });
            await prepared.assertCurrent();
            let response;
            try {
                response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                    headers, data: body, ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
            } catch { return refuse('outcome_unknown'); }
            const result = DeploymentActionOutputSchemasV1[actionId].safeParse(response.data);
            if (!result.success) return refuse('outcome_unknown');
            if (!result.data.ok) return refuse(result.data.error);
            await prepared.afterCommit();
            return result.data.domain;
        });
}

/** The Domain Action owns one admitted native placement set and awaits its signed result. */
export function createOwnServerDomainActions(host: Readonly<{
    serverId: string;
    machineId: string;
    credentials: StoredCredentials;
    installedCredentials?: StoredCredentials;
    serverHttpBaseUrl: string;
    storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
    dispatch(job: DeploymentDomainChildRpcV1 | DeploymentDomainDiscoverChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
    readEnvironment: OwnServerDeploymentTargetHostInput['readEnvironment'];
    readInstallation(machineId: string, context: ActionExecutorContext): Promise<string>;
    open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
    createContent(content: DeploymentDomainContentV1,
        owner: Awaited<ReturnType<OwnServerDeploymentTargetHostInput['readEnvironment']>>['environment']['owner'],
        context: ActionExecutorContext): Promise<{ contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number }>;
    persistPreparedContent: ReturnType<typeof createOwnServerDomainContentWriter>;
    headers(context: ActionExecutorContext, actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>): Promise<Readonly<Record<string, string>>>;
}>): NonNullable<ActionExecutorDeps['deploymentAction']> {
    return async (actionId, raw, context) => {
        if (!isDeploymentDomainChildActionIdV1(actionId)) return failure('unsupported_action');
        let issued = false;
        try {
            let input = DeploymentActionInputSchemasV1[actionId].parse(raw);
            let topology: DeploymentDomainTopologyV1 | undefined;
            if (actionId === 'deployments.domains.add') {
                if (!context.externalActionExecutionAuthorization || !context.originalActionEnvelope) return failure('action_forbidden');
                const original = DeploymentActionInputSchemasV1[actionId].parse(input);
                const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
                const link = environment.targetLinks.find(item => item.targetLink.id === original.targetLinkId)?.targetLink;
                if (!link) return failure('target_mismatch');
                const preparedInput = 'content' in original ? await (async () => {
                    const { content, ...metadata } = original;
                    return { ...metadata, ...await host.createContent(content, environment.environment.owner, context) };
                })() : original;
                const ingress = environment.content.ingress;
                const destinations = link.members.filter(member => member.state === 'active').map(member => ({
                    machineId: member.machineId, installationId: member.installationId }));
                if (ingress?.kind === 'edgeCaddy' && !destinations.some(member => member.machineId === ingress.edgeMachineId)) {
                    destinations.push({ machineId: ingress.edgeMachineId,
                        installationId: await host.readInstallation(ingress.edgeMachineId, context) });
                }
                const machines: DeploymentDomainTopologyV1['machines'] = [];
                for (const destination of destinations) {
                    const observed = await host.dispatch({ v: 1, kind: 'domainDiscover', actionId, input: preparedInput, ...destination }, context);
                    if (observed && typeof observed === 'object' && 'errorCode' in observed && typeof observed.errorCode === 'string')
                        return failure(observed.errorCode, 'details' in observed ? observed.details : undefined);
                    const parsed = DeploymentDomainMachineTopologyV1Schema.safeParse(observed);
                    if (!parsed.success) return failure('invalid_action_transport_output');
                    if (parsed.data.machineId !== destination.machineId || parsed.data.installationId !== destination.installationId)
                        return failure('target_mismatch');
                    machines.push(parsed.data);
                }
                const members = link.members.flatMap(member => {
                    const observed = machines.find(machine => machine.machineId === member.machineId && machine.installationId === member.installationId);
                    return observed ? [{ ...observed, state: member.state }] : [];
                });
                const edge = ingress?.kind === 'edgeCaddy' ? machines.find(machine => machine.machineId === ingress.edgeMachineId) : undefined;
                const selected = selectDomainCaddyPlacements({ ingress, members, ...(edge ? { edge } : {}) });
                if (selected.status !== 'ready') return failure(selected.reason, selected.details);
                if (original.placements && !isDeepStrictEqual(original.placements, selected.placements)) return failure('target_mismatch');
                input = { ...preparedInput, placements: [...selected.placements] };
                topology = { members: link.members.filter(member => member.state === 'active').map(member => ({
                    machineId: member.machineId, installationId: member.installationId })), machines,
                    ...(selected.tunnelOrigin ? { tunnelOrigin: selected.tunnelOrigin } : {}) };
            }
            const admitted = actionId === 'deployments.domains.verify'
                ? await host.storage('deployments.domains.get', {
                    serverId: input.serverId, environmentId: input.environmentId, domainId: input.domainId,
                }, context) : await host.storage(actionId, input, context);
            if ('errorCode' in admitted || !('ok' in admitted) || !admitted.ok) return admitted;
            const loaded = DeploymentActionOutputSchemasV1['deployments.domains.add'].parse(admitted);
            if (!loaded.ok) return loaded;
            let domain: DeploymentDomainHeaderV1 = loaded.domain;
            if (actionId === 'deployments.domains.add' && domain.state === 'active') return loaded;
            if (actionId === 'deployments.domains.verify' && domain.revision !== input.expectedDomainRevision)
                return failure('deployment_conflict');
            if (domain.deletedAtMs !== undefined) return loaded;
            let captures = domain.placements ?? [];
            if (!captures.length) return failure('native_route_unavailable');
            const actionOperationId = context.operationAcceptance?.operationId;
            if (actionId !== 'deployments.domains.verify' && !actionOperationId) return failure('operation_unavailable');
            let privateContent: DeploymentDomainContentV1 | undefined;
            if (actionId === 'deployments.domains.add' && topology?.tunnelOrigin) {
                domain = await prepareCloudflareDomainForHost({ domain, topology, context, host });
                captures = domain.placements ?? [];
                const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                if (!opened.ok) return failure(opened.error);
                privateContent = opened.content;
            } else if (actionId === 'deployments.domains.verify' || actionId === 'deployments.domains.remove') {
                const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                if (!opened.ok) return failure(opened.error);
                privateContent = opened.content;
                if (actionId === 'deployments.domains.remove') await disableCloudflareDomainForHost(privateContent, context);
            }
            // Retire a changed route before replacing the same exact native id.
            // Both effects spend the captured admission, not another Action.
            const observations = [];
            for (const capture of [...captures.filter(capture => !capture.desired), ...captures.filter(capture => capture.desired)]) {
                context.signal?.throwIfAborted();
                const cloudflareConnector = privateContent && cloudflareDomainConnectorForTarget(privateContent, capture.placement);
                const result = await host.dispatch({ v: 1, kind: 'domain', actionId,
                    input: { serverId: input.serverId, environmentId: input.environmentId, domainId: input.domainId },
                    machineId: capture.placement.machineId, installationId: capture.placement.installationId,
                    expectedDomainRevision: domain.revision, capture,
                    ...(topology ? { topology } : {}),
                    ...(actionOperationId ? { actionOperationId } : {}),
                    ...(cloudflareConnector && (capture.desired || capture.retireSharedTunnel === true) ? { cloudflareConnector } : {}),
                }, context);
                if (result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string')
                    return failure(result.errorCode, 'details' in result ? result.details : undefined);
                const observation = DeploymentDomainObservationV1Schema.safeParse(result);
                if (!observation.success) return failure('invalid_action_transport_output');
                observations.push(observation.data);
            }
            const body = DeploymentDomainTransitionInputV1Schema.parse({ serverId: input.serverId,
                environmentId: input.environmentId, domainId: input.domainId, expectedDomainRevision: domain.revision, observations });
            const path = `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/domains/${encodeURIComponent(input.domainId)}/transitions`;
            const headers = await host.headers(context, actionId satisfies DomainAction, { method: 'POST', path, body });
            context.signal?.throwIfAborted();
            issued = true;
            const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                headers, data: body, ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
            const settled = DeploymentActionOutputSchemasV1[actionId].safeParse(response.data);
            return settled.success ? settled.data : failure('outcome_unknown');
        } catch (error) {
            const diagnostic = projectDeploymentFailure(issued ? 'outcome_unknown' : context.signal?.aborted ? 'cancelled'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'native_route_unavailable',
                error, 'deployment.domain.native_execution');
            return { ...failure(diagnostic.errorCode, !issued ? diagnostic.details
                ?? (error instanceof Error && 'details' in error ? error.details : undefined) : undefined,
                diagnostic.failureCause), error: diagnostic.error };
        }
    };
}
