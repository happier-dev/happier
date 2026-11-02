import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

/** Private PR provenance is admitted on the controller, including E2EE Accounts.
 * The server remains the owner of the non-content template/Source relationship. */
export async function admitPreviewEnvironmentForHost(input: Readonly<{
    content: DeploymentEnvironmentContentV1;
    templateEnvironmentId: string;
    expectedTemplateRevision?: number;
}>, host: Readonly<{
    readTemplate(environmentId: string): Promise<Readonly<{
        environment: DeploymentEnvironmentHeaderV1; content: DeploymentEnvironmentContentV1;
    }>>;
}>): Promise<void> {
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    const provenance = input.content.previewProvenance;
    if (!provenance || provenance.templateEnvironmentId !== input.templateEnvironmentId)
        return refuse('deployment_content_unavailable');
    const repository = normalizeScmHostingRepositoryIdentity(provenance.repository);
    const headRepository = normalizeScmHostingRepositoryIdentity(provenance.headRepository);
    if (!repository || !headRepository) return refuse('deployment_content_unavailable');
    if (sameScmHostingRepositoryIdentity(repository, headRepository)) return;
    const template = await host.readTemplate(input.templateEnvironmentId);
    if (template.environment.id !== input.templateEnvironmentId
        || input.expectedTemplateRevision !== undefined && template.environment.revision !== input.expectedTemplateRevision)
        return refuse('deployment_conflict');
    const policy = template.content.previewTemplate;
    if (template.environment.purpose !== 'standard' || template.environment.deletedAtMs !== undefined
        || !policy?.enabled || policy.forkPreviews === 'off') return refuse('deployment_access_denied');
    // No current producer binds an exact fork head to the preview Deploy Action's
    // approval. Standing Workflow consent cannot substitute for that decision.
    // Refuse before child/binding/data/provider acquisition until it is supplied.
    return refuse('approvals_not_supported');
}
