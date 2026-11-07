import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import {
    DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentDomainDiscoverChildRpcV1Schema,
    isDeploymentDomainChildActionIdV1, isDeploymentDomainAddActionIdV1, isDeploymentDomainRemoveActionIdV1,
    type DeploymentDomainChildActionIdV1, type DeploymentTeardownInputV1,
    type ActionExecutorContext, type ActionExecutorDeps, type DeploymentDomainChildRpcV1, type DeploymentDomainDiscoverChildRpcV1,
} from '@happier-dev/protocol';
import {
    DeploymentDomainObservationV1Schema, DeploymentDomainTransitionInputV1Schema,
    DeploymentDomainMachineTopologyV1Schema, type DeploymentDomainHeaderV1, type DeploymentDomainTopologyV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveDomainIngress, selectDomainCaddyPlacements } from './domainRouteSelection';
import { DeploymentDomainPreparedContentInputV1Schema, type DeploymentDomainPlacementV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { readDeploymentDomainArtifactV1, type DeploymentDomainContentV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import type { StoredCredentials } from '@/persistence';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ArtifactRequestAuthorizationHeaders, createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareCloudflareDomainForHost, disableCloudflareDomainForHost, cloudflareDomainConnectorForTarget } from './cloudflareDomainPreparation';
import { ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { isRecord } from '@happier-dev/protocol/common/records';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

type DomainAction = DeploymentDomainChildActionIdV1;
// The Domain mode owner presents native setup decisions without reading or
// deciding Machine administrator/network policy a second time.
type DomainNativeFailureScope = Readonly<{ environmentId: string; domainId: string; step: 'native_execution' }>;
const failure = (reason: string, details?: unknown, failureCause?: unknown, effectAttempted?: unknown, nativeScope?: DomainNativeFailureScope) => {
    const errorCode = reason === 'mode_none' || reason === 'not_preauthorized' ? 'machine_admin_access_required'
        : reason === 'machine_reachability_posture_unavailable' ? 'machine_network_review_required' : reason;
    const parsedCause = ActionFailureCauseV1Schema.safeParse(failureCause);
    const scoped = nativeScope && (!isRecord(details) || typeof details.step !== 'string')
        ? { ...(isRecord(details) ? details : {}), ...nativeScope } : details;
    const recovery = isRecord(scoped) && scoped.step === 'native_execution'
        ? projectDeploymentFailureRecoveryV1(scoped) : scoped;
    return { ok: false as const, errorCode, error: errorCode, ...(recovery === undefined ? {} : { details: recovery }),
        ...(typeof effectAttempted === 'boolean' ? { effectAttempted } : {}),
        ...(parsedCause.success ? { failureCause: parsedCause.data } : {}) };
};

type DomainDiscoveryHost = Readonly<{
    dispatch(job: DeploymentDomainDiscoverChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
    readEnvironment: OwnServerDeploymentTargetHostInput['readEnvironment'];
    readInstallation(machineId: string, context: ActionExecutorContext): Promise<string>;
}>;

/** Add and recovery Remove consume the same native observation and origin selection. */
async function discoverOwnServerDomainPlacement(request: Readonly<{
    actionId: 'deployments.domains.add' | 'deployments.domains.remove'; input: DeploymentDomainDiscoverChildRpcV1['input'];
    environment: Awaited<ReturnType<DomainDiscoveryHost['readEnvironment']>>;
    content: DeploymentDomainContentV1;
    targetLinkId: string; context: ActionExecutorContext;
}>, host: DomainDiscoveryHost) {
    const { environment, context } = request;
    const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
    if (!link) return failure('target_mismatch');
    const resolved = resolveDomainIngress(request.content, environment.content.ingress);
    if (resolved.status === 'unavailable') return failure(resolved.reason, resolved.details);
    const ingress = resolved.ingress;
    const destinations = link.members.filter(member => member.state === 'active').map(member => ({
        machineId: member.machineId, installationId: member.installationId }));
    if (ingress?.kind === 'edgeCaddy' && !destinations.some(member => member.machineId === ingress.edgeMachineId)) {
        destinations.push({ machineId: ingress.edgeMachineId,
            installationId: await host.readInstallation(ingress.edgeMachineId, context) });
    }
    const machines: DeploymentDomainTopologyV1['machines'] = [];
    for (const destination of destinations) {
        const nativeScope = { environmentId: environment.environment.id, domainId: request.input.domainId,
            step: 'native_execution' as const };
        let observed: unknown;
        try {
            observed = await host.dispatch(DeploymentDomainDiscoverChildRpcV1Schema.parse({ v: 1,
                kind: 'domainDiscover', actionId: request.actionId, input: request.input, ...destination }), context);
        } catch (error) {
            const diagnostic = projectDeploymentFailure(context.signal?.aborted ? 'cancelled'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'native_route_unavailable',
                error, 'deployment.domain.native_execution');
            return { ...failure(diagnostic.errorCode, (error instanceof Error && 'details' in error ? error.details : undefined)
                ?? diagnostic.details,
                diagnostic.failureCause, diagnostic.effectAttempted, nativeScope), error: diagnostic.error };
        }
        if (observed && typeof observed === 'object' && 'errorCode' in observed && typeof observed.errorCode === 'string')
            return failure(observed.errorCode, 'details' in observed ? observed.details : {
                environmentId: request.environment.environment.id, domainId: request.input.domainId,
                step: 'native_execution' },
                'failureCause' in observed ? observed.failureCause : undefined,
                'effectAttempted' in observed ? observed.effectAttempted : undefined, nativeScope);
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
    const topology: DeploymentDomainTopologyV1 = { members: link.members.filter(member => member.state === 'active').map(member => ({
        machineId: member.machineId, installationId: member.installationId })), machines,
        ...(selected.tunnelOrigin ? { tunnelOrigin: selected.tunnelOrigin } : {}) };
    return { ok: true as const, placements: selected.placements, topology };
}

/** The Environment Domain owner supplies its complete live set through its existing pages. */
async function* readEnvironmentDomainsForHost(environmentId: string, context: ActionExecutorContext,
    host: Readonly<{ serverId: string; storage: NonNullable<ActionExecutorDeps['deploymentAction']> }>) {
    let cursor: string | undefined;
    for (;;) {
        const result = await host.storage('deployments.domains.list', { serverId: host.serverId,
            environmentId, ...(cursor ? { cursor } : {}) }, context);
        if ('errorCode' in result) throw Object.assign(new Error(result.error), { code: result.errorCode, cause: result });
        const page = DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(result);
        if (!page.ok) throw Object.assign(new Error(page.error), { code: page.error, cause: page });
        for (const domain of page.domains) if (domain.deletedAtMs === undefined) yield domain;
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
    }
}

/** Teardown reviews vendor effects as children of its existing single approval. */
export async function prepareOwnServerTeardownDomainReviewedChildren(
    request: Omit<Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0], 'input'>
        & Readonly<{ input: DeploymentTeardownInputV1 }>,
    host: DomainDiscoveryHost & Readonly<{ serverId: string; storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
        open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null> }>,
): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
    const input = request.input;
    const children: HostReviewedChildrenPlanV1['children'][number][] = [];
    for await (const domain of readEnvironmentDomainsForHost(input.environmentId, request.context, host)) {
        const plan = await prepareOwnServerDomainReviewedChildren({ ...request, actionId: 'deployments.domains.remove',
            input: { serverId: input.serverId, environmentId: input.environmentId, domainId: domain.id,
                expectedDomainRevision: domain.revision, expectedRevision: input.expectedRevision, requestKey: input.requestKey } }, host);
        if (plan && 'errorCode' in plan) return plan;
        if (plan) children.push(...plan.children);
    }
    return children.length ? { children } : null;
}

/** Review concrete recovery operands before admission; retain them in the existing child port. */
export async function prepareOwnServerDomainReviewedChildren(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    host: DomainDiscoveryHost & Readonly<{ storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
        open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null> }>,
): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
    const actionId = request.actionId;
    if (!isDeploymentDomainAddActionIdV1(actionId) && !isDeploymentDomainRemoveActionIdV1(actionId)) return null;
    const input = DeploymentActionInputSchemasV1[actionId].parse(request.input);
    let content: DeploymentDomainContentV1;
    let domain: DeploymentDomainHeaderV1 | undefined;
    const add = isDeploymentDomainAddActionIdV1(actionId) ? DeploymentActionInputSchemasV1[actionId].parse(input) : undefined;
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
            domain = parsed.domain;
        }
        const opened = readDeploymentDomainArtifactV1(reference, await host.open(reference.contentArtifactId, request.context));
        if (!opened.ok) return failure(opened.error);
        content = opened.content;
    }
    const environment = add
        ? await host.readEnvironment({ environmentId: input.environmentId, context: request.context }) : undefined;
    const resolved = resolveDomainIngress(content, environment?.content.ingress, add !== undefined);
    if (resolved.status === 'unavailable') return failure(resolved.reason, resolved.details);
    const selected = resolved.selection;
    if (!selected) return null;
    const purpose = selected.selection.credentialRefs.find(item => item.purpose === 'tunnel.manage');
    if (purpose?.credentialRef.kind !== 'connectedAccount') return failure('connected_account_required');
    const { accountId, zoneId, tunnel } = selected.controller;
    const prepared = content.cloudflarePreparation;
    if (isDeploymentDomainRemoveActionIdV1(actionId) && !prepared) {
        if (!domain) return failure('deployment_content_unavailable');
        const environment = await host.readEnvironment({ environmentId: input.environmentId, context: request.context });
        const link = environment.targetLinks.find(item => item.targetLink.id === domain.targetLinkId)?.targetLink;
        if (!link) return failure('target_mismatch');
        const discovered = await discoverOwnServerDomainPlacement({ actionId,
            input: { ...DeploymentActionInputSchemasV1[actionId].parse(input),
                contentArtifactId: domain.contentArtifactId, contentHeaderVersion: domain.contentHeaderVersion,
                contentBodyVersion: domain.contentBodyVersion, targetLinkId: link.id, expectedTargetLinkRevision: link.revision },
            environment, content, targetLinkId: link.id, context: request.context }, host);
        if (!discovered.ok) return discovered;
        const origin = discovered.topology.tunnelOrigin;
        if (!origin) return failure('required_fact_unavailable', { requiredFact: 'cloudflare_tunnel_origin' });
        return { children: [{ action: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare-named/disable' }, role: 'disable',
            input: { credentialRef: purpose.credentialRef.account, accountId, zoneId, tunnelName: tunnel.name,
                owned: [{ hostname: content.hostname, ...(content.target.path ? { path: content.target.path } : {}),
                    expectedService: origin.service }], dnsOwnership: [] } }] };
    }
    const role = isDeploymentDomainAddActionIdV1(actionId) ? 'configure' : 'disable';
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
    artifacts: Pick<ReturnType<typeof createAccountArtifactStore>, 'readForUpdate'>;
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
            const prepared = await resource.prepareJsonUpdate({ header: resource.artifact.header, body: JSON.stringify(content),
                beforeWrite: () => context.signal?.throwIfAborted() });
            if (!prepared.ok) return refuse(prepared.errorCode);
            // Only the body advances: retained predecessors still pin the original readable header.
            const body = DeploymentDomainPreparedContentInputV1Schema.parse({ serverId: host.serverId,
                environmentId: domain.environmentId, domainId: domain.id, expectedDomainRevision: domain.revision,
                actionOperationId: capture.placement.actionOperationId, capture,
                contentUpdate: { body: prepared.mutation.body, expectedBodyVersion: prepared.mutation.expectedBodyVersion,
                    expectedHeaderVersion: prepared.mutation.expectedHeaderVersion,
                    ...(prepared.mutation.provenance === undefined ? {} : { provenance: prepared.mutation.provenance }),
                    ...(prepared.mutation.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: prepared.mutation.provenanceDataEncryptionKey }),
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
}>) {
    type Execute = NonNullable<ActionExecutorDeps['deploymentAction']>;
    const execute = async (actionId: Parameters<Execute>[0], raw: Parameters<Execute>[1], context: ActionExecutorContext,
        admitted?: Readonly<{ domain: DeploymentDomainHeaderV1; content: DeploymentDomainContentV1 }>):
        Promise<Awaited<ReturnType<Execute>>> => {
        if (!isDeploymentDomainChildActionIdV1(actionId)) return failure('unsupported_action');
        let issued = false;
        let nativeScope: DomainNativeFailureScope | undefined;
        try {
            let input = DeploymentActionInputSchemasV1[actionId].parse(raw);
            let topology: DeploymentDomainTopologyV1 | undefined;
            if (isDeploymentDomainAddActionIdV1(actionId)) {
                if (!context.externalActionExecutionAuthorization || !context.originalActionEnvelope) return failure('action_forbidden');
                const original = DeploymentActionInputSchemasV1[actionId].parse(input);
                const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
                const link = environment.targetLinks.find(item => item.targetLink.id === original.targetLinkId)?.targetLink;
                if (!link) return failure('target_mismatch');
                const preparedInput = 'content' in original ? await (async () => {
                    const { content, ...metadata } = original;
                    return { ...metadata, ...await host.createContent(content, environment.environment.owner, context) };
                })() : original;
                const opened = 'content' in original ? { ok: true as const, content: original.content }
                    : readDeploymentDomainArtifactV1(preparedInput, await host.open(preparedInput.contentArtifactId, context));
                if (!opened.ok) return failure(opened.error);
                const discovered = await discoverOwnServerDomainPlacement({ actionId, input: preparedInput,
                    environment, content: opened.content, targetLinkId: original.targetLinkId, context }, host);
                if (!discovered.ok) return discovered;
                if (original.placements && !isDeepStrictEqual(original.placements, discovered.placements)) return failure('target_mismatch');
                input = { ...preparedInput, placements: [...discovered.placements] };
                topology = discovered.topology;
            }
            let domain: DeploymentDomainHeaderV1;
            if (admitted) domain = admitted.domain;
            else {
                const accepted = actionId === 'deployments.domains.verify'
                    ? await host.storage('deployments.domains.get', {
                        serverId: input.serverId, environmentId: input.environmentId, domainId: input.domainId,
                    }, context) : await host.storage(actionId, input, context);
                if ('errorCode' in accepted || !('ok' in accepted) || !accepted.ok) return accepted;
                const loaded = DeploymentActionOutputSchemasV1['deployments.domains.add'].parse(accepted);
                if (!loaded.ok) return loaded;
                domain = loaded.domain;
                if (isDeploymentDomainAddActionIdV1(actionId) && domain.state === 'active'
                    || domain.deletedAtMs !== undefined) return loaded;
            }
            if (actionId === 'deployments.domains.verify' && domain.revision !== input.expectedDomainRevision)
                return failure('deployment_conflict');
            let captures = domain.placements ?? [];
            if (!captures.length) return failure('native_route_unavailable');
            const actionOperationId = context.operationAcceptance?.operationId;
            if (actionId !== 'deployments.domains.verify' && !actionOperationId) return failure('operation_unavailable');
            nativeScope = { environmentId: input.environmentId, domainId: input.domainId, step: 'native_execution' };
            let privateContent: DeploymentDomainContentV1 | undefined = admitted?.content;
            if (isDeploymentDomainAddActionIdV1(actionId) && topology?.tunnelOrigin) {
                domain = await prepareCloudflareDomainForHost({ domain, topology, context, host });
                captures = domain.placements ?? [];
                const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                if (!opened.ok) return failure(opened.error);
                privateContent = opened.content;
            } else if (actionId === 'deployments.domains.verify' || isDeploymentDomainRemoveActionIdV1(actionId)) {
                if (!privateContent) {
                    const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                    if (!opened.ok) return failure(opened.error);
                    privateContent = opened.content;
                }
                if (isDeploymentDomainRemoveActionIdV1(actionId)) await disableCloudflareDomainForHost(privateContent, context);
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
                    return failure(result.errorCode, 'details' in result ? result.details : nativeScope,
                        'failureCause' in result ? result.failureCause : undefined,
                        'effectAttempted' in result ? result.effectAttempted : undefined, nativeScope);
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
            return settled.success ? settled.data : failure('outcome_unknown', nativeScope);
        } catch (error) {
            const diagnostic = projectDeploymentFailure(issued ? 'outcome_unknown' : context.signal?.aborted ? 'cancelled'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'native_route_unavailable',
                error, 'deployment.domain.native_execution');
            return { ...failure(diagnostic.errorCode, !issued ? (error instanceof Error && 'details' in error ? error.details : undefined)
                ?? diagnostic.details ?? nativeScope : nativeScope,
                diagnostic.failureCause, diagnostic.effectAttempted, nativeScope), error: diagnostic.error };
        }
    };
    return Object.assign((...args: Parameters<Execute>) => execute(args[0], args[1], args[2]), {
        async retireEnvironment(input: Pick<DeploymentTeardownInputV1, 'environmentId' | 'expectedRevision' | 'requestKey'>,
            context: ActionExecutorContext): Promise<ActionExecuteFailure | null> {
            const { environmentId, expectedRevision, requestKey } = input;
            for await (const domain of readEnvironmentDomainsForHost(environmentId, context, host)) {
                let hostname: string | undefined;
                let result: Awaited<ReturnType<Execute>>;
                try {
                    context.signal?.throwIfAborted();
                    const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                    if (!opened.ok) result = failure(opened.error);
                    else {
                        hostname = opened.content.hostname;
                        result = await execute('deployments.domains.remove', { serverId: host.serverId,
                            environmentId, domainId: domain.id, expectedDomainRevision: domain.revision, expectedRevision, requestKey }, context,
                            { domain, content: opened.content });
                    }
                } catch (error) {
                    result = projectDeploymentFailure(context.signal?.aborted ? 'cancelled' : 'native_route_unavailable', error,
                        'deployment.teardown.removeDomain');
                }
                if (result.ok) continue;
                const diagnostic = 'errorCode' in result ? result : failure(result.error);
                const recovery = projectDeploymentFailureRecoveryV1(isRecord(diagnostic.details) ? diagnostic.details : {});
                return { ...diagnostic, details: { environmentId, domainId: domain.id,
                    ...(hostname ? { domainHostname: hostname } : {}), step: 'removeDomain', partial: true,
                    requiredFact: recovery.requiredFact, remedy: recovery.remedy } };
            }
            return null;
        },
    });
}
