import axios from '@/api/client/credentialAxios';
import { ProjectDeploymentDefaultsOutputV1Schema, ProjectDeploymentDefaultsPayloadV1Schema,
    type ActionExecutorContext,
    type DeploymentTemplateInstantiationReviewV1 } from '@happier-dev/protocol';
import type { ProjectSourceOwnerV1, ProjectSourcesCreateInputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { resolveDeploymentCreationDefaultsV1, type DeploymentCreationDefaultsInputV1 } from '@happier-dev/deployments';
import type { DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export type DeploymentCreationDefaultInputsForHost = Pick<DeploymentCreationDefaultsInputV1, 'projectDefaults' | 'account'> & Readonly<{
    reviewBasis?: DeploymentTemplateInstantiationReviewV1['creationDefaultsBasis'];
}>;
type CreationPreparationActionId = 'deployments.templates.instantiate' | 'deployments.publish.prepare' | 'deployments.environments.create';
export type DeploymentCreationDefaultRequestForHost = Readonly<{
    projectSourceId?: string; sourceRevision?: number; projectOwner: ProjectSourceOwnerV1; context: ActionExecutorContext;
    actionId?: CreationPreparationActionId;
}>;

type CreationDefaultsHost = Readonly<{
    serverId: string; serverHttpBaseUrl: string; accountId: string; expectedScopeKey: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    headers(context: ActionExecutorContext, actionId: CreationPreparationActionId,
        request: Readonly<{ method: string; path: string }>): Promise<Readonly<Record<string, string>>>;
    open(artifactId: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
    readAccountSnapshot(): ActiveAccountSettingsSnapshot | null | Promise<ActiveAccountSettingsSnapshot | null>;
}>;

/** One-shot creation preparation. Review retains values, never a pointer to future defaults. */
export async function prepareDeploymentCreationDefaultsForHost(request: Readonly<{
    projectSourceId?: string; newProject?: Pick<ProjectSourcesCreateInputV1, 'name' | 'requestKey'> & { owner: ProjectSourceOwnerV1 };
    actionId: CreationPreparationActionId; context: ActionExecutorContext;
    explicit?: DeploymentCreationDefaultsInputV1['explicit']; target: DeploymentCreationDefaultsInputV1['target'];
}>, host: CreationDefaultsHost): Promise<ReturnType<typeof resolveDeploymentCreationDefaultsV1> & Readonly<{
    projectOwner: ProjectSourceOwnerV1; reviewBasis?: DeploymentTemplateInstantiationReviewV1['creationDefaultsBasis'];
}>> {
    await host.assertCurrent(request.context);
    if (request.newProject) {
        const projectOwner = request.newProject.owner;
        const inputs = await readDeploymentCreationDefaultInputsForHost({ projectOwner, context: request.context,
            actionId: request.actionId }, host);
        return { ...resolveDeploymentCreationDefaultsV1({ projectOwner, ...inputs,
            explicit: request.explicit, target: request.target }), projectOwner };
    }
    if (!request.projectSourceId) return refuse('invalid_parameters');
    const sources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: async (serverId, context) => {
            await host.assertCurrent(context);
            return serverId === host.serverId ? null : { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        },
        // Preparation spends the admitted create/template root, not fresh Source-read authority.
        resolveRequestHeaders: (context, _actionId, transport) => host.headers(context, request.actionId, transport),
    });
    const source = await sources.projectSourcesRead!({ serverId: host.serverId, sourceId: request.projectSourceId }, request.context);
    if (!source.ok) return refuse('errorCode' in source ? source.errorCode : source.error);
    if (source.source.id !== request.projectSourceId || !source.canManage) return refuse('source_access_denied');
    const projectOwner = source.source.owner ?? { kind: 'account' as const, accountId: source.source.createdByAccountId };
    const inputs = await readDeploymentCreationDefaultInputsForHost({ ...request, projectOwner,
        sourceRevision: source.source.revision }, host);
    const resolved = resolveDeploymentCreationDefaultsV1({ ...request, projectOwner, ...inputs });
    await host.assertCurrent(request.context);
    return { ...resolved, projectOwner, ...(inputs.reviewBasis ? { reviewBasis: inputs.reviewBasis } : {}) };
}

/** Exact private Project demand; Account preferences stay with the captured requesting Account. */
export async function readDeploymentCreationDefaultInputsForHost(
    request: DeploymentCreationDefaultRequestForHost,
    host: CreationDefaultsHost,
): Promise<DeploymentCreationDefaultInputsForHost> {
    await host.assertCurrent(request.context);
    if (request.context.runtimeAccountId && request.context.runtimeAccountId !== host.accountId) return refuse('action_forbidden');
    const serverId = request.context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? host.serverId;
    let projectDefaults: DeploymentCreationDefaultInputsForHost['projectDefaults'];
    let account: DeploymentCreationDefaultInputsForHost['account'];
    let reviewBasis: DeploymentCreationDefaultInputsForHost['reviewBasis'];
    if (request.projectSourceId !== undefined) {
        const path = `/v1/projects/${encodeURIComponent(request.projectSourceId)}/deployment-defaults?serverId=${encodeURIComponent(serverId)}`;
        const response = await axios.request<unknown>({ method: 'GET', url: `${host.serverHttpBaseUrl}${path}`,
            headers: await host.headers(request.context, request.actionId ?? 'deployments.templates.instantiate', { method: 'GET', path }),
            signal: request.context.signal, validateStatus: () => true });
        const parsed = ProjectDeploymentDefaultsOutputV1Schema.safeParse(response.data);
        if (!parsed.success) return refuse('project_defaults_unavailable');
        if (!parsed.data.ok) return refuse(parsed.data.error);
        const metadata = parsed.data;
        if (metadata.projectSourceId !== request.projectSourceId || metadata.sourceRevision !== request.sourceRevision) return refuse('project_defaults_conflict');
        if (metadata.content) {
            const artifact = await host.open(metadata.content.contentArtifactId, request.context);
            if (!artifact || artifact.header.kind !== 'project-deployment-defaults.v1' || typeof artifact.body !== 'string') {
                return refuse('project_defaults_content_unavailable');
            }
            if (artifact.artifactId !== metadata.content.contentArtifactId
                || artifact.revision.headerVersion !== metadata.content.contentHeaderVersion
                || artifact.revision.bodyVersion !== metadata.content.contentBodyVersion) return refuse('project_defaults_conflict');
            let body: unknown;
            try { body = JSON.parse(artifact.body); } catch { return refuse('project_defaults_content_unavailable'); }
            const payload = ProjectDeploymentDefaultsPayloadV1Schema.safeParse(body);
            if (!payload.success || payload.data.projectSourceId !== request.projectSourceId) return refuse('project_defaults_content_unavailable');
            projectDefaults = payload.data;
        }
        reviewBasis = { projectSourceId: metadata.projectSourceId, sourceRevision: metadata.sourceRevision,
            projectDefaultsRevision: metadata.revision, content: metadata.content };
    }
    if (request.projectOwner.kind === 'account' && request.projectOwner.accountId === host.accountId) {
        const snapshot = await host.readAccountSnapshot();
        if (!snapshot || snapshot.source === 'none' || snapshot.scopeKey !== host.expectedScopeKey) return refuse('account_settings_unavailable');
        account = { accountId: host.accountId, defaults: snapshot.settings.deploymentDefaultsV1 };
    }
    await host.assertCurrent(request.context);
    return { ...(projectDefaults ? { projectDefaults } : {}), ...(account ? { account } : {}),
        ...(reviewBasis ? { reviewBasis } : {}) };
}
