import * as React from 'react';
import type { ProjectAccountWorkspaceRefKeyV1 } from '@happier-dev/protocol/projects/workspaceRefKeyV1';
import { readScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { findWorkspaceProjectCandidatesV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { scmStatusSync } from '@/scm/scmStatusSync';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useWorkspaceRefs, useWorkspaceScmSummarySnapshot } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useProjectSource } from './useProjectSources';

/** Source suggestions select admitted refs; SCM alone supplies the branch and immutable base. */
export function useProjectSourceWorkspaceChoice(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    sourceId: string;
    value: ProjectAccountWorkspaceRefKeyV1 | null;
    /** Repository creation places work in a checkout the person explicitly selects from their admitted census. */
    destination?: boolean;
    /** A repository resolved by the Source address owner before it is attached to this Source. */
    repository?: ScmHostingRepositoryIdentityV1;
}>) {
    const read = useProjectSource(input.lifetime, input.sourceId);
    const source = read.source?.source ?? null;
    const refs = useWorkspaceRefs();
    const repository = input.repository ?? (source?.repository ? readScmHostingRepositoryIdentity({ ...source.repository.provider,
        nameWithOwner: source.repository.repository.nameWithOwner }) : null);
    const candidates = React.useMemo(() => input.destination ? refs : source ? findWorkspaceProjectCandidatesV1(refs, {
        serverId: input.lifetime.scope.serverId, source: { sourceId: source.id, revision: source.revision },
        ...(repository ? { repositoryIdentity: repository } : {}),
    }, { normalizeServerId: resolveServerProfileScopeIdForIdentifier }) : [],
    [refs, source, input.destination, input.lifetime.scope.serverId, repository?.kind, repository?.deployment, repository?.repository]);
    const selectedKey = input.value;
    const selected = selectedKey ? resolveWorkspaceRefV1(candidates, selectedKey,
        { normalizeServerId: resolveServerProfileScopeIdForIdentifier }) : null;
    const workspace = selected?.kind === 'resolved' ? selected.ref : null;
    const scope = React.useMemo(() => workspace ? { serverId: workspace.serverId, machineId: workspace.machineId,
        rootPath: workspace.rootPath } : null, [workspace?.serverId, workspace?.machineId, workspace?.rootPath]);
    const snapshot = useWorkspaceScmSummarySnapshot(scope);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const refresh = async () => {
        if (!scope || loading) return;
        setLoading(true); setError(null);
        try { await scmStatusSync.invalidateFromUserAndAwait(scope); }
        catch { setError('repository_read_failed'); }
        finally { setLoading(false); }
    };
    return { source, status: read.status, issue: read.issue, repository, candidates, workspace,
        baseCommit: snapshot?.branch.headOid ?? null, baseBranch: snapshot?.branch.head ?? null, refresh, loading, error };
}

export function ProjectSourceWorkspaceChoice(props: Readonly<{
    model: ReturnType<typeof useProjectSourceWorkspaceChoice>;
    value: ProjectAccountWorkspaceRefKeyV1 | null;
    onChange: (value: ProjectAccountWorkspaceRefKeyV1) => void;
    testID: string;
    disabled?: boolean;
    showBase?: boolean;
}>) {
    const [open, setOpen] = React.useState(false);
    const { model, testID } = props;
    const copy = 'projects.deployments.settingsSections.moveToRepository' as const;
    return <>
        <DropdownMenu testID={testID} open={open} onOpenChange={setOpen}
            selectedId={model.workspace ? `${model.workspace.serverId}:${model.workspace.id}` : ''}
            items={model.candidates.map(ref => ({ id: `${ref.serverId}:${ref.id}`, title: ref.label ?? ref.rootPath,
                subtitle: ref.rootPath }))}
            onSelect={id => {
                setOpen(false);
                const selected = model.candidates.find(ref => `${ref.serverId}:${ref.id}` === id);
                if (selected) props.onChange({ kind: 'workspace-ref', serverId: selected.serverId, id: selected.id });
            }}
            itemTrigger={{ title: t(`${copy}.workspace`), placeholder: t(`${copy}.workspacePlaceholder`),
                itemProps: { disabled: props.disabled } }} />
        {model.workspace && props.showBase !== false ? <Item title={model.baseBranch ?? t(`${copy}.workspace`)}
            subtitle={model.baseCommit ?? t(`${copy}.baseMissing`)} showChevron={false}
            rightElement={<SectionActionButton testID={`${testID}.refresh`} title={t(`${copy}.refresh`)} icon="arrows-clockwise"
                disabled={props.disabled || model.loading} onPress={() => { void model.refresh(); }} />} />
            : model.status === 'ready' && model.candidates.length === 0
                ? <SurfaceStateCard testID={`${testID}.empty`} size="line" kind="empty" title={t(`${copy}.workspaceMissing`)} /> : null}
        {model.error ? <SurfaceStateCard size="line" kind="error" title={t(`${copy}.sourceFailed`)} diagnosticCode={model.error} /> : null}
    </>;
}
