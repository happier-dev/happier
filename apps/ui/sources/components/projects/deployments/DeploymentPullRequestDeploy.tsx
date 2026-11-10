import * as React from 'react';
import { ScmPullRequestReferenceSchema, type ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';
import { type DeploymentSourceIntentV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { GitPullRequestCard } from '@/components/sessions/panes/git/pullRequest/GitPullRequestCard';
import { machineScmPullRequestGet } from '@/sync/ops/scm/machineScm';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';

type RepositorySource = Extract<DeploymentSourceIntentV1, { kind: 'repository' }>;

/** The SCM reader selects the displayed head. Deploy admission still fetches and verifies that exact base-repository PR head. */
export function DeploymentPullRequestDeploy(props: Readonly<{
  workspaceRef?: WorkspaceRefV1 | null;
  projectSourceId: string;
  sourceRevision: number | null;
  compose: RepositorySource['compose'];
  serverId: string;
  accountId: string;
  disabled: boolean;
  onDeploy(source: RepositorySource): Promise<void>;
}>) {
  const router = useRouter();
  const [reference, setReference] = React.useState('');
  const [candidate, setCandidate] = React.useState<Readonly<{ pullRequest: ScmPullRequestSummary; source: RepositorySource | null }> | null>(null);
  const [pending, setPending] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const read = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => read.current?.abort(), []);
  const workspace = props.workspaceRef;
  const parsedReference = ScmPullRequestReferenceSchema.safeParse({ number: Number(reference) });
  const exactSource = candidate?.source ?? null;
  const pullRequest = candidate?.pullRequest ?? null;
  const load = async () => {
    if (!workspace || !parsedReference.success) return;
    const abort = new AbortController();
    read.current = abort;
    setPending(true);
    setUnavailable(false);
    try {
      const result = await machineScmPullRequestGet(workspace.machineId, { cwd: workspace.rootPath, prReference: parsedReference.data },
        { serverId: props.serverId, accountId: props.accountId, signal: abort.signal });
      if (abort.signal.aborted) return;
      const pullRequest = result.success ? result.pullRequest : null;
      const source: RepositorySource | null = pullRequest?.headSha && pullRequest.number && props.sourceRevision !== null ? {
        kind: 'repository', projectSourceId: props.projectSourceId, sourceRevision: props.sourceRevision,
        sha: pullRequest.headSha, pullRequestHead: { number: pullRequest.number }, ...(props.compose ? { compose: props.compose } : {}),
      } : null;
      setCandidate(pullRequest ? { pullRequest, source } : null);
      setUnavailable(!result.success || result.pullRequest === null);
    } catch { if (!abort.signal.aborted) { setCandidate(null); setUnavailable(true); } }
    finally { if (!abort.signal.aborted) setPending(false); }
  };
  return <ItemGroup testID="project-deployments.pr" title={t('projects.deployments.editors.pullRequest')}>
    {workspace ? <>
      <FieldItem label={t('projects.deployments.editors.pullRequestNumber')}>
        <FieldTextInput testID="project-deployments.pr.number" accessibilityLabel={t('projects.deployments.editors.pullRequestNumber')}
          value={reference} keyboardType="number-pad" editable={!pending}
          onChangeText={value => { setReference(value); setCandidate(null); setUnavailable(false); }} />
      </FieldItem>
      <Item testID="project-deployments.pr.load" title={t('projects.deployments.editors.loadPrHead')}
        subtitle={pending ? t('common.loading') : undefined} disabled={pending || !parsedReference.success} onPress={() => { void load(); }} />
      {pullRequest ? <GitPullRequestCard model={{ number: pullRequest.number ?? null, title: pullRequest.title, url: pullRequest.url,
        base: pullRequest.baseBranch, state: pullRequest.state, checks: pullRequest.checks?.state ?? null,
        providerKind: pullRequest.provider.kind, providerName: pullRequest.provider.displayName }} serverId={props.serverId} /> : null}
      {pullRequest?.headSha ? <Item testID="project-deployments.pr.deploy" title={t('projects.deployments.editors.deployPrHead')}
        subtitle={pullRequest.headSha} disabled={props.disabled || pending || exactSource === null}
        onPress={() => { if (exactSource) void props.onDeploy(exactSource); }} /> : null}
      {unavailable || candidate && exactSource === null ? <Item testID="project-deployments.pr.unavailable"
        title={t('projects.deployments.editors.prUnavailable')} showChevron={false} /> : null}
    </> : <Item testID="project-deployments.pr.checkout" title={t('projects.deployments.editors.openSourceCheckout')}
      subtitle={t('projects.deployments.editors.comparisonNeedsCheckout')} onPress={() => router.push(projectSourceRoute(props.projectSourceId) as never)} />}
  </ItemGroup>;
}
