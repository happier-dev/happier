import { DeploymentActionOutputSchemasV1, DeploymentDomainDnsChildRpcV1Schema,
    type ActionExecutorContext, type DeploymentDomainPreviewInputV1 } from '@happier-dev/protocol';
import { projectDeploymentDomainDraftCheckV1 } from '@happier-dev/deployments';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { createOwnServerDomainActions } from './ownServerDomainActions';
import { readDomainIngressMembersForHost, resolveDomainIngress } from './domainRouteSelection';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';

type Host = Pick<Parameters<typeof createOwnServerDomainActions>[0],
    'readEnvironment' | 'readReceipt' | 'readInstallation' | 'dispatch'>;

/** Draft DNS uses the existing ingress authority without allocating retained content or native services. */
export async function previewOwnServerDomainDns(input: DeploymentDomainPreviewInputV1,
    context: ActionExecutorContext, host: Host) {
    const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
    const link = environment.targetLinks.find(row => row.targetLink.id === input.targetLinkId)?.targetLink;
    if (!link || environment.environment.runtimeTargetLinkId !== link.id) return projectDeploymentFailure('target_mismatch');
    if (environment.environment.revision !== input.expectedRevision || link.revision !== input.expectedTargetLinkRevision)
        return projectDeploymentFailure('deployment_conflict');
    const resolved = resolveDomainIngress(input.content, environment.content.ingress);
    if (resolved.status !== 'ready') return projectDeploymentFailure(resolved.reason);
    const check = projectDeploymentDomainDraftCheckV1(input.content.target.kind, resolved.ingress?.kind);
    if (link.source.kind !== 'host' || link.targetKind !== 'ownServer' || check.kind !== 'machineDns')
        return projectDeploymentFailure('native_route_unavailable');
    let destination: { machineId: string; installationId: string };
    if (resolved.ingress?.kind === 'edgeCaddy') {
        const machineId = resolved.ingress.edgeMachineId;
        destination = { machineId, installationId: await host.readInstallation(machineId, context) };
    } else {
        const members = await readDomainIngressMembersForHost(link, undefined, context, host.readReceipt);
        if (members.length !== 1) return projectDeploymentFailure('required_fact_unavailable');
        destination = { machineId: members[0]!.machineId, installationId: members[0]!.installationId };
    }
    context.signal?.throwIfAborted();
    const result = await host.dispatch(DeploymentDomainDnsChildRpcV1Schema.parse({ v: 1, kind: 'domainDns',
        actionId: 'deployments.domains.verify', input, ...destination }), context);
    const failure = ActionExecuteFailureSchema.safeParse(result);
    if (failure.success) return failure.data;
    const parsed = DeploymentActionOutputSchemasV1['deployments.domains.verify'].safeParse(result);
    if (!parsed.success || parsed.data.ok && (!('environmentId' in parsed.data)
        || parsed.data.environmentId !== input.environmentId
        || (input.content.hostname === null ? !('addressOffer' in parsed.data) : !('dnsHealth' in parsed.data))))
        return projectDeploymentFailure('invalid_action_transport_output');
    return parsed.data;
}
