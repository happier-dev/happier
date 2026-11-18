import * as React from 'react';
import type { DeploymentEnvironmentDefinitionV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { DeploymentSourceCheckoutRow, useOwnSourceCheckout } from './DeploymentSourceCheckoutRow';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { storedComposeDocumentText } from './storedComposeDocumentText';
import { useDeploymentRepositoryComparison, type DeploymentRepositoryComparisonInput, type DeploymentRepositoryComparisonState } from './useDeploymentRepositoryComparison';

type Props = Readonly<{
  source: DeploymentSourceIntentV1;
  current: DeploymentEnvironmentDefinitionV1 | null;
  /** The commit the platform observed building (Git integrations build the branch head, which may be newer). */
  builtSha?: string | undefined;
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
    {/* Code scrolls sideways, never wraps mid-token (D24: "postgres-⏎data:" read as two keys on a phone). */}
    <CodeBlockView code={storedComposeDocumentText(source.document)} language="yaml" showHeaderRow={false} showCopyButton />
    {source.publicFiles?.map(file => <ItemGroup key={file.path} title={file.path} surface="none">
      <CodeBlockView code={file.content} showHeaderRow={false} showCopyButton />
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

function RepositoryComparison(props: DeploymentRepositoryComparisonInput & Readonly<{ builtSha?: string | undefined }>) {
  const comparisonState = useDeploymentRepositoryComparison(props);
  return <DeploymentRepositoryComparisonView {...props} comparisonState={comparisonState} />;
}

/** Lift the hook once to share its newer-commit fact with Overview and this Compare presenter. */
export function DeploymentRepositoryComparisonView(props: DeploymentRepositoryComparisonInput & Readonly<{
  comparisonState: DeploymentRepositoryComparisonState;
  builtSha?: string | undefined;
}>) {
  const router = useRouter();
  const { comparison, history, proven, pending, unavailable, unreadable, newerCommitCount, refresh } = props.comparisonState;
  const workspace = props.workspaceRef;
  const ownCheckout = useOwnSourceCheckout(props.source.projectSourceId, props.serverId);
  const machineIds = React.useMemo(() => workspace ? [workspace.machineId] : [], [workspace]);
  const machineName = useMachineDisplayNamesById(machineIds)[workspace?.machineId ?? ''];
  const sourceRef = props.current?.kind === 'repository' ? props.current.ref : null;
  // A page opened without a checkout says where one is; a checkout that exists but can't be read says so, with Refresh,
  // never "open a checkout" (VISUAL-136 D9).
  const subtitle = !workspace ? (ownCheckout ? t('projects.deployments.editors.compareInCheckout') : t('projects.deployments.editors.comparisonNeedsCheckout'))
    : unreadable ? t('projects.deployments.editors.checkoutUnreadable', { machine: machineName ?? workspace.rootPath })
    : !sourceRef ? (props.current === null ? t('common.loading') : t('projects.deployments.editors.comparisonUnavailable'))
    : proven && history?.graphRelation === 'forward' && newerCommitCount !== null
      ? t('projects.deployments.editors.commitsNewer', { count: newerCommitCount })
      : proven && history?.graphRelation === 'equal' ? t('projects.deployments.editors.sameVersion')
      : proven && history?.graphRelation === 'diverged' ? t('projects.deployments.editors.versionsDiffer')
      : pending ? t('common.loading') : t('projects.deployments.editors.comparisonUnavailable');
  return <ItemGroup testID="project-deployments.comparison" title={t('projects.deployments.review.version')}
    action={workspace ? <SectionActionButton testID="project-deployments.comparison.refresh" icon="arrows-clockwise" title={t('common.refresh')}
      disabled={pending} onPress={refresh} /> : undefined}>
    <Item testID="project-deployments.comparison.status" title={props.source.sha.slice(0, 7)} subtitle={subtitle}
      detail={comparison?.range.headOid.slice(0, 7)} showChevron={comparison !== null}
      onPress={comparison && workspace ? () => router.push(buildProjectRouteHref({ workspaceRefId: workspace.id,
        serverId: props.serverId, segment: 'changes', activeRootPath: workspace.rootPath, defaultRootPath: workspace.rootPath,
        details: { kind: 'scmReview', comparison: comparison.range, view: 'files', explain: false } }) as never) : undefined} />
    {/* A Git-integration platform builds the branch head when it runs, so it can build a newer commit than the one asked for. */}
    {props.builtSha && props.builtSha !== props.source.sha && sourceRef ? <Item testID="project-deployments.comparison.built"
      title={t('projects.deployments.editors.builtNewer', { sha: props.builtSha.slice(0, 7), branch: sourceRef })} showChevron={false} /> : null}
    {!workspace || (unavailable && !unreadable) ? <DeploymentSourceCheckoutRow testID="project-deployments.comparison.checkout"
      projectSourceId={props.source.projectSourceId} serverId={props.serverId} checkout={workspace ? null : ownCheckout} /> : null}
  </ItemGroup>;
}
