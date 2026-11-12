import * as React from 'react';
import type { DeploymentEnvironmentDefinitionV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentReadDemandV1 } from '@happier-dev/deployments';
import type { ScmLogListResponse, ScmRevisionRangeV1 } from '@happier-dev/protocol/scm';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';
import { machineScmLogList } from '@/sync/ops/scm/machineScm';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { storedComposeDocumentText } from './storedComposeDocumentText';

type Props = Readonly<{
  source: DeploymentSourceIntentV1;
  current: DeploymentEnvironmentDefinitionV1 | null;
  workspaceRef?: WorkspaceRefV1 | null;
  serverId: string;
  accountId: string;
  demand: DeploymentReadDemandV1;
}>;

/** Definitions stay in their protected receipt; repository comparison stays with the SCM reader/viewer. */
export function DeploymentVersionComparison(props: Props) {
  if (props.source.kind === 'stored') return <StoredDefinitionHistory source={props.source}
    current={props.current?.kind === 'stored' ? props.current : null} />;
  return <RepositoryComparison key={`${props.serverId}:${props.accountId}:${props.source.projectSourceId}:${props.source.sourceRevision}:${props.source.sha}:${props.workspaceRef?.id}:${props.workspaceRef?.source?.sourceId}:${props.workspaceRef?.source?.revision}:${props.current?.kind === 'repository' ? props.current.ref : ''}`}
    {...props} source={props.source} />;
}

function StoredDefinitionHistory(props: Readonly<{
  source: Extract<DeploymentSourceIntentV1, { kind: 'stored' }>;
  current: Extract<DeploymentEnvironmentDefinitionV1, { kind: 'stored' }> | null;
}>) {
  const [compare, setCompare] = React.useState(false);
  const { source, current } = props;
  const different = current !== null && source.contentRevision !== current.contentRevision;
  const currentFiles = new Map(current?.publicFiles?.map(file => [file.path, file.content]) ?? []);
  const deployedFiles = new Map(source.publicFiles?.map(file => [file.path, file.content]) ?? []);
  const filePaths = [...new Set([...deployedFiles.keys(), ...currentFiles.keys()])];
  return <ItemGroup title={t('projects.deployments.editors.versionDeployed')}
    testID="project-deployments.receipt.definition"
    description={t('projects.deployments.review.versionStored', { revision: source.contentRevision })}
    action={different ? <SectionActionButton testID="project-deployments.receipt.definition.compare"
      icon="git-diff" title={t('projects.scripts.definition.compare')} onPress={() => setCompare(value => !value)} /> : undefined}>
    <DefinitionSelectors definition={source} />
    <CodeBlockView code={storedComposeDocumentText(source.document)} language="yaml" showHeaderRow={false} showCopyButton wrap />
    {source.publicFiles?.map(file => <ItemGroup key={file.path} title={file.path} surface="none">
      <CodeBlockView code={file.content} showHeaderRow={false} showCopyButton wrap />
    </ItemGroup>)}
    {compare && current ? <ItemGroup title={t('projects.deployments.editors.versionCurrent')}
      description={t('projects.deployments.review.versionStored', { revision: current.contentRevision })} surface="none">
      <DefinitionSelectors definition={current} />
      <DiffViewer mode="text" oldText={storedComposeDocumentText(source.document)} newText={storedComposeDocumentText(current.document)} filePath="compose.yaml" wrapLines />
      {filePaths.filter(path => deployedFiles.get(path) !== currentFiles.get(path)).map(path => <ItemGroup key={path} title={path} surface="none">
        <DiffViewer mode="text" oldText={deployedFiles.get(path) ?? ''} newText={currentFiles.get(path) ?? ''} filePath={path} wrapLines />
      </ItemGroup>)}
    </ItemGroup> : null}
  </ItemGroup>;
}

function DefinitionSelectors({ definition }: Readonly<{ definition: Extract<DeploymentSourceIntentV1, { kind: 'stored' }> }>) {
  return <>
    <Item title={t('projects.deployments.editors.definitionServices')} detail={definition.services.join(', ') || t('common.all')} showChevron={false} />
    <Item title={t('projects.deployments.editors.definitionProfiles')} detail={definition.profiles.join(', ') || t('common.none')} showChevron={false} />
    {definition.primaryService ? <Item title={t('projects.deployments.editors.definitionPrimaryService')} detail={definition.primaryService} showChevron={false} /> : null}
  </>;
}

function RepositoryComparison(props: Props & Readonly<{ source: Extract<DeploymentSourceIntentV1, { kind: 'repository' }> }>) {
  const router = useRouter();
  const [refresh, setRefresh] = React.useState(0);
  const [comparison, setComparison] = React.useState<Readonly<{ range: ScmRevisionRangeV1; history: ScmLogListResponse }> | null>(null);
  const [pending, setPending] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const workspace = props.workspaceRef;
  const machineId = workspace?.machineId;
  const rootPath = workspace?.rootPath;
  const sourceRef = props.current?.kind === 'repository' ? props.current.ref : null;
  React.useEffect(() => {
    if (!machineId || !rootPath || !sourceRef || !props.demand.mounted || !props.demand.visible) return;
    const abort = new AbortController();
    const options = { serverId: props.serverId, accountId: props.accountId, signal: abort.signal };
    setPending(true);
    setComparison(null);
    void (async () => {
      try {
        const history = await machineScmLogList(machineId, { cwd: rootPath,
          revisionRangeFromRef: { baseOid: props.source.sha, headRef: sourceRef } }, options);
        if (abort.signal.aborted) return;
        if (!history.success) { setUnavailable(true); return; }
        const echoed = history.revisionRange;
        if (!echoed || echoed.baseOid !== props.source.sha || echoed.headRef !== sourceRef) { setUnavailable(true); return; }
        const range: ScmRevisionRangeV1 = { kind: 'revisionRange', baseOid: echoed.baseOid, headOid: echoed.headOid };
        setComparison({ range, history });
        setUnavailable(false);
      } catch {
        if (!abort.signal.aborted) setUnavailable(true);
      } finally {
        if (!abort.signal.aborted) setPending(false);
      }
    })();
    return () => abort.abort();
  }, [machineId, rootPath, sourceRef, props.source.sha, props.serverId, props.accountId, props.demand.mounted, props.demand.visible, refresh]);
  const history = comparison?.history.success ? comparison.history.revisionRange : null;
  const proven = history?.historyComplete === true;
  const subtitle = unavailable || !workspace || !sourceRef ? t('projects.deployments.editors.comparisonNeedsCheckout')
    : proven && history.graphRelation === 'forward' && history.totalCount !== undefined
      ? t('projects.deployments.editors.commitsNewer', { count: history.totalCount })
      : proven && history.graphRelation === 'equal' ? t('projects.deployments.editors.sameVersion')
      : proven && history.graphRelation === 'diverged' ? t('projects.deployments.editors.versionsDiffer')
      : pending ? t('common.loading') : t('projects.deployments.editors.comparisonUnavailable');
  return <ItemGroup testID="project-deployments.comparison" title={t('projects.deployments.review.version')}
    action={workspace ? <SectionActionButton testID="project-deployments.comparison.refresh" icon="arrows-clockwise" title={t('common.refresh')}
      disabled={pending} onPress={() => setRefresh(value => value + 1)} /> : undefined}>
    <Item testID="project-deployments.comparison.status" title={props.source.sha.slice(0, 7)} subtitle={subtitle}
      detail={comparison?.range.headOid.slice(0, 7)} showChevron={comparison !== null}
      onPress={comparison && workspace ? () => router.push(buildProjectRouteHref({ workspaceRefId: workspace.id,
        serverId: props.serverId, segment: 'changes', activeRootPath: workspace.rootPath, defaultRootPath: workspace.rootPath,
        details: { kind: 'scmReview', comparison: comparison.range, view: 'files', explain: false } }) as never) : undefined} />
    {unavailable || !workspace ? <Item testID="project-deployments.comparison.checkout" title={t('projects.deployments.editors.openSourceCheckout')}
      onPress={() => router.push(projectSourceRoute(props.source.projectSourceId) as never)} /> : null}
  </ItemGroup>;
}
