import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { composeWidgetGroupContextV1, type WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { PluginUiHostApiSurfaceTargetV1 } from '@happier-dev/protocol/plugins/ui';
import { normalizeScmHostingRepositoryIdentity, readScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { createPluginUiProjectPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy/projectContext';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type ProjectSurfaceTargetV1 = Extract<PluginUiHostApiSurfaceTargetV1, { kind: 'project' }>;
export type ProjectScmContextSnapshotV1 = Pick<ScmWorkingSnapshot, 'hostingProvider'> & Partial<Pick<ScmWorkingSnapshot, 'branch'>>;
type RepositoryInput =
    | Readonly<{ kind: 'source' | 'observed'; provider: Pick<NonNullable<ScmWorkingSnapshot['hostingProvider']>, 'kind' | 'baseUrl' | 'nameWithOwner'> | null }>
    | Readonly<{ kind: 'retained'; repository: ScmHostingRepositoryIdentityV1 | null }>;
export type ProjectWidgetAreaContextInputV1 = Readonly<{
    serverId: string;
    /** Values admitted at the Account/route/Action boundary; projection never re-parses them. */
    projectRef?: WorkspaceRefV1 | null;
    activeCheckout?: WorkspaceRefV1 | null;
    source?: Readonly<{ serverId: string; source: ProjectSourceV1 }> | null;
    /** Null means unloaded. A present snapshot with no provider is observed absence. */
    snapshot?: ProjectScmContextSnapshotV1 | null;
    /** The caller's existing Account lifetime, never a new generation or global cache key. */
    authority?: Readonly<{ isCurrent(): boolean }> | null;
}>;
export type ProjectWidgetAreaContextV1 = Readonly<{
    status: 'ready' | 'unavailable'; reasonCode?: 'widget_project_source_unavailable'; sourceId: string | null;
    projectIdentity: Readonly<{ serverId: string; projectKey: string }> | null;
    target: ProjectSurfaceTargetV1 | null;
    providedContext: WidgetBindingResolutionInputV1['context'];
    policyContext: PluginUiPolicyEvaluationContext;
    /** Private baseline bookkeeping, not public surface content. */
    scope: Readonly<{ serverId: string; projectKey: string | null; authority: Readonly<{ isCurrent(): boolean }> | null }>;
    /** Producer-owned admission bookkeeping; accepting equal facts does not publish a new semantic value. */
    inputBasis: { repository: RepositoryInput };
}>;

function reconcileCheckout(previous: WorkspaceRefV1 | undefined, value: WorkspaceRefV1): WorkspaceRefV1 {
    return previous?.id === value.id ? retainDeep(previous, value) : value;
}

function reconcileSource(previous: ProjectSourceV1 | undefined, value: ProjectSourceV1): ProjectSourceV1 {
    return previous?.id === value.id ? retainDeep(previous, value) : value;
}

/** Logical Source facts win; checkout metadata is fallback only while its observation is unloaded. */
export function readProjectRepositoryIdentityV1(input: Readonly<{
    source?: ProjectSourceV1 | null; checkout?: WorkspaceRefV1 | null; snapshot?: Pick<ScmWorkingSnapshot, 'hostingProvider'> | null;
}>): ScmHostingRepositoryIdentityV1 | null {
    const source = input.source;
    if (source) return source.repository
        ? readScmHostingRepositoryIdentity({ ...source.repository.provider, nameWithOwner: source.repository.repository.nameWithOwner }) : null;
    if (input.snapshot) return readScmHostingRepositoryIdentity(input.snapshot.hostingProvider);
    return normalizeScmHostingRepositoryIdentity(input.checkout?.repositoryIdentity);
}

/** One admitted Project projection supplies pages, companions, widgets, policy and listing. */
export function readProjectWidgetAreaContextV1(input: ProjectWidgetAreaContextInputV1,
    previous?: ProjectWidgetAreaContextV1 | null): ProjectWidgetAreaContextV1 {
    const serverId = resolveServerProfileScopeIdForIdentifier(input.serverId);
    const qualify = (value: WorkspaceRefV1 | null | undefined) => value && areServerProfileIdentifiersEquivalent(value.serverId, serverId)
        ? value.serverId === serverId ? value : { ...value, serverId } : null;
    const projectRef = input.authority && !input.authority.isCurrent() ? null
        : qualify(input.projectRef === undefined ? input.activeCheckout : input.projectRef);
    const selected = qualify(input.activeCheckout);
    const acceptedCheckout = projectRef && selected && sameWorkspaceProject(projectRef, selected) ? selected : null;
    const identity = projectRef ? projectWorkspaceRefV1(projectRef) : null;
    const baseline = previous?.scope.serverId === serverId && previous.scope.projectKey === (identity?.projectKey ?? null)
        && previous.scope.authority === (input.authority ?? null) ? previous : undefined;
    const projectIdentity = identity && baseline?.projectIdentity?.projectKey === identity.projectKey ? baseline.projectIdentity : identity;
    const checkout = acceptedCheckout ? reconcileCheckout(baseline?.target?.checkout, acceptedCheckout) : undefined;
    // An accepted checkout selects its own Source; another anchor cannot lend its provenance.
    const sourceId = (acceptedCheckout ?? projectRef)?.source?.sourceId ?? null;
    const acceptedSource = projectIdentity && input.source?.source.id === sourceId
        && areServerProfileIdentifiersEquivalent(input.source.serverId, serverId) ? input.source.source : null;
    const sourceValue = acceptedSource ? reconcileSource(baseline?.target?.source?.source, acceptedSource) : null;
    const source = sourceValue ? baseline?.target?.source?.source === sourceValue ? baseline.target.source
        : { serverId, source: sourceValue } : undefined;
    const observation = checkout ? input.snapshot : null;
    const branch = observation?.branch && !observation.branch.detached && observation.branch.head?.trim()
        ? observation.branch.head : undefined;
    const provider = sourceValue ? sourceValue.repository
        ? { ...sourceValue.repository.provider, nameWithOwner: sourceValue.repository.repository.nameWithOwner } : null
        : observation?.hostingProvider;
    const repositoryInput: RepositoryInput = retainDeep(baseline?.inputBasis.repository, sourceValue || observation
        ? { kind: sourceValue ? 'source' : 'observed', provider: provider ? {
            kind: provider.kind, baseUrl: provider.baseUrl, nameWithOwner: provider.nameWithOwner,
        } : null }
        : { kind: 'retained', repository: (checkout ?? projectRef)?.repositoryIdentity ?? null });
    const repository = baseline?.inputBasis.repository === repositoryInput ? baseline.target?.repository
        : retainDeep(baseline?.target?.repository, readProjectRepositoryIdentityV1({
            source: sourceValue, checkout: checkout ?? projectRef, snapshot: checkout ? input.snapshot : undefined,
        }) ?? undefined);
    const target = projectIdentity ? baseline?.target && baseline.target.source === source && baseline.target.checkout === checkout
        && baseline.target.repository === repository && baseline.target.branch === branch ? baseline.target : {
            kind: 'project' as const, projectKey: projectIdentity.projectKey,
            ...(source ? { source } : {}), ...(checkout ? { checkout } : {}), ...(repository ? { repository } : {}),
            ...(branch ? { branch } : {}),
        } : null;
    const old = baseline?.providedContext;
    const oldProject = old?.project?.[0];
    const qualifiedSource = source ? baseline?.target?.source === source && oldProject !== undefined
        ? oldProject : { serverId, ...source.source } : undefined;
    const projectSlot = qualifiedSource === old?.project?.[0] && old?.project ? old.project : qualifiedSource ? [qualifiedSource] : [];
    const checkoutSlot = checkout === old?.checkout?.[0] && old?.checkout ? old.checkout : checkout ? [checkout] : [];
    const projectsSlot = baseline && projectIdentity === baseline.projectIdentity ? old!.projects! : projectIdentity
        ? composeWidgetGroupContextV1({ providedContext: {}, surfaceOwner: { kind: 'project', projectId: projectIdentity.projectKey } }).projects! : [];
    const providedContext = old && old.project === projectSlot && old.checkout === checkoutSlot && old.projects === projectsSlot
        ? old : { project: projectSlot, checkout: checkoutSlot, projects: projectsSlot };
    const policyContext = createPluginUiProjectPolicyEvaluationContext(undefined, target, baseline?.policyContext);
    if (baseline && baseline.target === target && baseline.providedContext === providedContext && baseline.policyContext === policyContext
        && baseline.sourceId === sourceId) {
        baseline.inputBasis.repository = repositoryInput;
        return baseline;
    }
    return { status: source ? 'ready' : 'unavailable', ...(!source ? { reasonCode: 'widget_project_source_unavailable' as const } : {}),
        sourceId, projectIdentity, target, providedContext, policyContext,
        scope: baseline?.scope ?? { serverId, projectKey: projectIdentity?.projectKey ?? null, authority: input.authority ?? null }, inputBasis: { repository: repositoryInput } };
}
