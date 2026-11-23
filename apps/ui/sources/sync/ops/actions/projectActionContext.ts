import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { canUsePrivateProjectAccountAction, createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';

import type { LazyActionAccountContext } from './actionAccountContext';

function refused(errorCode: string) { return { ok: false as const, errorCode, error: errorCode }; }

/** Account-admitted Project facts shared by page discovery and widget Actions. */
export async function readProjectActionContext(
    account: LazyActionAccountContext,
    target: Readonly<{ serverId: string } & ({ workspaceRefId: string } | { projectKey: string })>,
    context?: ActionExecutorContext,
    options?: Readonly<{ readSource: boolean }>,
) {
    if (!canUsePrivateProjectAccountAction(account, context)) return refused('project_account_access_denied');
    if (!areServerProfileIdentifiersEquivalent(target.serverId, account.serverId)) return refused('server_scope_mismatch');
    context?.signal?.throwIfAborted();
    account.assertCurrent();
    const rows = await createUiProjectAccountRowsClient(account).read(context?.signal);
    context?.signal?.throwIfAborted();
    account.assertCurrent();
    if (rows.status !== 'ready') return refused('project_account_rows_unavailable');
    const exact = 'workspaceRefId' in target;
    const resolution = exact ? resolveWorkspaceRefById(rows.workspaceRefs, target.workspaceRefId, account.serverId) : null;
    if (resolution && resolution.kind !== 'resolved') return refused(resolution.kind === 'missing' ? 'workspace_not_found' : 'workspace_resolution_unavailable');
    // A logical Project uses its established group anchor, not a reachable or
    // recently used checkout. Only an exact route supplies checkout/branch facts.
    const ref = resolution?.kind === 'resolved' ? resolution.ref : !exact
        ? buildProjectGroupDisplayIndex(rows.workspaceRefs).get(projectGroupIdentityKey({ serverId: account.serverId, projectKey: target.projectKey }))?.baseline
        : null;
    if (!ref) return refused('workspace_not_found');
    const snapshot = exact ? storage.getState().getWorkspaceScmSnapshot(workspaceScopeFromProject(ref, ref.rootPath)) : null;
    const facts = { serverId: account.serverId, projectRef: ref, activeCheckout: exact ? ref : null, snapshot, authority: account.accountLifetime };
    let projectContext = readProjectWidgetAreaContextV1(facts);
    if (options?.readSource !== false && projectContext.sourceId) {
        const source = await createProjectSourceActionDeps(account).projectSourcesRead({ serverId: account.serverId, sourceId: projectContext.sourceId }, context);
        if (source.ok) projectContext = readProjectWidgetAreaContextV1({ ...facts,
            source: { serverId: account.serverId, source: source.source } }, projectContext);
    }
    context?.signal?.throwIfAborted();
    account.assertCurrent();
    return { ok: true as const, ref, projectContext };
}
