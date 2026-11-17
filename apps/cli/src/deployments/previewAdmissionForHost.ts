import { recordFailureCause } from '@/diagnostics/recordFailureCause';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { DeploymentEnvironmentListResultV1Schema, type DeploymentEnvironmentListInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentPreviewForkEligibilityV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';

/** One admission proves the actual code execution Machines from complete inventory. */
export async function preparePreviewForkEligibilityForHost(input: Readonly<{
    serverId: string; protection: DeploymentEnvironmentHeaderV1['protection']; buildMachineId?: string;
    runtime?: Readonly<{ source: Readonly<{ kind: 'host' | 'plugin' }>; machines: readonly string[] }>;
}>, list: (input: DeploymentEnvironmentListInputV1) => Promise<unknown>): Promise<DeploymentPreviewForkEligibilityV1> {
    if (input.protection === 'production') return { kind: 'ineligible', reason: 'production_workload' };
    if (!input.runtime) return { kind: 'unavailable', reason: 'placement_unavailable' };
    if (input.runtime.source.kind !== 'host') return { kind: 'ineligible', reason: 'unsupported_target' };
    const machines = new Set([...(input.buildMachineId ? [input.buildMachineId] : []), ...input.runtime.machines]);
    if (!input.buildMachineId || !input.runtime.machines.length) return { kind: 'unavailable', reason: 'placement_unavailable' };
    try {
        for (const machineId of machines) {
            let cursor: string | null = null;
            do {
                const page = DeploymentEnvironmentListResultV1Schema.parse(await list({ serverId: input.serverId,
                    machineId, ...(cursor ? { cursor } : {}) }));
                if (!page.ok) return { kind: 'unavailable', reason: 'inventory_unavailable' };
                if (page.coverage !== 'complete') return { kind: 'unavailable', reason: 'inventory_incomplete' };
                if (page.items.some(environment => environment.protection === 'production'))
                    return { kind: 'ineligible', reason: 'production_workload' };
                cursor = page.nextCursor;
            } while (cursor);
        }
        return { kind: 'eligible' };
    } catch (error) {
        return recordFailureCause(error, 'deployment.preview.inventory', { kind: 'unavailable' as const, reason: 'inventory_unavailable' as const });
    }
}

/** Private PR provenance is admitted on the controller, including E2EE Accounts.
 * The server remains the owner of the non-content template/Source relationship. */
export async function admitPreviewEnvironmentForHost(input: Readonly<{
    content: Pick<DeploymentEnvironmentContentV1, 'previewProvenance'>;
    templateEnvironmentId: string;
    expectedTemplateRevision?: number;
    projectSourceId?: string;
}>, host: Readonly<{
    readTemplate(environmentId: string): Promise<Readonly<{
        environment: DeploymentEnvironmentHeaderV1; content: DeploymentEnvironmentContentV1;
    }>>;
}>): Promise<Readonly<{ fork: boolean }>> {
    const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
    const provenance = input.content.previewProvenance;
    if (!provenance || provenance.templateEnvironmentId !== input.templateEnvironmentId)
        return refuse('deployment_content_unavailable');
    const repository = normalizeScmHostingRepositoryIdentity(provenance.repository);
    const headRepository = normalizeScmHostingRepositoryIdentity(provenance.headRepository);
    if (!repository || !headRepository) return refuse('deployment_content_unavailable');
    const template = await host.readTemplate(input.templateEnvironmentId);
    if (template.environment.id !== input.templateEnvironmentId
        || input.expectedTemplateRevision !== undefined && template.environment.revision !== input.expectedTemplateRevision)
        return refuse('deployment_conflict');
    const policy = template.content.previewTemplate;
    if (template.environment.purpose !== 'standard' || template.environment.deletedAtMs !== undefined
        || !policy?.enabled) return refuse('deployment_access_denied');
    if (input.projectSourceId !== undefined && input.projectSourceId !== template.environment.projectSourceId
        || !sameScmHostingRepositoryIdentity(policy.repository, repository)) return refuse('source_mismatch');
    if (template.environment.runtimeTargetLinkId !== provenance.runtimeTargetLinkId
        || policy.runtimeTargetLinkId !== provenance.runtimeTargetLinkId) return refuse('target_mismatch');
    if (sameScmHostingRepositoryIdentity(repository, headRepository)) return { fork: false };
    if (policy.forkPreviews === 'off') return refuse('deployment_access_denied');
    return { fork: true };
}
