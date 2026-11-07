import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ProjectDeploymentDefaultsOutputV1Schema, ProjectDeploymentDefaultsPayloadV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createProjectSourceActionDeps } from './projectSourceActions';

function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }

/** A demanded Project leaf, opened by the existing mode-aware Artifact owner. */
export async function readProjectDeploymentDefaults(lifetime: ServerAccountScopeLifetime, projectSourceId: string, signal: AbortSignal) {
    const account = await captureLazyActionAccountContext(lifetime.scope.serverId, signal);
    try {
        if (!lifetime.isCurrent() || account.accountId !== lifetime.scope.accountId) return refuse('action_account_scope_changed');
        const serverId = account.serverIdentityId ?? account.serverId;
        const source = await createProjectSourceActionDeps(account).projectSourcesRead({ serverId, sourceId: projectSourceId }, { signal });
        if (!source.ok) return refuse('errorCode' in source ? source.errorCode : source.error);
        const response = await requestHomeDomain({ scope: account.accountLifetime.scope,
            path: `/v1/projects/${encodeURIComponent(projectSourceId)}/deployment-defaults?serverId=${encodeURIComponent(serverId)}`,
            method: 'GET', input: undefined, schema: ProjectDeploymentDefaultsOutputV1Schema, effect: 'read', signal, requestAuthority: account });
        if (!response.ok) return refuse(homeDomainFailureCode(response.failure));
        const metadata = response.value;
        if (!metadata.ok) return refuse(metadata.error);
        if (metadata.projectSourceId !== projectSourceId || metadata.sourceRevision !== source.source.revision) return refuse('project_defaults_conflict');
        let preferences: DeploymentCreationDefaultsV1 = {};
        if (metadata.content) {
            const document = await account.readArtifactContent(metadata.content.contentArtifactId, { signal });
            if (!document || document.header.kind !== 'project-deployment-defaults.v1' || typeof document.body !== 'string') return refuse('project_defaults_content_unavailable');
            if (document.revision.headerVersion !== metadata.content.contentHeaderVersion || document.revision.bodyVersion !== metadata.content.contentBodyVersion) return refuse('project_defaults_conflict');
            let body: unknown;
            try { body = JSON.parse(document.body); } catch { return refuse('project_defaults_content_unavailable'); }
            const payload = ProjectDeploymentDefaultsPayloadV1Schema.safeParse(body);
            if (!payload.success || payload.data.projectSourceId !== projectSourceId) return refuse('project_defaults_content_unavailable');
            preferences = payload.data.deploymentDefaults;
        }
        const owner = source.source.owner ?? { kind: 'account' as const, accountId: source.source.createdByAccountId };
        account.assertCurrent();
        return { source: source.source, owner, canManage: source.canManage, metadata, preferences };
    } finally { account.dispose(); }
}
export type ProjectDeploymentDefaultsRead = Awaited<ReturnType<typeof readProjectDeploymentDefaults>>;

/** Publish a fresh snapshot, so a refused leaf write cannot change the currently referenced defaults. */
export async function writeProjectDeploymentDefaults(input: Readonly<{
    serverId: string; accountId: string; current: ProjectDeploymentDefaultsRead; preferences: DeploymentCreationDefaultsV1;
    execute: (actionId: ActionId, input: unknown) => Promise<unknown>;
}>) {
    const { current, preferences, execute } = input;
    let content: ProjectDeploymentDefaultsRead['metadata']['content'] = null;
    if (Object.keys(preferences).length) {
        const created = ArtifactActionOutputSchemasV1['artifact.create'].parse(await execute('artifact.create', {
            header: { kind: 'project-deployment-defaults.v1', title: current.source.name },
            body: JSON.stringify({ projectSourceId: current.source.id, deploymentDefaults: preferences }),
        }));
        const owner = current.owner;
        if (owner.kind === 'team' || owner.accountId !== input.accountId) {
            await execute('artifact.access.grants.set', { artifactId: created.artifactId, principal: owner, accessLevel: 'edit' });
        }
        for (const grant of current.source.audience) {
            const principal = grant.principal;
            if (principal.kind === 'account' && (principal.accountId === input.accountId
                || (owner.kind === 'account' && principal.accountId === owner.accountId))) continue;
            if (principal.kind === 'team' && owner.kind === 'team' && principal.teamId === owner.teamId) continue;
            await execute('artifact.access.grants.set', { artifactId: created.artifactId, principal, accessLevel: 'view' });
        }
        content = { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
            contentBodyVersion: created.revision.bodyVersion };
    }
    const metadata = ProjectDeploymentDefaultsOutputV1Schema.parse(await execute('projects.deploymentDefaults.set', {
        serverId: input.serverId, projectSourceId: current.source.id, expectedSourceRevision: current.source.revision,
        expectedRevision: current.metadata.revision, content,
    }));
    if (!metadata.ok) return refuse(metadata.error);
    return { ...current, metadata, preferences };
}
