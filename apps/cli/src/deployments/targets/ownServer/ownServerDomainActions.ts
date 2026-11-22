import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import { withDeploymentDomainHealthCheckDefaultV1 } from '@happier-dev/protocol/deployments/deploymentDomainHealthCheckV1';
import { previewOwnServerDomainDns } from './ownServerDomainDnsPreview';
import { deploymentOutputValidationFailure } from '../../outputValidation';
import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import {
    DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentDomainDiscoverChildRpcV1Schema,
    isDeploymentDomainChildActionIdV1, isDeploymentDomainAddActionIdV1, isDeploymentDomainRemoveActionIdV1,
    selectDeploymentTeardownDomainScopeV1,
    type DeploymentDomainChildActionIdV1, type DeploymentTeardownInputV1,
    type ActionExecutorContext, type ActionExecutorDeps, type DeploymentDomainChildRpcV1, type DeploymentDomainDiscoverChildRpcV1, type DeploymentDomainDnsChildRpcV1,
} from '@happier-dev/protocol';
import {
    DeploymentDomainObservationV1Schema, DeploymentDomainTransitionInputV1Schema,
    DeploymentDomainMachineTopologyV1Schema, type DeploymentDomainHeaderV1, type DeploymentDomainTopologyV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDomainReviewChildRpcV1Schema, type DeploymentDomainReviewChildRpcV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveDomainIngress, selectDomainCaddyPlacements, readDomainIngressMembersForHost, selectDomainMembershipMachines } from './domainRouteSelection';
import { DEFAULT_CLOUDFLARE_TUNNEL_CONNECTORS_PER_MACHINE } from '@happier-dev/protocol/deployments/cloudflareTunnelConnectorsV1';
import { DeploymentDomainNativeSetupObservationV1Schema, DeploymentDomainPreparedContentInputV1Schema,
    type DeploymentDomainNativeSetupReviewV1, type DeploymentDomainPlacementV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { getDeploymentTargetLinkLineageV1, type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { type DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { readDeploymentDomainArtifactV1, readDeploymentEnvironmentArtifactV1,
    type DeploymentArtifactDocumentV1 } from '@happier-dev/deployments';
import type { StoredCredentials } from '@/persistence';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { HostReviewedChildrenDomainPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { readHostReviewedChildOriginalAuthorizationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ArtifactRequestAuthorizationHeaders, createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareCloudflareDomainForHost, disableCloudflareDomainForHost, cloudflareDomainConnectorForTarget,
    readCloudflareDomainAccount, resolveCloudflareDomainTunnelOwnership } from './cloudflareDomainPreparation';
import { createActionExecuteFailureError, isActionExecuteFailure, readActionFailureCauseV1, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentException, projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { isRecord } from '@happier-dev/protocol/common/records';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { logger } from '@/ui/logger';

type DomainAction = DeploymentDomainChildActionIdV1;
// The Domain mode owner presents native setup decisions without reading or
// deciding Machine administrator/network policy a second time.
type DomainNativeFailureScope = Readonly<{
    environmentId: string; domainId: string; step: 'native_execution'; tunnelId?: string; machineId?: string;
}>;
const failure = (reason: string, details?: unknown, failureCause?: unknown, effectAttempted?: unknown, nativeScope?: DomainNativeFailureScope) => {
    const errorCode = reason === 'mode_none' || reason === 'not_preauthorized' ? 'machine_admin_access_required'
        : reason === 'machine_reachability_posture_unavailable' ? 'machine_network_review_required' : reason;
    const parsedCause = failureCause === undefined ? undefined : readActionFailureCauseV1(failureCause);
    const { machineId, ...scope } = nativeScope ?? {};
    const scoped = nativeScope ? { ...scope, ...(isRecord(details) ? details : {}),
        ...(errorCode === 'machine_admin_access_required' && machineId ? { machineId } : {}) } : details;
    const recoveryFacts = nativeScope && isRecord(scoped) && typeof scoped.tunnelId === 'string' ? { ...scoped,
        ...(scoped.requiredFact === undefined || scoped.requiredFact === 'nativeExecutionResult' ? { requiredFact: 'cloudflarePreparation' } : {}),
        recovery: { kind: 'adopt' as const, tunnelId: scoped.tunnelId },
        remedy: `${typeof scoped.remedy === 'string' ? `${scoped.remedy} ` : ''}Cloudflare tunnel ${scoped.tunnelId} remains available. Resolve the reported error, then review this Domain using that tunnel (Adopt). Remove cleans its owned routes while retaining the tunnel.` } : scoped;
    const recovery = isRecord(recoveryFacts) && recoveryFacts.step === 'native_execution'
        ? projectDeploymentFailureRecoveryV1(recoveryFacts,
            errorCode === 'machine_admin_access_required' ? errorCode : undefined) : recoveryFacts;
    return { ok: false as const, errorCode, error: errorCode, ...(recovery === undefined ? {} : { details: recovery }),
        ...(typeof effectAttempted === 'boolean' ? { effectAttempted } : {}),
        ...(parsedCause === undefined ? {} : { failureCause: parsedCause }) };
};

type DomainDiscoveryHost = Readonly<{
    dispatch(job: DeploymentDomainDiscoverChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
    readEnvironment: OwnServerDeploymentTargetHostInput['readEnvironment'];
    readReceipt: OwnServerDeploymentTargetHostInput['readReceipt'];
    readInstallation(machineId: string, context: ActionExecutorContext): Promise<string>;
    readTelemetryCollectorPlacement?: OwnServerDeploymentTargetHostInput['readTelemetryCollectorPlacement'];
}>;

/** Review, Add and recovery Remove address the same installations. */
async function readOwnServerDomainDestinations(request: Readonly<{
    input: Pick<DeploymentDomainDiscoverChildRpcV1['input'], 'telemetryMachineId'>
        & Pick<DeploymentDomainReviewChildRpcV1['input'], 'membershipMachines'>;
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
    const collectorMachineId = request.content.target.kind === 'telemetry' ? environment.environment.telemetryMachineId : undefined;
    if (request.content.target.kind === 'telemetry' && !collectorMachineId) return failure('collector_unavailable');
    if (request.input.telemetryMachineId !== undefined && request.input.telemetryMachineId !== collectorMachineId) return failure('target_mismatch');
    const collector = collectorMachineId ? await host.readTelemetryCollectorPlacement?.(collectorMachineId, context) : undefined;
    if (collectorMachineId && (!collector || collector.kind !== 'ready')) return failure(collector?.reason ?? 'collector_unavailable');
    const membersForIngress = collector?.kind === 'ready' ? [{ machineId: collector.machineId,
        installationId: collector.installationId, state: 'active' as const }]
        : await readDomainIngressMembersForHost(link,
            'membershipMachines' in request.input ? request.input.membershipMachines : undefined, context, host.readReceipt);
    const destinations = membersForIngress.map(member => ({
        machineId: member.machineId, installationId: member.installationId }));
    if (ingress?.kind === 'edgeCaddy' && !destinations.some(member => member.machineId === ingress.edgeMachineId)) {
        destinations.push({ machineId: ingress.edgeMachineId,
            installationId: await host.readInstallation(ingress.edgeMachineId, context) });
    }
    return { ok: true as const, ingress, collector, collectorMachineId, membersForIngress, destinations };
}

/** Add and recovery Remove consume the same native observation and origin selection. */
async function discoverOwnServerDomainPlacement(request: Readonly<{
    actionId: 'deployments.domains.add' | 'deployments.domains.remove'; input: DeploymentDomainDiscoverChildRpcV1['input'];
    environment: Awaited<ReturnType<DomainDiscoveryHost['readEnvironment']>>;
    content: DeploymentDomainContentV1;
    targetLinkId: string; context: ActionExecutorContext;
}>, host: DomainDiscoveryHost) {
    const selectedDestinations = await readOwnServerDomainDestinations(request, host);
    if (!selectedDestinations.ok) return selectedDestinations;
    const { ingress, collector, collectorMachineId, membersForIngress, destinations } = selectedDestinations;
    const { context, environment } = request;
    const discoveryInput = { ...request.input, ...(collectorMachineId ? { telemetryMachineId: collectorMachineId } : {}) };
    const machines: DeploymentDomainTopologyV1['machines'] = [];
    for (const destination of destinations) {
        const nativeScope = { environmentId: environment.environment.id, domainId: request.input.domainId,
            step: 'native_execution' as const, machineId: destination.machineId };
        let observed: unknown;
        try {
            observed = await host.dispatch(DeploymentDomainDiscoverChildRpcV1Schema.parse({ v: 1,
                kind: 'domainDiscover', actionId: request.actionId, input: discoveryInput, ...destination,
                ...(collector?.kind === 'ready' && collector.app && destination.machineId === collector.machineId
                    ? { telemetryApp: collector.app } : {}) }), context);
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
    const members = membersForIngress.flatMap(member => {
        const observed = machines.find(machine => machine.machineId === member.machineId && machine.installationId === member.installationId);
        return observed ? [{ ...observed, state: member.state }] : [];
    });
    const edge = ingress?.kind === 'edgeCaddy' ? machines.find(machine => machine.machineId === ingress.edgeMachineId) : undefined;
    const selected = selectDomainCaddyPlacements({ ingress, members, ...(edge ? { edge } : {}) });
    if (selected.status !== 'ready') return failure(selected.reason, selected.details);
    const topology: DeploymentDomainTopologyV1 = { members: membersForIngress.map(member => ({
        machineId: member.machineId, installationId: member.installationId })), machines,
        ...(selected.tunnelOrigin ? { tunnelOrigin: selected.tunnelOrigin } : {}) };
    return { ok: true as const, placements: selected.placements, topology,
        ...(collectorMachineId ? { telemetryMachineId: collectorMachineId } : {}) };
}

async function reviewOwnServerDomainSetup(input: DeploymentDomainReviewChildRpcV1['input'],
    environment: DeploymentEnvironmentDetailV1, content: DeploymentDomainContentV1, context: ActionExecutorContext,
    host: DomainDiscoveryHost, dispatch: (job: DeploymentDomainReviewChildRpcV1, context: ActionExecutorContext) => Promise<unknown>,
): Promise<DeploymentDomainNativeSetupReviewV1 | ActionExecuteFailure> {
    const selected = await readOwnServerDomainDestinations({ input, environment, content, targetLinkId: input.targetLinkId, context }, host);
    if (!selected.ok) return selected;
    const rows = await Promise.all(selected.destinations.map(async destination => {
        const { collector, collectorMachineId } = selected;
        const job = DeploymentDomainReviewChildRpcV1Schema.parse({ v: 1, kind: 'domainReview', actionId: 'deployments.domains.add',
            input, ...destination, ...(collectorMachineId ? { telemetryMachineId: collectorMachineId } : {}),
            ...(collector?.kind === 'ready' && collector.app && destination.machineId === collector.machineId
                ? { telemetryApp: collector.app } : {}) });
        const observed = DeploymentDomainNativeSetupObservationV1Schema.safeParse(await dispatch(job, context).catch(error => {
            context.signal?.throwIfAborted();
            logger.debug('[Deployment] Domain Machine review unavailable', { machineId: destination.machineId,
                errorCode: projectDeploymentException(error, { phase: 'deployment.domain.native_execution' }).errorCode });
            return null;
        }));
        const status = observed.success ? observed.data.status : 'unavailable';
        return status === 'notNeeded' ? [] : [{ machineId: destination.machineId, status }];
    }));
    return { domainNativeSetup: rows.flat() };
}

/** The Environment Domain owner supplies its complete live set through its existing pages. */
async function* readEnvironmentDomainsForHost(environmentId: string, context: ActionExecutorContext,
    host: Readonly<{ serverId: string; storage: NonNullable<ActionExecutorDeps['deploymentAction']> }>) {
    let cursor: string | undefined;
    for (;;) {
        const result = await host.storage('deployments.domains.list', { serverId: host.serverId,
            environmentId, ...(cursor ? { cursor } : {}) }, context);
        if (isActionExecuteFailure(result)) throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: result.errorCode, error: result.error }), { cause: result });
        const page = DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(result);
        if (!page.ok) throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: page.error, error: page.error }), { cause: page });
        for (const domain of page.domains) if (domain.deletedAtMs === undefined) yield domain;
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
    }
}

/** Root inputs may omit their link or request; an unmatched link refuses and the
 * reviewed child input parse refuses a missing request at their own owners. */
type DomainMembershipInput = Readonly<{
    environmentId: string; targetLinkId?: string; requestKey?: string; machines?: readonly string[];
}>;

/** Membership changes demand the existing Domain Add owner, whose own review
 * prepares any selected vendor children before their native effects. */
export async function prepareOwnServerMembershipDomainReviewedChildren(
    input: DomainMembershipInput, context: ActionExecutorContext,
    host: DomainDiscoveryHost & Readonly<{ serverId: string; storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
        open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null> }>,
): Promise<HostReviewedChildrenDomainPreparationV1> {
    const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
    const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
    if (!link) return failure('target_mismatch');
    if (link.targetKind !== 'ownServer' || !input.machines && !link.members.some(member => member.state === 'joining')) return null;
    const membershipMachines = selectDomainMembershipMachines(link.members, input.machines);
    if (!membershipMachines.length) return null;
    const lineage = getDeploymentTargetLinkLineageV1(link, environment.targetLinks.map(item => item.targetLink));
    const children: HostReviewedChildrenPlanV1['children'][number][] = [];
    for await (const domain of readEnvironmentDomainsForHost(input.environmentId, context, host)) {
        if (!lineage.has(domain.targetLinkId)) continue;
        const plan = await prepareOwnServerDomainReviewedChildren({ actionId: 'deployments.domains.add', context,
            input: { serverId: host.serverId, environmentId: input.environmentId, domainId: domain.id,
                targetLinkId: link.id, expectedDomainRevision: domain.revision, expectedTargetLinkRevision: link.revision,
                expectedRevision: environment.environment.revision, requestKey: input.requestKey,
                contentArtifactId: domain.contentArtifactId, contentHeaderVersion: domain.contentHeaderVersion,
                contentBodyVersion: domain.contentBodyVersion } }, host);
        if (plan && 'errorCode' in plan) return plan;
        if (plan) children.push(...plan.children);
    }
    return children.length ? { children } : null;
}

/** Teardown reviews vendor effects as children of its existing single approval. */
export async function prepareOwnServerTeardownDomainReviewedChildren(
    request: Omit<Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0], 'input'>
        & Readonly<{ input: DeploymentTeardownInputV1 }>,
    host: DomainDiscoveryHost & Readonly<{ serverId: string; storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
        prepareProviderDomain?: NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>;
        open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null> }>,
): Promise<HostReviewedChildrenDomainPreparationV1> {
    const input = request.input;
    if (input.machines) {
        const environment = await host.readEnvironment({ environmentId: input.environmentId, context: request.context });
        const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
        if (!link) return failure('target_mismatch');
        if (selectDomainMembershipMachines(link.members, input.machines).length) {
            return prepareOwnServerMembershipDomainReviewedChildren(input, request.context, host);
        }
    }
    const children: HostReviewedChildrenPlanV1['children'][number][] = [];
    const scope = selectDeploymentTeardownDomainScopeV1(input);
    for await (const domain of readEnvironmentDomainsForHost(input.environmentId, request.context, host)) {
        if (scope.targetLinkId !== undefined && domain.targetLinkId !== scope.targetLinkId) continue;
        const removal = { ...request, actionId: 'deployments.domains.remove' as const,
            input: { serverId: input.serverId, environmentId: input.environmentId, domainId: domain.id,
                expectedDomainRevision: domain.revision, expectedRevision: input.expectedRevision, requestKey: input.requestKey } };
        if (domain.provider && !host.prepareProviderDomain) return failure('unsupported_action');
        const plan = domain.provider ? await host.prepareProviderDomain!(removal)
            : await prepareOwnServerDomainReviewedChildren(removal, host);
        if (isActionExecuteFailure(plan)) return plan;
        // Keeps the pre-existing uncoded failure when a provider settles instead of planning.
        if (plan && !('children' in plan)) throw new TypeError('Provider Domain removal returned no child plan');
        if (plan) children.push(...plan.children);
    }
    return children.length ? { children } : null;
}

export type ObservedDomainReview = Readonly<{
    input: ReturnType<typeof DeploymentActionInputSchemasV1[DeploymentDomainChildActionIdV1]['parse']>;
    environment: DeploymentEnvironmentDetailV1;
    domain?: DeploymentDomainHeaderV1;
}>;

/** Review concrete recovery operands before admission; retain them in the existing child port. */
export async function prepareOwnServerDomainReviewedChildren(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    host: DomainDiscoveryHost & Readonly<{ storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
        reviewNativeSetup?: (job: DeploymentDomainReviewChildRpcV1, context: ActionExecutorContext) => Promise<unknown>;
        open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null> }>,
    observed?: ObservedDomainReview,
): Promise<HostReviewedChildrenDomainPreparationV1> {
    const actionId = request.actionId;
    if (!isDeploymentDomainAddActionIdV1(actionId) && !isDeploymentDomainRemoveActionIdV1(actionId)) return null;
    const input = observed?.input ?? DeploymentActionInputSchemasV1[actionId].parse(request.input);
    if ('mode' in input) return null;
    let content: DeploymentDomainContentV1;
    let domain = observed?.domain;
    const add = 'targetLinkId' in input ? input : undefined;
    if (add && 'content' in add) content = add.content;
    else {
        let reference: { contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number };
        if (add && 'contentArtifactId' in add) reference = add;
        else {
            if (!domain) {
                const loaded = await host.storage('deployments.domains.get', { serverId: input.serverId,
                    environmentId: input.environmentId, domainId: input.domainId }, request.context);
                if (isActionExecuteFailure(loaded)) return loaded;
                const parsed = DeploymentActionOutputSchemasV1['deployments.domains.get'].parse(loaded);
                if (!parsed.ok) return failure(parsed.error);
                domain = parsed.domain;
            }
            reference = domain;
        }
        const opened = readDeploymentDomainArtifactV1(reference, await host.open(reference.contentArtifactId, request.context));
        if (!opened.ok) return failure(opened.error, undefined, opened.failureCause);
        content = opened.content;
    }
    const readEnvironment = (targetLinkId: string) => observed?.environment
        ?? host.readEnvironment({ environmentId: input.environmentId, targetLinkId, context: request.context });
    const environment = add ? await readEnvironment(add.targetLinkId) : undefined;
    if (add && !environment?.targetLinks.some(item => item.targetLink.id === add.targetLinkId)) return failure('target_mismatch');
    const resolved = resolveDomainIngress(content, environment?.content.ingress, add !== undefined);
    if (resolved.status === 'unavailable') return failure(resolved.reason, resolved.details);
    const preview = add && environment && !request.approvalReplay && host.reviewNativeSetup
        && environment.targetLinks.some(item => item.targetLink.id === add.targetLinkId && item.targetLink.targetKind === 'ownServer')
        ? await reviewOwnServerDomainSetup(add, environment, content, request.context, host, host.reviewNativeSetup) : undefined;
    if (isActionExecuteFailure(preview)) return preview;
    const approvalPreview = preview?.domainNativeSetup.length ? preview : undefined;
    const selected = resolved.selection;
    if (!selected) return approvalPreview ? { children: [], approvalPreview } : null;
    const credentialRef = readCloudflareDomainAccount(selected.selection);
    if (!credentialRef) return failure('connected_account_required');
    const { accountId, zoneId, tunnel } = selected.controller;
    const prepared = content.cloudflarePreparation;
    if (isDeploymentDomainRemoveActionIdV1(actionId) && !prepared) {
        if (!content.hostname) return failure('deployment_content_unavailable');
        if (!domain) return failure('deployment_content_unavailable');
        const environment = await readEnvironment(domain.targetLinkId);
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
        return { children: [{ action: { pluginId: credentialRef.service.pluginId, localId: 'cloudflare-named/disable' }, role: 'disable',
            input: { credentialRef, accountId, zoneId, tunnelName: tunnel.name,
                owned: [{ hostname: content.hostname, ...(content.target.path ? { path: content.target.path } : {}),
                    expectedService: origin.service }], dnsOwnership: [] } }] };
    }
    const role = isDeploymentDomainAddActionIdV1(actionId) ? 'configure' : 'disable';
    const tunnelOwnership = role === 'disable' && prepared && domain
        ? resolveCloudflareDomainTunnelOwnership(content,
            (await readEnvironment(domain.targetLinkId)).content.cloudflareTunnels)
        : undefined;
    return { ...(approvalPreview ? { approvalPreview } : {}), children: [{ action: { pluginId: credentialRef.service.pluginId, localId: `cloudflare-named/${role}` }, role,
        scopeInput: { credentialRef, accountId, zoneId,
            owned: prepared?.owned ?? selected.controller.owned,
            dnsOwnership: prepared?.dnsOwnership ?? selected.controller.dnsOwnership,
            ...(role === 'disable' && prepared ? { tunnelId: prepared.tunnelId,
                ...(tunnelOwnership ? { tunnelOwnership } : {}) }
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
        content: DeploymentDomainContentV1; context: ActionExecutorContext;
        createdTunnel?: NonNullable<DeploymentEnvironmentDetailV1['content']['cloudflareTunnels']>[number] }>): Promise<DeploymentDomainHeaderV1> =>
        runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => {
            const { domain, capture, content, context } = input;
            const actionId = 'deployments.domains.add';
            const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
            const authorizationHeaders: ArtifactRequestAuthorizationHeaders = async request =>
                ({ ...await host.headers(context, actionId, request) });
            const readResource = (id: string) => host.artifacts.readForUpdate(id, { signal: context.signal,
                prepareRecipients: false, includeSharedAudience: false, authorizationHeaders });
            const resource = await readResource(domain.contentArtifactId);
            const opened = readDeploymentDomainArtifactV1(domain, resource?.artifact ?? null);
            if (!opened.ok) return refuseDeploymentArtifactRead(opened);
            if (!resource) return refuse('deployment_content_unavailable');
            const prepareBody = async (resource: NonNullable<Awaited<ReturnType<typeof readResource>>>, content: unknown) => {
                const prepared = await resource.prepareJsonUpdate({ header: resource.artifact.header, body: JSON.stringify(content),
                    beforeWrite: () => context.signal?.throwIfAborted() });
                if (!prepared.ok) return refuse(prepared.errorCode);
                const { body, expectedBodyVersion, expectedHeaderVersion, provenance, provenanceDataEncryptionKey, kind } = prepared.mutation;
                return { update: { body, expectedBodyVersion, expectedHeaderVersion,
                        ...(provenance === undefined ? {} : { provenance }),
                        ...(provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey }),
                        ...(kind === undefined ? {} : { kind }) },
                    assertCurrent: prepared.assertCurrent, afterCommit: prepared.afterCommit };
            };
            const prepared = await prepareBody(resource, content);
            let environmentPrepared: Awaited<ReturnType<typeof prepareBody>> | undefined;
            const { createdTunnel } = input;
            if (createdTunnel) {
                const reference = capture.environmentContent;
                if (!reference) return refuse('deployment_content_unavailable');
                const resource = await readResource(reference.contentArtifactId);
                const opened = readDeploymentEnvironmentArtifactV1(reference, resource?.artifact ?? null);
                if (!opened.ok) return refuseDeploymentArtifactRead(opened);
                if (!resource) return refuse('deployment_content_unavailable');
                const tunnels = opened.content.cloudflareTunnels ?? [];
                if (!tunnels.some(tunnel => isDeepStrictEqual(tunnel, createdTunnel)))
                    environmentPrepared = await prepareBody(resource, { ...opened.content, cloudflareTunnels: [...tunnels, createdTunnel] });
            }
            // Only the body advances: retained predecessors still pin the original readable header.
            const body = DeploymentDomainPreparedContentInputV1Schema.parse({ serverId: host.serverId,
                environmentId: domain.environmentId, domainId: domain.id, expectedDomainRevision: domain.revision,
                actionOperationId: capture.placement.actionOperationId, capture,
                contentUpdate: prepared.update,
                ...(environmentPrepared ? { environmentContentUpdate: environmentPrepared.update } : {}) });
            const path = `/v1/deployments/environments/${encodeURIComponent(domain.environmentId)}/domains/${encodeURIComponent(domain.id)}/prepared-content`;
            const headers = await host.headers(context, actionId, { method: 'POST', path, body });
            await prepared.assertCurrent();
            await environmentPrepared?.assertCurrent();
            let response;
            try {
                response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                    headers, data: body, ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
            } catch (error) {
                logger.warnLocalFile('[Deployment] Domain prepared content request failed',
                    projectActionFailureCauseV1(error, 'deployment.domain.prepared_content', { allowUnknownErrorCode: false }));
                return refuse('outcome_unknown');
            }
            const result = DeploymentActionOutputSchemasV1[actionId].safeParse(response.data);
            if (!result.success) return refuse('outcome_unknown');
            if (!result.data.ok) return refuse(result.data.error);
            await prepared.afterCommit();
            await environmentPrepared?.afterCommit();
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
    dispatch(job: DeploymentDomainChildRpcV1 | DeploymentDomainDiscoverChildRpcV1 | DeploymentDomainDnsChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
    readEnvironment: OwnServerDeploymentTargetHostInput['readEnvironment'];
    readReceipt: OwnServerDeploymentTargetHostInput['readReceipt'];
    readInstallation(machineId: string, context: ActionExecutorContext): Promise<string>;
    readTelemetryCollectorPlacement?: OwnServerDeploymentTargetHostInput['readTelemetryCollectorPlacement'];
    open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
    createContent(content: DeploymentDomainContentV1,
        owner: Awaited<ReturnType<OwnServerDeploymentTargetHostInput['readEnvironment']>>['environment']['owner'],
        context: ActionExecutorContext): Promise<{ contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number }>;
    persistPreparedContent: ReturnType<typeof createOwnServerDomainContentWriter>;
    retireProviderDomain?(request: Readonly<{ domain: DeploymentDomainHeaderV1; content: DeploymentDomainContentV1;
        context: ActionExecutorContext }>): Promise<Awaited<ReturnType<NonNullable<ActionExecutorDeps['deploymentAction']>>>>;
    headers(context: ActionExecutorContext, actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>): Promise<Readonly<Record<string, string>>>;
}>) {
    type Execute = NonNullable<ActionExecutorDeps['deploymentAction']>;
    const execute = async (actionId: Parameters<Execute>[0], raw: Parameters<Execute>[1], context: ActionExecutorContext,
        admitted?: Readonly<{ domain: DeploymentDomainHeaderV1; content: DeploymentDomainContentV1 }>,
        reconcileTunnelConnectorsOnly?: true):
        Promise<Awaited<ReturnType<Execute>>> => {
        if (!isDeploymentDomainChildActionIdV1(actionId)) return failure('unsupported_action');
        let issued = false;
        let nativeScope: DomainNativeFailureScope | undefined;
        let dispatchedMachineId: string | undefined;
        let privateContent: DeploymentDomainContentV1 | undefined = admitted?.content;
        const run = async (): Promise<Awaited<ReturnType<Execute>>> => {
            try {
                const parsed = DeploymentActionInputSchemasV1[actionId].parse(raw);
                if ('mode' in parsed) return await previewOwnServerDomainDns(parsed, context, host);
                let input = parsed;
                let topology: DeploymentDomainTopologyV1 | undefined;
                if (isDeploymentDomainAddActionIdV1(actionId)) {
                    if (!context.externalActionExecutionAuthorization || !context.originalActionEnvelope) return failure('action_forbidden');
                    const original = DeploymentActionInputSchemasV1[actionId].parse(input);
                    const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
                    const link = environment.targetLinks.find(item => item.targetLink.id === original.targetLinkId)?.targetLink;
                    if (!link) return failure('target_mismatch');
                    // Authored content (app, CLI and agent adds alike) gets its default outside check here, once.
                    const prepared = 'content' in original ? await (async () => {
                        const authored = withDeploymentDomainHealthCheckDefaultV1(original.content);
                        const { content: _authored, ...metadata } = original;
                        return { input: { ...metadata, ...await host.createContent(authored, environment.environment.owner, context) },
                            opened: { ok: true as const, content: authored } };
                    })() : { input: original,
                        opened: readDeploymentDomainArtifactV1(original, await host.open(original.contentArtifactId, context)) };
                    const { input: preparedInput, opened } = prepared;
                    if (!opened.ok) return failure(opened.error, undefined, opened.failureCause);
                    privateContent = opened.content;
                    const discovered = await discoverOwnServerDomainPlacement({ actionId, input: preparedInput,
                        environment, content: opened.content, targetLinkId: original.targetLinkId, context }, host);
                    if (!discovered.ok) return discovered;
                    if (original.placements && !isDeepStrictEqual(original.placements, discovered.placements)) return failure('target_mismatch');
                    input = { ...preparedInput, placements: [...discovered.placements],
                        ...(discovered.telemetryMachineId ? { telemetryMachineId: discovered.telemetryMachineId } : {}) };
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
                nativeScope = { environmentId: input.environmentId, domainId: input.domainId, step: 'native_execution',
                    ...(isDeploymentDomainAddActionIdV1(actionId) && privateContent?.cloudflarePreparation
                        ? { tunnelId: privateContent.cloudflarePreparation.tunnelId } : {}) };
                if (isDeploymentDomainAddActionIdV1(actionId) && topology?.tunnelOrigin) {
                    // Add's discovery already opened this private content; preparation returns its own authored update.
                    const prepared = await prepareCloudflareDomainForHost({ domain, content: privateContent!,
                        membershipReconciliation: 'membershipDeploymentId' in input && input.membershipDeploymentId !== undefined,
                        topology, context, host, ...(reconcileTunnelConnectorsOnly ? { reconcileTunnelConnectorsOnly } : {}) });
                    domain = prepared.domain;
                    captures = domain.placements ?? [];
                    privateContent = prepared.content;
                    if (privateContent.cloudflarePreparation) nativeScope = { ...nativeScope,
                        tunnelId: privateContent.cloudflarePreparation.tunnelId };
                } else if (actionId === 'deployments.domains.verify' || isDeploymentDomainRemoveActionIdV1(actionId)) {
                    if (!privateContent) {
                        const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                        if (!opened.ok) return failure(opened.error, undefined, opened.failureCause);
                        privateContent = opened.content;
                    }
                }
                const tunnelOwnership = isDeploymentDomainRemoveActionIdV1(actionId) && privateContent?.cloudflarePreparation
                    ? resolveCloudflareDomainTunnelOwnership(privateContent,
                        (await host.readEnvironment({ environmentId: input.environmentId, context })).content.cloudflareTunnels)
                    : undefined;
                // Retire a changed route before replacing the same exact native id.
                // Both effects spend the captured admission, not another Action.
                const observations = [];
                for (const capture of [...captures.filter(capture => !capture.desired), ...captures.filter(capture => capture.desired)]) {
                    context.signal?.throwIfAborted();
                    const cloudflareConnector = privateContent && cloudflareDomainConnectorForTarget(privateContent, capture.placement);
                    dispatchedMachineId = capture.placement.machineId;
                    const result = await host.dispatch({ v: 1, kind: 'domain', actionId,
                        input: { serverId: input.serverId, environmentId: input.environmentId, domainId: input.domainId },
                        machineId: dispatchedMachineId, installationId: capture.placement.installationId,
                        expectedDomainRevision: domain.revision, capture,
                        ...(topology ? { topology } : {}),
                        ...(actionOperationId ? { actionOperationId } : {}),
                        ...(cloudflareConnector && (capture.desired || capture.retireSharedTunnel === true) ? { cloudflareConnector } : {}),
                    }, context);
                    dispatchedMachineId = undefined;
                    if (result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string')
                        return failure(result.errorCode, 'details' in result ? result.details : undefined,
                            'failureCause' in result ? result.failureCause : undefined,
                            'effectAttempted' in result ? result.effectAttempted : undefined,
                            { ...nativeScope, tunnelId: undefined, machineId: capture.placement.machineId });
                    const observation = DeploymentDomainObservationV1Schema.safeParse(result);
                    if (!observation.success) return failure('invalid_action_transport_output');
                    observations.push(observation.data);
                }
                // Native removal retires the final connector before provider
                // retirement. Home already captured whether it is shared.
                const tunnel = isDeploymentDomainRemoveActionIdV1(actionId) && privateContent
                    && observations.every(observation => observation.state === 'removed')
                    ? await disableCloudflareDomainForHost(privateContent, context,
                        captures.some(capture => capture.retireSharedTunnel === true), tunnelOwnership) : undefined;
                const body = DeploymentDomainTransitionInputV1Schema.parse({ serverId: input.serverId,
                    environmentId: input.environmentId, domainId: input.domainId, expectedDomainRevision: domain.revision, observations });
                const path = `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/domains/${encodeURIComponent(input.domainId)}/transitions`;
                const headers = await host.headers(context, actionId satisfies DomainAction, { method: 'POST', path, body });
                context.signal?.throwIfAborted();
                issued = true;
                const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                    headers, data: body, ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
                const settled = DeploymentActionOutputSchemasV1[actionId].safeParse(response.data);
                return settled.success ? { ...settled.data, ...(settled.data.ok && tunnel ? { tunnel } : {}) }
                    : failure('outcome_unknown', nativeScope);
            } catch (error) {
                const diagnostic = issued ? projectDeploymentFailure('outcome_unknown', error, 'deployment.domain.native_execution')
                    : projectDeploymentException(error, { signal: context.signal, phase: 'deployment.domain.native_execution' });
                return { ...failure(diagnostic.errorCode, !issued ? (error instanceof Error && 'details' in error ? error.details : undefined)
                    ?? diagnostic.details : undefined,
                    diagnostic.failureCause, diagnostic.effectAttempted,
                    nativeScope && { ...nativeScope, tunnelId: undefined, machineId: dispatchedMachineId }), error: diagnostic.error };
            }
        };
        const result = await run();
        // All post-admission failures settle here, including Home refusals and malformed native results.
        // Preparation may have created a tunnel before throwing; its details carry that same owned context.
        if (!nativeScope) return result;
        if (isActionExecuteFailure(result)) return { ...failure(result.errorCode, result.details,
            result.failureCause, result.effectAttempted, nativeScope), error: result.error };
        if ('ok' in result && !result.ok && 'error' in result && typeof result.error === 'string')
            return failure(result.error, undefined, undefined, undefined, nativeScope);
        return result;
    };
    async function reconcileMembership(input: DomainMembershipInput & Readonly<{ deploymentId: string; reconcileTunnelConnectorsOnly?: true }>,
        admittedContext: ActionExecutorContext, admitted?: Readonly<{
            environment: Awaited<ReturnType<typeof host.readEnvironment>>;
            membershipMachines: ReturnType<typeof selectDomainMembershipMachines>;
        }>): Promise<ActionExecuteFailure | null> {
        // A template's reviewed deploy leaf spends the accepted root for these sibling Domain effects.
        const originalAuthorization = readHostReviewedChildOriginalAuthorizationV1(admittedContext);
        const context = originalAuthorization
            ? { ...admittedContext, externalActionExecutionAuthorization: originalAuthorization } : admittedContext;
        const environment = admitted?.environment ?? await host.readEnvironment({ environmentId: input.environmentId, context });
        const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
        if (!link) return failure('target_mismatch');
        const membershipMachines = admitted?.membershipMachines ?? selectDomainMembershipMachines(link.members, input.machines);
        const lineage = getDeploymentTargetLinkLineageV1(link, environment.targetLinks.map(item => item.targetLink));
        const ingress = environment.content.ingress;
        if (input.reconcileTunnelConnectorsOnly && ingress?.kind !== 'cloudflareTunnel') return failure('deployment_conflict');
        const count = (ingress?.kind === 'cloudflareTunnel' ? ingress.connectorsPerMachine : undefined)
            ?? DEFAULT_CLOUDFLARE_TUNNEL_CONNECTORS_PER_MACHINE;
        let revision = environment.environment.revision;
        for await (const domain of readEnvironmentDomainsForHost(input.environmentId, context, host)) {
            if (!lineage.has(domain.targetLinkId)) continue;
            context.signal?.throwIfAborted();
            if (input.reconcileTunnelConnectorsOnly) {
                if (domain.provider || domain.state === 'removing') continue;
                const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                if (!opened.ok) return failure(opened.error, undefined, opened.failureCause);
                const prepared = opened.content.cloudflarePreparation;
                if (!prepared?.connectors?.length || opened.content.target.kind === 'telemetry') continue;
                if (domain.state === 'active'
                    && (prepared.connectorsPerMachine ?? DEFAULT_CLOUDFLARE_TUNNEL_CONNECTORS_PER_MACHINE) === count) continue;
            }
            const result = await execute('deployments.domains.add', { serverId: host.serverId,
                environmentId: input.environmentId, domainId: domain.id, expectedDomainRevision: domain.revision,
                expectedRevision: revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
                contentArtifactId: domain.contentArtifactId, contentHeaderVersion: domain.contentHeaderVersion,
                contentBodyVersion: domain.contentBodyVersion,
                requestKey: createHash('sha256').update(JSON.stringify([input.requestKey, domain.id])).digest('hex'),
                membershipDeploymentId: input.deploymentId, membershipMachines }, context, undefined, input.reconcileTunnelConnectorsOnly);
            if (isActionExecuteFailure(result)) return result;
            const settled = DeploymentActionOutputSchemasV1['deployments.domains.add'].safeParse(result);
            if (!settled.success) return deploymentOutputValidationFailure('deployments.domains.add', undefined, settled.error);
            if (!settled.data.ok) return failure(settled.data.error);
            if (settled.data.domain.state !== 'active') return failure('native_route_unavailable');
            revision = settled.data.revision;
        }
        return null;
    }
    return Object.assign((...args: Parameters<Execute>) => execute(args[0], args[1], args[2]), {
        reconcileMembership,
        async retireEnvironment(input: Pick<DeploymentTeardownInputV1, 'environmentId' | 'expectedRevision' | 'requestKey'>
            & Partial<Pick<DeploymentTeardownInputV1, 'targetLinkId' | 'machines' | 'removeEnvironment'>> & Readonly<{ deploymentId?: string }>,
            context: ActionExecutorContext): Promise<ActionExecuteFailure | null> {
            const { environmentId, expectedRevision, requestKey } = input;
            if (input.machines && input.targetLinkId && input.deploymentId) {
                const environment = await host.readEnvironment({ environmentId, context });
                const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
                if (!link) return failure('target_mismatch');
                const membershipMachines = selectDomainMembershipMachines(link.members, input.machines);
                if (membershipMachines.length) return reconcileMembership({
                    ...input, targetLinkId: input.targetLinkId, deploymentId: input.deploymentId }, context, { environment, membershipMachines });
            }
            const scope = selectDeploymentTeardownDomainScopeV1(input);
            for await (const domain of readEnvironmentDomainsForHost(environmentId, context, host)) {
                if (scope.targetLinkId !== undefined && domain.targetLinkId !== scope.targetLinkId) continue;
                let hostname: string | undefined;
                let result: Awaited<ReturnType<Execute>>;
                try {
                    context.signal?.throwIfAborted();
                    const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
                    if (!opened.ok) result = failure(opened.error, undefined, opened.failureCause);
                    else {
                        hostname = opened.content.hostname ?? undefined;
                        result = domain.provider ? host.retireProviderDomain
                            ? await host.retireProviderDomain({ domain, content: opened.content, context }) : failure('unsupported_action')
                            : await execute('deployments.domains.remove', { serverId: host.serverId,
                            environmentId, domainId: domain.id, expectedDomainRevision: domain.revision, expectedRevision, requestKey }, context,
                            { domain, content: opened.content });
                    }
                } catch (error) {
                    result = projectDeploymentFailure(context.signal?.aborted ? 'cancelled' : 'native_route_unavailable', error,
                        'deployment.teardown.removeDomain');
                }
                if ('ok' in result && result.ok) continue;
                // An approval hold is not a settled removal; it has no public error of its own.
                const diagnostic = isActionExecuteFailure(result) ? result
                    : failure('error' in result && typeof result.error === 'string' ? result.error : 'invalid_action_output');
                const recovery = projectDeploymentFailureRecoveryV1(isRecord(diagnostic.details) ? diagnostic.details : {});
                return { ...diagnostic, details: { environmentId, domainId: domain.id,
                    ...(hostname ? { domainHostname: hostname } : {}), step: 'removeDomain', partial: true,
                    requiredFact: recovery.requiredFact, remedy: recovery.remedy } };
            }
            return null;
        },
    });
}
