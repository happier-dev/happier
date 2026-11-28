import { readProjectSourceRepositoryIdentityV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { UnboundSessionHomeScopeCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  COLLECTION_RAIL_MIN_WIDTH_PX,
  HappierListDetailLayout,
} from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/advanced';
import {
  resolveDeploymentEnvironmentDestinationV1,
  type DeploymentEnvironmentDestinationV1,
  type DeploymentReadDemandV1,
} from '@happier-dev/deployments';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useProjectPageBack } from '@/components/projects/detail/projectPageBack';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { CollectionDraftTitleScope } from '@/components/ui/lists/collection/CollectionDraftTitle';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { DeploymentEnvironmentRows, SERVICES_APPS_COLUMNS_BINDING } from './DeploymentEnvironmentRows';
import { useCollectionRailWidth } from '@/components/ui/lists/collection/useCollectionRailWidth';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePageSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { DeploymentEnvironmentCollectionV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

import { useProjectSaveAsSource } from '../ProjectSaveAsSourceSheet';
import { useProjectsSourcesComposition } from '../useProjectsSourcesComposition';
import { useOpenNewApp } from '../starters/newAppPresentation';
import { DeploymentEnvironmentCollection, environmentAfterDelete, isDeploymentEnvironmentRemoved } from './DeploymentEnvironmentCollection';
import { ProjectDeploymentDefaultsSettings } from './ProjectDeploymentDefaultsSettings';
import { DeploymentPreparationEntry } from './DeploymentPreparation';
import { Button } from '@happier-dev/plugin-ui/components';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { DeploymentEnvironmentDetail, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { DeploymentEnvironmentDraft } from './DeploymentEnvironmentDraft';
import { DeploymentReceiptDetail } from './DeploymentReceiptDetail';
import { projectSourceRoute } from '@/components/projects/sources/ProjectSourcesScreen';
import { DeploymentDatabasePage } from './DeploymentDatabasePage';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { buildDeploymentEnvironmentHref, DEPLOYMENT_NEW_REPOSITORY_DRAFT, ENVIRONMENT_AUTOMATIONS_DESTINATION } from './deploymentNavigation';
import { useDeploymentProjectRoute, type useDeploymentProject } from './useDeploymentProject';
import { useDeploymentCollection } from './useDeploymentReads';
import { useOpenDeploymentRecoveryDestination } from './deploymentRecoveryNavigation';
import { deploymentReadIssue } from './deploymentPresentation';
import { useProjectSource } from '../sources/useProjectSources';

/** The narrowest Environment detail that keeps its header facts beside the title. */
const DEPLOYMENTS_DETAIL_MIN_WIDTH_PX = 480;

type Selection = Readonly<{
  environmentId: string | null;
  deploymentId: string | null;
  /** One of the Environment's databases, pushed in place like a receipt. */
  database?: string | null;
  /** A new Environment's editor is the open detail, under its draft row. */
  drafting?: boolean;
  defaults?: boolean;
}>;
const NOTHING_SELECTED: Selection = Object.freeze({
  environmentId: null,
  deploymentId: null,
});
const DRAFTING: Selection = Object.freeze({ environmentId: null, deploymentId: null, drafting: true });
const LOCAL_ENVIRONMENT_DRAFT = 'local';

/**
 * Project → Deployments (lab d1/d3): the Environments rail beside the selected Environment, which pushes one
 * receipt. Phones push the Environment, then the receipt. Reads come only from the Project's shared deployment
 * controller while this page is focused; Actions stay with their front-door owner.
 */
export const ProjectDeploymentsBody = React.memo(
  function ProjectDeploymentsBody(
    props: Readonly<{ isFocused: boolean;
      /** The hosting page's Project header; the page leaves it out beside the Services column (one title). */
      header?: React.ReactNode } & (
      { workspaceRef: WorkspaceRefV1 }
      | { serverId: string | null; projectSourceId: string | null }
    )>,
  ) {
    const serverId = 'workspaceRef' in props ? props.workspaceRef.serverId : props.serverId;
    const sourceId = 'workspaceRef' in props ? props.workspaceRef.source?.sourceId ?? null : props.projectSourceId;
    const presentation = useDeploymentPresentationDemand(props.isFocused);
    const { controller, actions, lifetime, scope, demand, resolution } = useDeploymentProjectRoute(serverId, sourceId, presentation);

    if (!sourceId) {
      return <>{props.header}<ProjectDeploymentsNoSource checkout={'workspaceRef' in props ? props.workspaceRef : null} /></>;
    }
    // A settled non-bound Home (a link without its Home, a signed-out or unreadable credential) says so and
    // offers its next step; only a Home still resolving, or a bound one whose reads are starting, loads.
    if (!lifetime && resolution.kind !== 'resolving' && resolution.kind !== 'bound') {
      return (<>{props.header}
        <ItemList testID="project-deployments.homeUnavailable">
          <UnboundSessionHomeScopeCard resolution={resolution} serverId={serverId ?? ''} testIDPrefix="project-deployments" />
        </ItemList></>
      );
    }
    if (!scope || !controller) {
      return (<>{props.header}
        <PageLoadingRows testID="project-deployments.loading" header /></>
      );
    }
    return (
      <ProjectDeploymentsView
        controller={controller}
        actions={actions}
        demand={demand}
        accountId={scope.accountId}
        serverId={scope.serverId}
        lifetime={lifetime}
        sourceId={sourceId}
        workspaceRef={'workspaceRef' in props ? props.workspaceRef : null}
        header={props.header}
      />
    );
  },
);

const NO_OPENED_SOURCES: ReadonlySet<string> = new Set();
const NO_VISIBLE_ENVIRONMENT_HEALTH: readonly string[] = Object.freeze([]);
/** The Project read includes its removed Environments, whose pages keep their removal Receipts (R20-D4). */
const PROJECT_COLLECTION_QUERY = Object.freeze({ includeDeleted: true as const });
const NO_ENVIRONMENTS: readonly DeploymentEnvironmentCollectionV1['items'][number][] = Object.freeze([]);

function ProjectDeploymentsTitle({ title }: Readonly<{ title: string }>) {
  useDestinationPageTitle(title);
  return null;
}

/**
 * Without a source this Project has nothing deployed yet. Deploy an app leads (journey-deploy proj), never asking for a
 * source first; saving this checkout as a source (Projects' editor) stays the second way forward.
 */
function ProjectDeploymentsNoSource(props: Readonly<{ checkout: WorkspaceRefV1 | null }>) {
  const composition = useProjectsSourcesComposition(NO_OPENED_SOURCES);
  const saveSource = useProjectSaveAsSource(composition);
  const openNewApp = useOpenNewApp();
  const { checkout } = props;
  return (
    <ItemList testID="project-deployments.noSource">
      <EmptyState
        layout="page"
        scene="shipped"
        title={t('projects.deployments.noSourceTitle')}
        subtitle={t('projects.deployments.noSourceBody')}
        primaryAction={{ label: t('newApp.title'), onPress: () => openNewApp(), testID: 'project-deployments.noSource.deployApp' }}
        {...(checkout ? { secondaryAction: {
          label: t('projects.identity.saveAsSource'),
          onPress: () => { void saveSource(checkout); },
          testID: 'project-deployments.noSource.save',
        } } : {})}
      />
    </ItemList>
  );
}

/** The page under a ready controller; the dev specimen renders it over a fixture transport. */
export const ProjectDeploymentsView = React.memo(
  function ProjectDeploymentsView(
    props: Readonly<{
      controller: NonNullable<
        ReturnType<typeof useDeploymentProject>['controller']
      >;
      /** The Action owner's callbacks; the dev specimen renders without them. */
      actions?: (Pick<NonNullable<ReturnType<typeof useDeploymentProject>['actions']>,
        'rollback' | 'restore' | 'restart' | 'cancel' | 'deploy' | 'readLogs' | 'prepareCreate' | 'setBindings' | 'deleteEnvironment' | 'unlink' | 'teardown' | 'link' | 'checkPlatformTarget' | 'inspectPlatformTarget' | 'addDomain' | 'removeDomain' | 'verifyDomain' | 'setController' | 'updateEnvironment'> &
        Partial<Pick<NonNullable<ReturnType<typeof useDeploymentProject>['actions']>, 'promote'>>) | null;
      demand: DeploymentReadDemandV1;
      accountId: string;
      serverId: string;
      lifetime: ServerAccountScopeLifetime | null;
      sourceId: string;
      workspaceRef?: WorkspaceRefV1 | null;
      /** The hosting page's Project header, drawn unless the Environment page stands beside the Services column. */
      header?: React.ReactNode;
    }>,
  ) {
    return (
      <CollectionDraftTitleScope>
        <ProjectDeploymentsPage {...props} />
      </CollectionDraftTitleScope>
    );
  },
);

const ProjectDeploymentsPage = React.memo(
  function ProjectDeploymentsPage(
    props: React.ComponentProps<typeof ProjectDeploymentsView>,
  ) {
    const newWorkEnabled = useFeatureDecision('deployments', {
      scopeKind: 'spawn', serverId: props.serverId,
    })?.state === 'enabled';
    const { theme } = useUnistyles();
    // The shared Source reader owns readability, including retained reads during refresh. It reads only while the
    // page is presented; a hidden page keeps the last answer it showed and asks again when it is shown.
    const readsSource = props.demand.visible;
    const liveSourceRead = useProjectSource(readsSource ? props.lifetime : null, props.sourceId);
    const heldSourceRead = React.useRef(liveSourceRead);
    if (readsSource) heldSourceRead.current = liveSourceRead;
    const sourceRead = readsSource ? liveSourceRead : heldSourceRead.current;
    const sourceAvailable = sourceRead.source !== null;
    const canCreate = newWorkEnabled && sourceAvailable && Boolean(props.actions?.prepareCreate);
    const openNewApp = useOpenNewApp();
    // A Source this person cannot read is a refusal, not a load failure: it says so and leads to another Source.
    const sourceUnavailable = (size: React.ComponentProps<typeof SurfaceStateCard>['size'], code: string | null) => <SurfaceStateCard
      testID="project-deployments.sourceUnavailable" size={size} kind="unavailable"
      title={t('projects.sources.unavailable')} reason={t('projects.open.sourceUnavailableHint')}
      diagnosticCode={code}
      action={{ label: t('projects.open.chooseSource'), onPress: () => router.push(projectSourceRoute(null)) }}
    />;
    // Only a refusal is "no longer available to you"; a Home that isn't answering is said once, by the list (R2-D3).
    const sourceRefused = sourceRead.issue === 'source_unavailable' || sourceRead.issue === 'source_access_denied';
    // The identity the Prepare sheet needs before it can open a pull request. Both agent ways open one, so without a
    // repository neither is offered anywhere on the page (R16-D4); the Project page's agent row leads to its Source.
    const preparable = readProjectSourceRepositoryIdentityV1(sourceRead.source?.source.repository) !== null;
    const preparation = !sourceAvailable && sourceRead.issue ? (sourceRefused ? sourceUnavailable('line', sourceRead.issue) : null) : newWorkEnabled && preparable && props.lifetime ? <>
      <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={props.sourceId} mode="prepare" />
      <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={props.sourceId} mode="import" />
    </> : null;
    const router = useRouter();
    const { fontScale } = useWindowDimensions();
    const phone = useDeviceType() === 'phone';
    const shellColumnVisible = useAppShellColumn().columnVisible;
    const pageStateSize = usePageSurfaceStateSize();
    const railWidth = useCollectionRailWidth('project-deployments');
    // The URL selects the Environment, its receipt, tab and Settings section, or the draft in this page.
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const routeEnvironmentId = readProjectRouteStringParam(params.deploymentEnvironment);
    const routeDeploymentId = readProjectRouteStringParam(params.deployment);
    const routeDatabase = readProjectRouteStringParam(params.deploymentService);
    const routeDetachTarget = readProjectRouteStringParam(params.deploymentDetachTarget);
    const routeDefaults = readProjectRouteStringParam(params.deploymentSettings) === 'defaults';
    const routeTab = readProjectRouteStringParam(params.deploymentTab);
    const routeSection = readProjectRouteStringParam(params.deploymentSection);
    const [databaseRecovery, setDatabaseRecovery] = React.useState<Readonly<{
      serverId: string; accountId: string; environmentId: string | null; service: string;
    }>>();
    const statefulService = databaseRecovery?.serverId === props.serverId && databaseRecovery.accountId === props.accountId
      && databaseRecovery.environmentId === routeEnvironmentId ? databaseRecovery.service : undefined;
    const destination = React.useMemo(
      () => resolveDeploymentEnvironmentDestinationV1({ tab: routeTab, section: routeSection, statefulService }),
      [routeSection, routeTab, statefulService],
    );
    const routeNewDefinition = readProjectRouteStringParam(params.newDefinition);
    const newDefinition = routeNewDefinition === 'compose' || routeNewDefinition === 'image' ? routeNewDefinition : null;
    const seededDraft = newDefinition !== null || routeNewDefinition === DEPLOYMENT_NEW_REPOSITORY_DRAFT;
    const initialMachineId = seededDraft ? readProjectRouteStringParam(params.deployMachine) : null;
    const localDraftSelected = routeNewDefinition === LOCAL_ENVIRONMENT_DRAFT;
    const draftScope = JSON.stringify([props.serverId, props.accountId, props.sourceId]);
    const [localDraft, setLocalDraft] = React.useState<Readonly<{
      scope: string;
      source: DeploymentEnvironmentDetailV1 | null;
      promoteAfterCreate?: (environmentId: string) => void;
    }>>();
    const ownDraft = localDraftSelected && localDraft?.scope === draftScope ? localDraft : undefined;
    const draftSource = ownDraft?.source;
    React.useLayoutEffect(() => {
      setLocalDraft(current => localDraftSelected && current?.scope === draftScope ? current : undefined);
    }, [draftScope, localDraftSelected]);
    const drafting = seededDraft || draftSource !== undefined;
    const selection = React.useMemo<Selection>(() => drafting && sourceAvailable ? DRAFTING : routeDefaults ? {
      environmentId: null, deploymentId: null, defaults: true,
    } : {
      environmentId: routeEnvironmentId,
      deploymentId: routeEnvironmentId ? routeDeploymentId : null,
      database: routeEnvironmentId && !routeDeploymentId ? routeDatabase : null,
    }, [drafting, sourceAvailable, routeDatabase, routeDefaults, routeDeploymentId, routeEnvironmentId]);
    // The phone Overview, like a Receipt or Database, replaces the list and reads its own selected Environment.
    const collectionVisible = !(phone && selection.environmentId
      && (selection.deploymentId || selection.database || destination.tab === 'overview'));
    const environmentId = selection.environmentId;
    const hasDetail = environmentId !== null || selection.drafting === true || selection.defaults === true;
    const usesServicesColumn = props.workspaceRef == null && shellColumnVisible && hasDetail;
    const collection = useDeploymentCollection(props.controller, {
      ...props.demand,
      visible: props.demand.visible && collectionVisible,
      focused: props.demand.focused && collectionVisible,
      // Keep the Project metadata for the detail. The visible column owns its rows' live health.
      healthEnvironmentIds: usesServicesColumn ? NO_VISIBLE_ENVIRONMENT_HEALTH : props.demand.healthEnvironmentIds,
    }, PROJECT_COLLECTION_QUERY);
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const setSelection = React.useCallback((next: Selection) => {
      const current = selectionRef.current;
      const sameEnvironment = next.environmentId === current.environmentId;
      // Keep the underlying Environment address for history after the local draft is gone.
      router.setParams(next.drafting ? { newDefinition: LOCAL_ENVIRONMENT_DRAFT, deployMachine: undefined } : {
        newDefinition: undefined,
        deployMachine: undefined,
        deploymentSettings: next.defaults ? 'defaults' : undefined,
        deploymentEnvironment: next.environmentId ?? undefined,
        deployment: next.deploymentId ?? undefined,
        deploymentService: next.database ?? undefined,
        deploymentDetachTarget: undefined,
        // Another Environment opens on its Overview.
        ...(sameEnvironment ? {} : { deploymentTab: undefined, deploymentSection: undefined }),
      });
    }, [router]);
    const navigateEnvironment = React.useCallback((next: DeploymentEnvironmentDestinationV1) => {
      setDatabaseRecovery(next.statefulService ? { serverId: props.serverId, accountId: props.accountId,
        environmentId: selectionRef.current.environmentId, service: next.statefulService } : undefined);
      router.setParams({
        deploymentTab: next.tab === 'overview' ? undefined : next.tab,
        deploymentSection: next.section ?? undefined,
      });
    }, [props.accountId, props.serverId, router]);
    // One split: every consumer of the Project's Environments reads `items`; removed ones are listed on their own.
    const allItems = collection.snapshot.value?.items ?? NO_ENVIRONMENTS;
    const items = React.useMemo(() => allItems.filter(item => !isDeploymentEnvironmentRemoved(item)), [allItems]);
    const removedItems = React.useMemo(() => allItems.filter(isDeploymentEnvironmentRemoved), [allItems]);
    const status = collection.snapshot.status;
    const readFailure = collection.snapshot.failure;
    const homeUnreachable = deploymentReadIssue(readFailure?.code) === 'homeUnreachable';
    const retained = collection.snapshot.value !== null;
    // The exact read owns admission; a paged collection is not a membership authority.
    const selectedTitle =
      allItems.find((item) => item.environment.id === environmentId)?.title ??
      null;
    // A variable reference names its sibling Environment from this page's own list, never a second read.
    const referenceEnvironments = React.useMemo(
      () => new Map(items.map(item => [item.environment.id, {
        name: item.title, machineIds: item.runtimeTargetLink?.machines ?? [],
      }])),
      [items],
    );
    const environmentTitle = React.useCallback(
      (id: string) => referenceEnvironments.get(id)?.name ?? null,
      [referenceEnvironments],
    );
    const back = React.useCallback(() => {
      const current = selectionRef.current;
      if (current.environmentId && !current.deploymentId && !current.database && router.returnToRetained?.()) return;
      setSelection(current.deploymentId || current.database
        ? { environmentId: current.environmentId, deploymentId: null }
        : NOTHING_SELECTED);
    }, [router, setSelection]);
    // A receipt's next action opens one of its Environment's pages: the receipt closes and that tab opens.
    const openEnvironmentTab = React.useCallback((next: DeploymentEnvironmentDestinationV1) => {
      setSelection({ environmentId: selectionRef.current.environmentId, deploymentId: null });
      navigateEnvironment(next);
    }, [navigateEnvironment, setSelection]);
    // Project settings lead to each Environment's own Automations (its Settings tab); no Project-wide trigger read.
    const triggerEnvironments = React.useMemo(() => items
      .map((item) => ({ id: item.environment.id, title: item.title,
        previewTemplateConfigured: item.previewTemplateConfigured })), [items]);
    const selectEnvironment = React.useCallback((id: string) => {
      setSelection({ environmentId: id, deploymentId: null });
    }, [setSelection]);
    const openEnvironmentTriggers = React.useCallback((id: string) => {
      setSelection({ environmentId: id, deploymentId: null });
      navigateEnvironment(ENVIRONMENT_AUTOMATIONS_DESTINATION);
    }, [navigateEnvironment, setSelection]);
    const openEnvironmentPreviews = React.useCallback((id: string) => {
      setSelection({ environmentId: id, deploymentId: null });
      navigateEnvironment({ tab: 'settings', section: 'previews' });
    }, [navigateEnvironment, setSelection]);
    const openRecoveryReceipt = React.useCallback((deploymentId: string) => {
      setSelection({ environmentId: selectionRef.current.environmentId, deploymentId });
    }, [setSelection]);
    const openRecoveryDestination = useOpenDeploymentRecoveryDestination({
      serverId: props.serverId, sourceId: props.sourceId, openEnvironmentTab, openReceipt: openRecoveryReceipt,
    });
    const hostedBack = useProjectPageBack(phone && (environmentId !== null || selection.drafting === true || selection.defaults === true), back);
    // Without a Project bar to host it (the standalone deployments route), the open Environment draws the
    // receipt's same page Back so a phone can return to the list.
    const environmentBack = usePageBackControl('project-deployments.environment.back', back);
    // One approval continuation for the page: Deploy, Roll back and Add review on the existing approval
    // page, and a decided review refreshes the rail, whose current receipt then speaks.
    const refresh = collection.refresh;
    const approval = useActionApprovalContinuation({
      scopeKey: `${props.serverId}:${props.accountId}:deployments:${props.sourceId}`,
      serverId: props.serverId,
      onExecuted: () => { void refresh(); },
    });
    const approvalId = approval.approvalId;
    const review = React.useMemo<DeploymentReviewHandle>(() => ({
      pendingId: approval.approvalPending ? approvalId : null,
      openRecovery: openRecoveryDestination,
      request: id => {
        approval.requestApproval(id);
        router.pushRetainingCurrent(buildApprovalHref(id, props.serverId));
      },
      open: () => {
        if (approvalId) router.pushRetainingCurrent(buildApprovalHref(approvalId, props.serverId));
      },
    }), [approval.approvalPending, approval.requestApproval, approvalId, props.serverId, router, openRecoveryDestination]);
    const startDraft = React.useCallback((source: DeploymentEnvironmentDetailV1 | null, promoteAfterCreate?: (environmentId: string) => void) => {
      setLocalDraft({ scope: draftScope, source, promoteAfterCreate });
      setSelection(DRAFTING);
    }, [draftScope, setSelection]);
    const openDefaults = React.useCallback(() => setSelection({ ...NOTHING_SELECTED, defaults: true }), [setSelection]);
    // Delete environment, Link and Unlink target run through one owner hook in the detail; the page holds their Actions.
    const deleteEnvironment = props.actions?.deleteEnvironment;
    const unlink = props.actions?.unlink;
    const teardown = props.actions?.teardown;
    const link = props.actions?.link;
    const setBindings = props.actions?.setBindings;
    const disposition = React.useMemo(
      () => deleteEnvironment && unlink && teardown && link && setBindings
        ? { deleteEnvironment, unlink, teardown, link, setBindings } : null,
      [deleteEnvironment, link, setBindings, teardown, unlink],
    );
    const inspectPlatformTarget = props.actions?.inspectPlatformTarget;
    const checkPlatformTarget = props.actions?.checkPlatformTarget;
    const platformLink = React.useMemo(
      () => checkPlatformTarget && inspectPlatformTarget && link ? { checkPlatformTarget, inspectPlatformTarget, link } : null,
      [checkPlatformTarget, inspectPlatformTarget, link],
    );
    // A deleted Environment hands the page to its nearest sibling in this Project, or to the empty state; a phone
    // returns to the list.
    const leaveDeleted = React.useCallback(() => {
      const deletedId = selectionRef.current.environmentId;
      const next = !phone && deletedId ? environmentAfterDelete(items, deletedId, props.sourceId) : null;
      setSelection(next ? { environmentId: next, deploymentId: null } : NOTHING_SELECTED);
      void refresh();
    }, [items, phone, props.sourceId, refresh, setSelection]);

    if (!selection.defaults && !environmentId && !retained && status === 'unavailable') {
      const failureCode = readFailure?.code ?? null;
      // Retrying cannot change a refused read; only a transient failure offers Retry.
      if ((!sourceAvailable && sourceRefused) || failureCode === 'deployment_unavailable') {
        return <>{props.header}<ItemList testID="project-deployments.error">{sourceUnavailable(pageStateSize, sourceRead.issue ?? failureCode)}</ItemList></>;
      }
      // Without a list there is no Services column beside the page: these states keep the hosting Project header,
      // which only a populated list beside the column leaves out (e466ffdf678).
      return (<>{props.header}
        <ItemList testID="project-deployments.error">
          <SurfaceStateCard
            kind="error"
            size={pageStateSize}
            title={t(homeUnreachable ? 'projects.deployments.unavailableTitle' : 'projects.deployments.loadErrorTitle')}
            reason={homeUnreachable ? undefined : t('projects.deployments.loadErrorBody')}
            diagnosticCode={failureCode}
            action={{
              label: t('common.retry'),
              onPress: () => {
                void collection.refresh();
              },
            }}
          />
        </ItemList></>
      );
    }
    if (!selection.defaults && !environmentId && !retained) {
      return (<>{props.header}
        <PageLoadingRows testID="project-deployments.loading" header /></>
      );
    }
    const draft = selection.drafting ? (
      <DeploymentEnvironmentDraft
        key={seededDraft ? JSON.stringify([routeNewDefinition, initialMachineId]) : draftSource?.environment.id ?? 'new'}
        copyFrom={seededDraft ? null : draftSource}
        createProduction={ownDraft?.promoteAfterCreate !== undefined}
        definitionKind={newDefinition}
        initialMachineId={initialMachineId}
        lifetime={props.lifetime}
        sourceId={props.sourceId}
        phone={phone}
        actions={props.actions ?? null}
        onApprovalRequested={approval.requestApproval}
        platformAvailable={platformLink !== null}
        onSaved={(id, { tab }) => {
          setSelection({ environmentId: id, deploymentId: null });
          if (tab) navigateEnvironment({ tab, section: null });
          else ownDraft?.promoteAfterCreate?.(id);
          void refresh();
        }}
        onDiscard={() => router.setParams({ newDefinition: undefined, deployMachine: undefined })}
      />
    ) : null;
    if (!selection.defaults && !environmentId && allItems.length === 0 && !selection.drafting) {
      const emptySettingsAction = {
        label: t('projects.deployments.defaultsEditor.projectTitle'),
        onPress: openDefaults,
        testID: 'project-deployments.empty.settings',
      };
      return (<>{props.header}
        <ProjectDeploymentsTitle title={sourceRead.source?.source.name ?? t('projects.deployments.environments')} />
        <ItemList testID="project-deployments.empty">
          <EmptyState
            layout="page"
            scene="shipped"
            title={t('projects.deployments.emptyTitle')}
            subtitle={t('projects.deployments.emptyBody')}
            // Deploy an app leads, in the one Deploy an app dialog with this Project's code chosen (journey-deploy proj);
            // Settings is the second way forward, or the one action when deploying isn't open.
            {...(canCreate ? {
              primaryAction: { label: t('newApp.title'), onPress: () => openNewApp(null, null, { projectSourceId: props.sourceId }),
                testID: 'project-deployments.empty.deployApp' },
              secondaryAction: emptySettingsAction,
            } : { primaryAction: emptySettingsAction })}
          />
          {/* The agent ways forward the copy names, quiet beneath the page's own actions rather than a card above them. */}
          {preparation ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.space.s8 }}>
              {preparation}
            </View>
          ) : null}
        </ItemList></>
      );
    }

    const selectedOwnsHomeOutage = environmentId !== null && homeUnreachable && !retained;
    const stale =
      status === 'unavailable' && !selectedOwnsHomeOutage
        ? {
            reason: t(homeUnreachable ? 'projects.deployments.unavailableTitle' : 'projects.deployments.loadErrorTitle'),
            onRetry: () => {
              void collection.refresh();
            },
          }
        : null;
    // An open Environment stands beside the Services column. A bare Project route keeps its own collection and title.
    // An open Environment means the Project has one, so the page stands beside the column from the first paint rather
    // than in a split with an empty rail until its list answers (PAGE-ACCEPT-176 R12-D3: the detail pane's 0.14 shift).
    const besideList = usesServicesColumn && (allItems.length > 0 || environmentId !== null);
    const openHostProject = () => router.push(projectSourceRoute(props.sourceId));
    const detail =
      selection.defaults ? <ProjectDeploymentDefaultsSettings key={`defaults:${props.serverId}:${props.accountId}:${props.sourceId}`}
        lifetime={props.lifetime} sourceId={props.sourceId} demand={props.demand} environments={triggerEnvironments}
        project={sourceRead.source ? { name: sourceRead.source.source.name, onOpen: openHostProject } : null}
        onOpenEnvironment={openEnvironmentTriggers} onOpenPreviews={openEnvironmentPreviews} /> : draft ?? (environmentId === null ? null : selection.deploymentId ? (
        <DeploymentReceiptDetail
          key={`${environmentId}:${selection.deploymentId}`}
          lifetime={props.lifetime}
          controller={props.controller}
          environmentId={environmentId}
          deploymentId={selection.deploymentId}
          workspaceRef={props.workspaceRef}
          environmentName={selectedTitle}
          demand={props.demand}
          accountId={props.accountId}
          onBack={back}
          onOpenEnvironmentTab={openEnvironmentTab}
          onOpenRecoveryDestination={openRecoveryDestination}
          rollback={props.actions?.rollback ?? null}
          cancel={props.actions?.cancel ?? null}
          promote={props.actions?.promote ?? null}
          onOpenPromotionReceipt={(environmentId, deploymentId) => setSelection({ environmentId, deploymentId })}
          onCreateProduction={canCreate ? onCreated => startDraft(null, onCreated) : undefined}
          deploy={props.actions?.deploy ?? null}
          teardown={props.actions?.teardown ?? null}
          readLogs={props.actions?.readLogs ?? null}
          serverId={props.serverId}
          phone={phone}
          linkPath={buildDeploymentEnvironmentHref({ serverId: props.serverId, projectSourceId: props.sourceId,
            environmentId, deploymentId: selection.deploymentId })}
          review={review}
          onOpenReceipt={(deploymentId) => setSelection({ environmentId, deploymentId })}
        />
      ) : selection.database ? (
        <DeploymentDatabasePage
          key={`${environmentId}:database:${selection.database}`}
          controller={props.controller}
          environmentId={environmentId}
          database={selection.database}
          demand={props.demand}
          phone={phone}
          lifetime={props.lifetime}
          sourceAudience={sourceRead.audience}
          review={review}
          restore={props.actions?.restore ?? null}
          setBindings={props.actions?.setBindings ?? null}
          onBack={back}
          onNavigate={(next) => {
            setSelection({ environmentId, deploymentId: null });
            navigateEnvironment(next);
          }}
        />
      ) : (
        <DeploymentEnvironmentDetail
          key={environmentId}
          workspaceRef={props.workspaceRef}
          // Outside a Project page the meta line names the Project this route hosts (its Source) and opens it.
          project={props.workspaceRef == null && sourceRead.source
            ? { name: sourceRead.source.source.name, onOpen: openHostProject } : null}
          // One Prepare with an agent per page (QA-DEPLOY #23, lab rdProj-proj): the Environments list's, while it stands.
          preparationInList={!besideList && newWorkEnabled && sourceAvailable && Boolean(props.lifetime)}
          controller={props.controller}
          environmentId={environmentId}
          demand={props.demand}
          accountId={props.accountId}
          serverId={props.serverId}
          phone={phone}
          deploy={props.actions?.deploy ?? null}
          promote={props.actions?.promote ?? null}
          onOpenPromotionReceipt={(environmentId, deploymentId) => setSelection({ environmentId, deploymentId })}
          onCreateProduction={canCreate ? onCreated => startDraft(null, onCreated) : undefined}
          review={review}
          environmentTitle={environmentTitle}
          referenceEnvironments={referenceEnvironments}
          lifetime={props.lifetime}
          setBindings={props.actions?.setBindings ?? null}
          disposition={disposition}
          cancel={props.actions?.cancel ?? null}
          restore={props.actions?.restore ?? null}
          restart={props.actions?.restart ?? null}
          onOpenRecoveryDestination={openRecoveryDestination}
          readLogs={props.actions?.readLogs ?? null}
          domainActions={props.actions ?? null}
          environmentActions={props.actions ?? null}
          onDuplicate={canCreate ? startDraft : undefined}
          platformLink={platformLink}
          onDeleted={leaveDeleted}
          destination={destination}
          onNavigate={navigateEnvironment}
          detachReview={routeDetachTarget ? { targetLinkId: routeDetachTarget,
            onOpened: () => router.setParams({ deploymentDetachTarget: undefined }) } : undefined}
          onOpenReceipt={(deploymentId) =>
            setSelection({ environmentId, deploymentId })
          }
          onOpenDatabase={(database) => setSelection({ environmentId, deploymentId: null, database })}
        />
      ));
    const scale = Math.max(1, fontScale);
    // The bare Project route with nothing open is the Project's own page (PAGE-ACCEPT-176 R11-D6): an entity header
    // naming the Project and what the page is for, New environment as its one action, its Environments, and the agent
    // ways as one row.
    if (props.workspaceRef == null && !hasDetail) {
      const repository = sourceRead.source?.source.repository?.repository.nameWithOwner ?? null;
      const projectEnvironments = items.filter(item => item.environment.purpose !== 'preview');
      const projectPreviews = items.filter(item => item.environment.purpose === 'preview');
      return (
        <View testID="project-deployments" style={{ flex: 1, minHeight: 0 }}>
          {/* A table of Environments: the Services page's wide column, so Runs on keeps its column (R12-D8). */}
          <ItemList testID="project-deployments.project" pageColumn="wide">
            <PageHeader
              testID="project-deployments.project.header"
              // The Project is the page's entity: its name stays beside its mark on a phone too, as an
              // Environment's does (PAGE-ACCEPT-176 R13-D8), never moving into the bar and leaving the mark alone.
              leading={<PageHeaderMarkIcon name="folder" />}
              title={sourceRead.source?.source.name ?? t('projects.deployments.environments')}
              alwaysShowTitle
              description={t('projects.deployments.services.projectPurpose')}
              meta={[
                { key: 'environments', text: t('projects.deployments.services.countEnvironmentsTotal', { count: projectEnvironments.length }) },
                ...(repository ? [{ key: 'repository', text: repository, mono: true }] : []),
              ]}
              {...(canCreate ? { primaryAction: { title: t('projects.deployments.newEnvironment'), icon: 'plus' as const,
                onPress: () => startDraft(null), testID: 'project-deployments.project.add' } } : {})}
              alwaysShowBack={phone}
            />
            {stale ? <SurfaceFreshnessLine testID="project-deployments.project.stale" reason={stale.reason}
              action={{ label: t('common.retry'), onPress: stale.onRetry }} /> : null}
            {/* Its Environments in the Services row anatomy (Environment, Last deploy, Runs on, State), each opening
                its page; a pull request's Previews follow under their own label, as they do in the rail. */}
            <DeploymentEnvironmentRows items={projectEnvironments} serverId={props.serverId} lifetime={props.lifetime ?? null}
              columns={SERVICES_APPS_COLUMNS_BINDING}
              testID="project-deployments.project.environments" accessibilityLabel={t('projects.deployments.environments')} />
            {projectPreviews.length > 0 ? <>
              <ItemGroup testID="project-deployments.project.previews" title={t('projects.deployments.previewsTitle')} />
              <DeploymentEnvironmentRows items={projectPreviews} serverId={props.serverId} lifetime={props.lifetime ?? null}
                columns={SERVICES_APPS_COLUMNS_BINDING}
                testID="project-deployments.project.previewRows" accessibilityLabel={t('projects.deployments.previewsTitle')} />
            </> : null}
            {/* A removed Environment's page keeps its removal Receipt (R20-D4): the last group, as in the rail. */}
            {removedItems.length > 0 ? <>
              <ItemGroup testID="project-deployments.project.removed" title={t('projects.deployments.removedGroup')} />
              <DeploymentEnvironmentRows items={removedItems} serverId={props.serverId} lifetime={props.lifetime ?? null}
                columns={SERVICES_APPS_COLUMNS_BINDING}
                testID="project-deployments.project.removedRows" accessibilityLabel={t('projects.deployments.removedGroup')} />
            </> : null}
            {/* The agent ways are one row of the page (R12-D8), as the draft's "Ask an agent" row: Prepare its action,
                Import a quiet second, beneath the words on a phone. */}
            {newWorkEnabled && sourceAvailable && props.lifetime ? (
              <ItemGroup>
                <Item testID="project-deployments.project.agents" title={t('projects.deployments.preparation.askAgent')}
                  // An agent proposes its files as a pull request: without a repository, the row says what it needs (R14-D9).
                  subtitle={t(preparable ? 'projects.deployments.preparation.askAgentBody' : 'projects.deployments.preparation.askAgentNeedsRepository')}
                  subtitleLines={0} showChevron={false} accessoryLayout={phone ? 'stacked' : 'adaptive'}
                  // Both ways open a pull request: without a repository they cannot succeed, so the row leads to the
                  // Source, where its repository is added (R16-D4).
                  rightElement={preparable ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
                    <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={props.sourceId} mode="prepare" emphasis="secondary" />
                    <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={props.sourceId} mode="import" emphasis="plain" />
                  </View> : (
                    <CorePluginUiPresentationScope>
                      <Button testID="project-deployments.project.addRepository" variant="secondary" size="small"
                        title={t('projects.deployments.preparation.addRepository')}
                        onPress={() => router.push(projectSourceRoute(props.sourceId))} />
                    </CorePluginUiPresentationScope>
                  )} />
              </ItemGroup>
            ) : preparation ? (
              <ItemGroup header="none" surface="none">
                <View testID="project-deployments.project.agents">{preparation}</View>
              </ItemGroup>
            ) : null}
          </ItemList>
        </View>
      );
    }
    // One host for the detail whether the app's own column lists the Environments (besideList) or this page does: a
    // window that crosses that width keeps the open draft or review mounted instead of starting it over (R15-D10).
    return (
      <View
        testID="project-deployments"
        style={{
          flex: 1,
          minHeight: 0,
          }}
      >
        {besideList ? null : props.header}
        <HappierListDetailLayout
          testID="project-deployments.layout"
          listTestID="project-deployments.list-pane"
          detailTestID="project-deployments.detail-pane"
          // Beside the app's column the page is the detail alone: no width fits a second list.
          minListWidth={besideList ? Number.POSITIVE_INFINITY : COLLECTION_RAIL_MIN_WIDTH_PX * scale}
          minDetailWidth={DEPLOYMENTS_DETAIL_MIN_WIDTH_PX * scale}
          listWidthPx={
            railWidth.widthPx ??
            HAPPIER_COLLECTION_RAIL_WIDTH_PX.detailed * scale
          }
          onListWidthCommit={railWidth.commit}
          onListWidthReset={railWidth.reset}
          preferredListRatio={0.5}
          labels={{
            resize: t('ui.resizableDockedPane.resizeA11y'),
            resizeHint: t('ui.resizableDockedPane.resizeHint'),
            resizeValue: (px) =>
              t('ui.resizableDockedPane.resizeValue', { px }),
          }}
          listStyle={{
            borderRightWidth: 1,
            borderRightColor: theme.colors.border.default,
          }}
          list={besideList ? null : (layout) => (
            <>
              {props.workspaceRef != null ? <LandOnFirstEnvironment
                key={`${props.serverId}:${props.accountId}:${props.sourceId}`}
                split={layout?.mode === 'split'}
                selected={hasDetail}
                firstId={items[0]?.environment.id ?? null}
                onLand={(id) =>
                  setSelection({ environmentId: id, deploymentId: null })
                }
              /> : null}
              <DeploymentEnvironmentCollection
                items={collection.snapshot.value ? allItems : null}
                preparation={preparation}
                selectedId={environmentId}
                stale={stale}
                drafting={selection.drafting === true}
                lifetime={props.lifetime}
                onAdd={canCreate ? () => startDraft(null) : null}
                onSettings={openDefaults}
                paging={{ hasPrevious: collection.hasPreviousPage, hasNext: collection.hasNextPage,
                  previous: collection.previousPage, next: collection.nextPage }}
                onSelect={selectEnvironment}
              />
            </>
          )}
          detail={phone && !hostedBack && (environmentId !== null || selection.defaults) && !selection.deploymentId && !draft ? (
            <NavigationBackChromeProvider control={environmentBack}>{detail}</NavigationBackChromeProvider>
          ) : detail}
          detailActive={environmentId !== null || selection.drafting === true || selection.defaults === true}
          stackedPane="detail"
        />
      </View>
    );
  },
);

function LandOnFirstEnvironment(
  props: Readonly<{
    split: boolean;
    selected: boolean;
    firstId: string | null;
    onLand: (id: string) => void;
  }>,
): null {
  const { split, selected, firstId, onLand } = props;
  const landed = React.useRef(selected);
  React.useEffect(() => {
    if (selected) landed.current = true;
    if (split && !landed.current && firstId) {
      landed.current = true;
      onLand(firstId);
    }
  }, [firstId, onLand, selected, split]);
  return null;
}
