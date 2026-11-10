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
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { useCollectionRailWidth } from '@/components/ui/lists/collection/useCollectionRailWidth';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

import { useProjectSaveAsSource } from '../ProjectSaveAsSourceSheet';
import { useProjectsSourcesComposition } from '../useProjectsSourcesComposition';
import { DeploymentEnvironmentCollection, environmentAfterDelete } from './DeploymentEnvironmentCollection';
import { ProjectDeploymentDefaultsSettings } from './ProjectDeploymentDefaultsSettings';
import { DeploymentPreparationEntry } from './DeploymentPreparation';
import { DeploymentEnvironmentDetail, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { DeploymentEnvironmentDraft } from './DeploymentEnvironmentDraft';
import { DeploymentReceiptDetail } from './DeploymentReceiptDetail';
import type { DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { projectSourceRoute } from '@/components/projects/sources/ProjectSourcesScreen';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { PLUGINS_APP_ROUTE } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { DeploymentDatabasePage } from './DeploymentDatabasePage';
import { buildDeploymentEnvironmentHref } from './deploymentNavigation';
import { useDeploymentProject } from './useDeploymentProject';
import { useDeploymentCollection } from './useDeploymentReads';

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

/**
 * Project → Deployments (lab d1/d3): the Environments rail beside the selected Environment, which pushes one
 * receipt. Phones push the Environment, then the receipt. Reads come only from the Project's shared deployment
 * controller while this page is focused; Actions stay with their front-door owner.
 */
export const ProjectDeploymentsBody = React.memo(
  function ProjectDeploymentsBody(
    props: Readonly<{ isFocused: boolean } & (
      { workspaceRef: WorkspaceRefV1 }
      | { serverId: string | null; projectSourceId: string | null }
    )>,
  ) {
    const serverId = 'workspaceRef' in props ? props.workspaceRef.serverId : props.serverId;
    const { binding } = useServerCredentialAccountScopeBinding(
      serverId,
    );
    const sourceId = 'workspaceRef' in props ? props.workspaceRef.source?.sourceId ?? null : props.projectSourceId;
    const demand = useDeploymentPresentationDemand(props.isFocused);
    const { controller, actions } = useDeploymentProject(binding, sourceId, demand);

    if (!sourceId) {
      return <ProjectDeploymentsNoSource checkout={'workspaceRef' in props ? props.workspaceRef : null} />;
    }
    if (!binding || !controller) {
      return (
        <PageLoadingRows testID="project-deployments.loading" header />
      );
    }
    return (
      <ProjectDeploymentsView
        controller={controller}
        actions={actions}
        demand={demand}
        accountId={binding.scope.accountId}
        serverId={binding.scope.serverId}
        lifetime={binding}
        sourceId={sourceId}
      />
    );
  },
);

const NO_OPENED_SOURCES: ReadonlySet<string> = new Set();

/** Without a source there is nothing to deploy yet; the one step is saving this checkout as one (Projects' editor). */
function ProjectDeploymentsNoSource(props: Readonly<{ checkout: WorkspaceRefV1 | null }>) {
  const composition = useProjectsSourcesComposition(NO_OPENED_SOURCES);
  const saveSource = useProjectSaveAsSource(composition);
  const { checkout } = props;
  return (
    <ItemList testID="project-deployments.noSource">
      <EmptyState
        layout="page"
        scene="shipped"
        title={t('projects.deployments.noSourceTitle')}
        subtitle={t('projects.deployments.noSourceBody')}
        {...(checkout ? { primaryAction: {
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
        'rollback' | 'restore' | 'restart' | 'cancel' | 'deploy' | 'readLogs' | 'prepareCreate' | 'setBindings' | 'deleteEnvironment' | 'unlink' | 'teardown' | 'link' | 'inspectPlatformTarget' | 'addDomain' | 'removeDomain' | 'verifyDomain' | 'setController' | 'updateEnvironment'> &
        Partial<Pick<NonNullable<ReturnType<typeof useDeploymentProject>['actions']>, 'promote'>>) | null;
      demand: DeploymentReadDemandV1;
      accountId: string;
      serverId: string;
      lifetime: ServerAccountScopeLifetime | null;
      sourceId: string;
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
    const preparation = newWorkEnabled && props.lifetime ? <>
      <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={props.sourceId} mode="prepare" />
      <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={props.sourceId} mode="import" />
    </> : null;
    const router = useRouter();
    const { fontScale } = useWindowDimensions();
    const phone = useDeviceType() === 'phone';
    const railWidth = useCollectionRailWidth('project-deployments');
    // The open Environment, its receipt, tab and Settings section live in the URL, so a link opens them.
    // Only the new-Environment editor is local: it is never a destination of its own.
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const routeEnvironmentId = readProjectRouteStringParam(params.deploymentEnvironment);
    const routeDeploymentId = readProjectRouteStringParam(params.deployment);
    const routeDatabase = readProjectRouteStringParam(params.deploymentService);
    const routeDefaults = readProjectRouteStringParam(params.deploymentSettings) === 'defaults';
    const collectionVisible = !(phone && routeEnvironmentId && (routeDeploymentId || routeDatabase));
    const collection = useDeploymentCollection(props.controller, {
      ...props.demand,
      visible: props.demand.visible && collectionVisible,
      focused: props.demand.focused && collectionVisible,
    });
    const routeTab = readProjectRouteStringParam(params.deploymentTab);
    const routeSection = readProjectRouteStringParam(params.deploymentSection);
    const destination = React.useMemo(
      () => resolveDeploymentEnvironmentDestinationV1({ tab: routeTab, section: routeSection }),
      [routeSection, routeTab],
    );
    // Store → Apps opens the draft on a stored definition; the address is consumed by the first save or discard.
    const routeNewDefinition = readProjectRouteStringParam(params.newDefinition);
    const newDefinition = routeNewDefinition === 'compose' || routeNewDefinition === 'image' ? routeNewDefinition : null;
    const [drafting, setDrafting] = React.useState(newDefinition !== null);
    const [draftSource, setDraftSource] = React.useState<DeploymentEnvironmentDetailV1 | null>(null);
    const selection = React.useMemo<Selection>(() => drafting ? DRAFTING : routeDefaults ? {
      environmentId: null, deploymentId: null, defaults: true,
    } : {
      environmentId: routeEnvironmentId,
      deploymentId: routeEnvironmentId ? routeDeploymentId : null,
      database: routeEnvironmentId && !routeDeploymentId ? routeDatabase : null,
    }, [drafting, routeDatabase, routeDefaults, routeDeploymentId, routeEnvironmentId]);
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const setSelection = React.useCallback((next: Selection) => {
      const current = selectionRef.current;
      setDrafting(next.drafting === true);
      if (next.drafting) return;
      const sameEnvironment = next.environmentId === current.environmentId;
      router.setParams({
        newDefinition: undefined,
        deploymentSettings: next.defaults ? 'defaults' : undefined,
        deploymentEnvironment: next.environmentId ?? undefined,
        deployment: next.deploymentId ?? undefined,
        deploymentService: next.database ?? undefined,
        // Another Environment opens on its Overview.
        ...(sameEnvironment ? {} : { deploymentTab: undefined, deploymentSection: undefined }),
      });
    }, [router]);
    const navigateEnvironment = React.useCallback((next: DeploymentEnvironmentDestinationV1) => {
      router.setParams({
        deploymentTab: next.tab === 'overview' ? undefined : next.tab,
        deploymentSection: next.section ?? undefined,
      });
    }, [router]);
    const items = collection.snapshot.value?.items ?? [];
    const status = collection.snapshot.status;
    const retained = collection.snapshot.value !== null;
    // The exact read owns admission; a paged collection is not a membership authority.
    const environmentId = selection.environmentId;
    const selectedTitle =
      items.find((item) => item.environment.id === environmentId)?.title ??
      null;
    // A variable reference names its sibling Environment from this page's own list, never a second read.
    const titles = React.useMemo(
      () => new Map(items.map((item) => [item.environment.id, item.title])),
      [items],
    );
    const environmentTitle = React.useCallback(
      (id: string) => titles.get(id) ?? null,
      [titles],
    );
    const back = React.useCallback(() => {
      const current = selectionRef.current;
      setSelection(current.deploymentId || current.database
        ? { environmentId: current.environmentId, deploymentId: null }
        : NOTHING_SELECTED);
    }, [setSelection]);
    // A receipt's next action opens one of its Environment's pages: the receipt closes and that tab opens.
    const openEnvironmentTab = React.useCallback((next: DeploymentEnvironmentDestinationV1) => {
      setSelection({ environmentId: selectionRef.current.environmentId, deploymentId: null });
      navigateEnvironment(next);
    }, [navigateEnvironment, setSelection]);
    // Project settings lead to each Environment's own Triggers (on its Overview); no Project-wide trigger read.
    const triggerEnvironments = React.useMemo(() => (collection.snapshot.value?.items ?? [])
      .map((item) => ({ id: item.environment.id, title: item.title,
        previewTemplateConfigured: item.previewTemplateConfigured })), [collection.snapshot.value]);
    const openEnvironmentTriggers = React.useCallback((id: string) => {
      setSelection({ environmentId: id, deploymentId: null });
    }, [setSelection]);
    const openEnvironmentPreviews = React.useCallback((id: string) => {
      setSelection({ environmentId: id, deploymentId: null });
      navigateEnvironment({ tab: 'settings', section: 'previews' });
    }, [navigateEnvironment, setSelection]);
    // A failed receipt's recovery opens the place its typed destination names: an Environment page in place, or
    // the Source, Machines, Connected services or Store page. Logs and review live on the Environment's Overview.
    const openRecoveryDestination = React.useCallback((destination: DeploymentFailureRecoveryDestinationV1, machineId?: string) => {
      switch (destination) {
        case 'history': case 'variables': case 'domains': case 'permissions': case 'settings':
          openEnvironmentTab({ tab: destination, section: null }); return;
        case 'logs': case 'review':
          openEnvironmentTab({ tab: 'overview', section: null }); return;
        case 'source': router.push(projectSourceRoute(props.sourceId)); return;
        case 'machines': router.push(SETTINGS_ROUTES.machines); return;
        case 'buildMachineSetup': router.push(machineId ? machinePageHref({ door: 'rail',
          target: { machineId, serverId: props.serverId }, tab: { id: 'setup' } }) : SETTINGS_ROUTES.machines); return;
        case 'connectedAccounts': router.push(SETTINGS_ROUTES.connectedServices); return;
        case 'store': router.push(PLUGINS_APP_ROUTE); return;
      }
    }, [openEnvironmentTab, props.sourceId, props.serverId, router]);
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
      request: id => {
        approval.requestApproval(id);
        router.pushRetainingCurrent(buildApprovalHref(id, props.serverId));
      },
      open: () => {
        if (approvalId) router.pushRetainingCurrent(buildApprovalHref(approvalId, props.serverId));
      },
    }), [approval.approvalPending, approval.requestApproval, approvalId, props.serverId, router]);
    const startDraft = React.useCallback(() => {
      setDraftSource(null);
      setSelection(DRAFTING);
    }, [setSelection]);
    const openDefaults = React.useCallback(() => setSelection({ ...NOTHING_SELECTED, defaults: true }), [setSelection]);
    // Delete environment, Link and Unlink target run through one owner hook in the detail; the page holds their Actions.
    const deleteEnvironment = props.actions?.deleteEnvironment;
    const unlink = props.actions?.unlink;
    const teardown = props.actions?.teardown;
    const link = props.actions?.link;
    const disposition = React.useMemo(
      () => deleteEnvironment && unlink && teardown && link ? { deleteEnvironment, unlink, teardown, link } : null,
      [deleteEnvironment, link, teardown, unlink],
    );
    const inspectPlatformTarget = props.actions?.inspectPlatformTarget;
    const platformLink = React.useMemo(
      () => inspectPlatformTarget && link ? { inspectPlatformTarget, link } : null,
      [inspectPlatformTarget, link],
    );
    // A platform draft's new Environment opens Add platform target once, then forgets.
    const [platformLinkFor, setPlatformLinkFor] = React.useState<Readonly<{ environmentId: string; targetKey: string }> | null>(null);
    const platformLinkOpened = React.useCallback(() => setPlatformLinkFor(null), []);
    // A deleted Environment hands the page to its nearest sibling in this Project, or to the empty state; a phone
    // returns to the list.
    const leaveDeleted = React.useCallback(() => {
      const deletedId = selectionRef.current.environmentId;
      const next = !phone && deletedId ? environmentAfterDelete(items, deletedId, props.sourceId) : null;
      setSelection(next ? { environmentId: next, deploymentId: null } : NOTHING_SELECTED);
      void refresh();
    }, [items, phone, props.sourceId, refresh, setSelection]);

    if (!selection.defaults && !environmentId && !retained && status === 'unavailable') {
      return (
        <ItemList testID="project-deployments.error">
          <SurfaceStateCard
            kind="error"
            title={t('projects.deployments.loadErrorTitle')}
            reason={t('projects.deployments.loadErrorBody')}
            diagnosticCode={collection.snapshot.failure?.code ?? null}
            action={{
              label: t('common.retry'),
              onPress: () => {
                void collection.refresh();
              },
            }}
          />
        </ItemList>
      );
    }
    if (!selection.defaults && !environmentId && !retained) {
      return (
        <PageLoadingRows testID="project-deployments.loading" header />
      );
    }
    const draft = selection.drafting ? (
      <DeploymentEnvironmentDraft
        key={draftSource?.environment.id ?? 'new'}
        copyFrom={draftSource}
        definitionKind={newDefinition}
        lifetime={props.lifetime}
        sourceId={props.sourceId}
        phone={phone}
        actions={props.actions?.prepareCreate
          ? { prepareCreate: props.actions.prepareCreate } : null}
        onApprovalRequested={approval.requestApproval}
        platformAvailable={platformLink !== null}
        onSaved={(id, next) => {
          if (next?.platformTargetKey) setPlatformLinkFor({ environmentId: id, targetKey: next.platformTargetKey });
          setSelection({ environmentId: id, deploymentId: null });
          if (next?.tab) navigateEnvironment({ tab: next.tab, section: null });
          void refresh();
        }}
        onDiscard={() => setSelection(NOTHING_SELECTED)}
      />
    ) : null;
    if (!selection.defaults && !environmentId && items.length === 0 && !selection.drafting) {
      return (
        <ItemList testID="project-deployments.empty">
          <ItemGroup><Item testID="project-deployments.empty.settings" title={t('projects.deployments.defaultsEditor.projectTitle')}
            icon={<Icon name="sliders-horizontal" size={18} color={theme.colors.text.secondary} />}
            onPress={openDefaults} /></ItemGroup>
          {preparation ? <ItemGroup header="none">{preparation}</ItemGroup> : null}
          <EmptyState
            layout="page"
            scene="shipped"
            title={t('projects.deployments.emptyTitle')}
            subtitle={t('projects.deployments.emptyBody')}
            {...(newWorkEnabled && props.actions?.prepareCreate ? { primaryAction: {
              label: t('projects.deployments.add'),
              onPress: startDraft,
              testID: 'project-deployments.empty.add',
            } } : {})}
          />
        </ItemList>
      );
    }

    const stale =
      status === 'unavailable'
        ? {
            reason: t('projects.deployments.unavailableTitle'),
            onRetry: () => {
              void collection.refresh();
            },
          }
        : null;
    const detail =
      selection.defaults ? <ProjectDeploymentDefaultsSettings key={`${props.serverId}:${props.accountId}:${props.sourceId}`}
        lifetime={props.lifetime} sourceId={props.sourceId} demand={props.demand} environments={triggerEnvironments}
        onOpenEnvironment={openEnvironmentTriggers} onOpenPreviews={openEnvironmentPreviews} /> : draft ?? (environmentId === null ? null : selection.deploymentId ? (
        <DeploymentReceiptDetail
          key={`${environmentId}:${selection.deploymentId}`}
          controller={props.controller}
          environmentId={environmentId}
          deploymentId={selection.deploymentId}
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
          controller={props.controller}
          environmentId={environmentId}
          demand={props.demand}
          accountId={props.accountId}
          serverId={props.serverId}
          phone={phone}
          deploy={props.actions?.deploy ?? null}
          review={review}
          environmentTitle={environmentTitle}
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
          onDuplicate={newWorkEnabled && props.actions?.prepareCreate ? source => {
            setDraftSource(source);
            setSelection(DRAFTING);
          } : undefined}
          platformLink={platformLink}
          openPlatformLink={platformLinkFor?.environmentId === environmentId ? platformLinkFor.targetKey : null}
          onPlatformLinkOpened={platformLinkOpened}
          onDeleted={leaveDeleted}
          destination={destination}
          onNavigate={navigateEnvironment}
          onOpenReceipt={(deploymentId) =>
            setSelection({ environmentId, deploymentId })
          }
          onOpenDatabase={(database) => setSelection({ environmentId, deploymentId: null, database })}
        />
      ));
    const scale = Math.max(1, fontScale);
    return (
      <View
        testID="project-deployments"
        style={{
          flex: 1,
          minHeight: 0,
          }}
      >
        <HappierListDetailLayout
          testID="project-deployments.layout"
          listTestID="project-deployments.list-pane"
          detailTestID="project-deployments.detail-pane"
          minListWidth={COLLECTION_RAIL_MIN_WIDTH_PX * scale}
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
          list={(layout) => (
            <>
              <LandOnFirstEnvironment
                key={`${props.serverId}:${props.accountId}:${props.sourceId}`}
                split={layout?.mode === 'split'}
                selected={environmentId !== null || selection.drafting === true || selection.defaults === true}
                firstId={items[0]?.environment.id ?? null}
                onLand={(id) =>
                  setSelection({ environmentId: id, deploymentId: null })
                }
              />
              <DeploymentEnvironmentCollection
                items={items}
                preparation={preparation}
                selectedId={environmentId}
                stale={stale}
                drafting={selection.drafting === true}
                lifetime={props.lifetime}
                onAdd={newWorkEnabled && props.actions?.prepareCreate ? startDraft : null}
                onSettings={openDefaults}
                paging={{ hasPrevious: collection.hasPreviousPage, hasNext: collection.hasNextPage,
                  previous: collection.previousPage, next: collection.nextPage }}
                onSelect={openEnvironmentTriggers}
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
