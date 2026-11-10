import { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectReadinessFactOutcomeV1Schema, type ProjectReadinessFactOutcomeV1 } from '@happier-dev/protocol/projects/readinessV1';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { normalizeScmHostingRepositoryIdentity, ScmHostingRepositoryIdentityV1Schema } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectPluginActionFailureCode } from '@happier-dev/protocol/plugins/actions/invocation';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ExecuteScmSourceReadAction } from './resolveRefForHost';

const resultSchema = z.object({ repository: ScmHostingRepositoryIdentityV1Schema,
    ci: ProjectReadinessFactOutcomeV1Schema, security: ProjectReadinessFactOutcomeV1Schema });
const unavailable = (reason: string): ProjectReadinessFactOutcomeV1 => ({ status: 'unavailable', reason });
const unavailableSources = (reason: string) => ({ ci: unavailable(reason), security: unavailable(reason) });

/** Providers own source presence; this adapter binds their projection to the saved Project repository. */
export async function readScmHostingProjectReadinessForHost(input: Readonly<{
    repository?: ProjectSourceRepositorySelectorV1; context: ActionExecutorContext;
    acquireRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    executeSourceReadAction?: ExecuteScmSourceReadAction;
}>): Promise<Readonly<{ ci: ProjectReadinessFactOutcomeV1; security: ProjectReadinessFactOutcomeV1 }>> {
    const selectedRepository = input.repository;
    if (!selectedRepository) return { ci: { status: 'actionNeeded', reason: 'project_repository_required' },
        security: { status: 'actionNeeded', reason: 'project_repository_required' } };
    if (!input.acquireRuntimeRegistryLease || !input.executeSourceReadAction)
        return unavailableSources('project_source_projection_unavailable');
    try {
        const lease = await input.acquireRuntimeRegistryLease();
        try {
            const provider = lease.registry.contributes.scmHostingProviders?.find(entry => entry.pluginId
                && `${entry.pluginId}/${entry.definition.id}` === selectedRepository.provider.id);
            if (!provider?.pluginId || !provider.definition.projectReadinessAction)
                return unavailableSources('project_source_projection_unavailable');
            const action = { pluginId: provider.pluginId, localId: provider.definition.projectReadinessAction };
            const declaration = readResolvedActionContribution(lease.registry.contributes, action);
            if (declaration?.definition.dangerLevel !== 'safe' || declaration.definition.readOnly !== true
                || declaration.definition.execution?.target !== 'account')
                return unavailableSources('project_source_projection_unavailable');
            const repository = normalizeScmHostingRepositoryIdentity({ kind: selectedRepository.provider.kind,
                deployment: selectedRepository.provider.baseUrl, repository: selectedRepository.repository.nameWithOwner });
            if (!repository) return unavailableSources('project_repository_invalid');
            const result = await input.executeSourceReadAction(action, { repository }, input.context);
            input.context.signal?.throwIfAborted();
            if (!result.ok) return unavailableSources(projectPluginActionFailureCode(result.errorCode));
            const resolved = resultSchema.safeParse(result.result);
            if (!resolved.success) return unavailableSources('project_source_projection_invalid');
            if (!sameStrictJsonValue(resolved.data.repository, repository))
                return unavailableSources('project_source_repository_mismatch');
            return { ci: resolved.data.ci, security: resolved.data.security };
        } finally { await lease.release(); }
    } catch (error) {
        input.context.signal?.throwIfAborted();
        return unavailableSources(readRpcErrorCode(error) ?? 'project_source_projection_unavailable');
    }
}
