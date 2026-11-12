import { DeploymentActionOutputSchemasV1, DeploymentDomainDnsInputV1Schema, DeploymentDomainDnsRecordResultV1Schema,
    DeploymentDomainDnsResultV1Schema, isDeploymentDomainDnsActionIdV1,
    type ActionExecutorContext, type ActionExecutorDeps, type ActionExecuteResult } from '@happier-dev/protocol';
import { readDeploymentDomainArtifactV1 } from '@happier-dev/deployment-protocol';
import type { createOwnServerDomainActions } from './ownServer/ownServerDomainActions';
import { buildDomainDnsRecordChildren } from './domainDnsRecords';
import { projectDeploymentFailure } from '../deploymentFailure';

export { buildDomainDnsRecordChildren } from './domainDnsRecords';
type Host = Pick<Parameters<typeof createOwnServerDomainActions>[0], 'storage' | 'open' | 'readEnvironment'>;
type Preparation = Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0];

/** DNS uses the existing Domain read/admission and reviewed child port; it does not settle route or application state. */
export function createDomainDnsActionsForHost(host: Host) {
    async function prepare(request: Preparation): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
        if (!isDeploymentDomainDnsActionIdV1(request.actionId)) return null;
        const input = DeploymentDomainDnsInputV1Schema.parse(request.input);
        const environment = await host.readEnvironment({ environmentId: input.environmentId, context: request.context });
        if (environment.environment.revision !== input.expectedRevision) return projectDeploymentFailure('deployment_conflict');
        const read = await host.storage('deployments.domains.get', { serverId: input.serverId,
            environmentId: input.environmentId, domainId: input.domainId }, request.context);
        if ('errorCode' in read) return read;
        const parsed = DeploymentActionOutputSchemasV1['deployments.domains.get'].parse(read);
        if (!parsed.ok) return projectDeploymentFailure(parsed.error);
        if (parsed.domain.revision !== input.expectedDomainRevision || parsed.domain.deletedAtMs !== undefined)
            return projectDeploymentFailure('deployment_conflict');
        const opened = readDeploymentDomainArtifactV1(parsed.domain, await host.open(parsed.domain.contentArtifactId, request.context));
        if (!opened.ok) return projectDeploymentFailure(opened.error);
        return buildDomainDnsRecordChildren(input, opened.content);
    }
    async function execute(actionId: string, raw: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult | null> {
        if (!isDeploymentDomainDnsActionIdV1(actionId)) return null;
        const input = DeploymentDomainDnsInputV1Schema.parse(raw);
        const port = context.hostReviewedChild;
        const children = port?.preparedChildren?.filter(child => child.role?.startsWith('domain-dns:'));
        if (!port || !children?.length) return projectDeploymentFailure('action_forbidden');
        const records = [];
        for (const child of children) {
            context.signal?.throwIfAborted();
            const result = await port.invoke(child);
            if (!result.ok) return result;
            const observed = DeploymentDomainDnsRecordResultV1Schema.safeParse(result.result);
            if (!observed.success) return projectDeploymentFailure('invalid_action_transport_output');
            // Prepared input was validated by the selected plugin Action at admission.
            const selected = child.input as Readonly<{ name: string; type: string }>;
            records.push({ name: selected.name, type: selected.type, result: observed.data });
        }
        return { ok: true, result: DeploymentDomainDnsResultV1Schema.parse({ ok: true, domainId: input.domainId, records }) };
    }
    return Object.assign(prepare, { execute });
}
