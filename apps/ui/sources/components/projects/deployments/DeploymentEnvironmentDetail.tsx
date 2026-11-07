import * as React from 'react';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DeploymentEnvironmentDestinationV1,
  DeploymentEnvironmentSettingsSectionV1,
  DeploymentEnvironmentTabV1,
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Icon } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Item } from '@/components/ui/lists/Item';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { ItemGroup, ItemGroupDefaultSurfaceProvider } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
  useMachineDisplayNamesById,
  useServerScopedMachine,
} from '@/sync/store/hooks';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { formatRelativeTime, formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { DeploymentSecretBindingsNotice } from './DeploymentSecretBindingsNotice';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { DeploymentContentV1, DeploymentReceiptFailureV1 } from '@happier-dev/deployment-protocol/v1';

import {
  deploymentDefinitionLabel,
  deploymentDurationMs,
  deploymentHistoryLead,
  deploymentSourceLabel,
  deploymentStateLabel,
  deploymentStateNotice,
  deploymentWorkStatus,
  deploymentDeployAvailability,
  deploymentHealthFact,
  deploymentActionRefusalRemedy,
} from './deploymentPresentation';
import {
  useDeploymentPress,
  readDeploymentActionError,
  type DeploymentActionOutcome,
} from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import { DeploymentEnvironmentSettingsPanel, type DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { DeploymentDomainsPanel, type DeploymentDomainEditing } from './DeploymentDomainsPanel';
import { DeploymentPermissionsPanel } from './DeploymentPermissionsPanel';
import { DeploymentStepStrip } from './DeploymentStepStrip';
import { DeploymentTabState } from './DeploymentTabState';
import { DeploymentVariablesPanel } from './DeploymentVariablesPanel';
import { DeploymentDataCard } from './DeploymentDataCard';
import { showDeploymentDispositionSheet } from './DeploymentDispositionSheet';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { showDeploymentLinkMachineSheet } from './DeploymentLinkMachineSheet';
import { showDeploymentPlatformTargetSheet, useDeploymentPlatformTargetTitles, type DeploymentPlatformLinkActions } from './DeploymentPlatformTargetSheet';
import { showDeploymentRestoreSheet } from './DeploymentRestoreSheet';
import { deploymentRestoreOperands, retainedBackupFromSummary } from './deploymentRestore';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { useDeploymentEnvironmentDeletion } from './useDeploymentEnvironmentDeletion';
import {
  useEnvironmentSecretBindingsDraft,
  type EnvironmentBindingsCommit,
} from './useEnvironmentSecretBindingsDraft';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { IconButton } from '@/components/ui/buttons/IconButton';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
  useDeploymentEnvironment,
  useDeploymentHistory,
  useDeploymentReceipt,
  useEnvironmentBackupSummary,
} from './useDeploymentReads';
import { useEnvironmentNavigation, selectEnvironmentNavigationItem } from './environmentNavigation';
import { EnvironmentPageNavigation } from './EnvironmentNavigationViews';

type EnvironmentTab = DeploymentEnvironmentTabV1;
const noEnvironmentName = () => null;
const readMachineOnline = (machine: Machine | null) =>
  machine ? isMachineOnline(machine) : null;
const RECENT_COUNT = 5;
const OVERVIEW: DeploymentEnvironmentDestinationV1 = Object.freeze({
  tab: 'overview',
  section: null,
});

/**
 * One Environment (lab d1 `det`): its identity and where it runs, then Overview — what serves now and its
 * recent receipts — and History. Every fact comes from the selected detail, its history page and the one
 * active receipt; nothing here starts its own observation.
 */
export const DeploymentEnvironmentDetail = React.memo(
  function DeploymentEnvironmentDetail(
    props: Readonly<{
      controller: DeploymentReadControllerV1;
      environmentId: string;
      demand: DeploymentReadDemandV1;
      accountId: string;
      serverId: string;
      phone: boolean;
      onOpenReceipt: (deploymentId: string) => void;
      /** Pushes one database's page in place (P9). */
      onOpenDatabase?: (database: string) => void;
      /** The Action owner's Deploy; absent while the Source's Account is not current. */
      deploy: ReturnType<typeof createDeploymentActions>['deploy'] | null;
      /** The page's one approval continuation: a held review opens the existing approval page. */
      review: DeploymentReviewHandle;
      /** Names a sibling Environment a variable reference points at, from the page's Environment list. */
      environmentTitle?: (environmentId: string) => string | null;
      /** The captured Home/Account the Variables draft writes under; absent while it is not current. */
      lifetime?: ServerAccountScopeLifetime | null;
      /** The Action owner's `deployments.bindings.set`; absent where the page cannot write. */
      setBindings?: EnvironmentBindingsCommit | null;
      /** The open tab and Settings section, from the page's URL; a standalone render keeps its own. */
      destination?: DeploymentEnvironmentDestinationV1;
      onNavigate?: (destination: DeploymentEnvironmentDestinationV1) => void;
      /** The Action owner's target-membership Actions (Delete environment, Link and Unlink target); absent where the page cannot write. */
      disposition?: Pick<ReturnType<typeof createDeploymentActions>, 'deleteEnvironment' | 'unlink' | 'teardown' | 'link'> | null;
      /** The Environment was deleted: the page leaves it. */
      onDeleted?: () => void;
      /** The Action owner's backup restore; absent where the page cannot write. */
      restore?: ReturnType<typeof createDeploymentActions>['restore'] | null;
      /** The Action owner's Domain add, remove and Check again; absent where the page cannot write. */
      domainActions?: DeploymentDomainEditing['actions'] | null;
      /** The Action owner's controller and manager-setting edits; absent where the page cannot write. */
      environmentActions?: DeploymentEnvironmentEditing['actions'] | null;
      /** Duplicate opens the existing creation draft with this loaded source. */
      onDuplicate?: (source: DeploymentEnvironmentDetailV1) => void;
      openPreparation?: ReturnType<typeof createDeploymentActions>['openPreparation'] | null;
      /** The Action owner's platform inspect and Link; absent where the page cannot write. */
      platformLink?: DeploymentPlatformLinkActions | null;
      /** A platform draft was just created: open Add platform target once its detail is here. */
      /** A platform draft's new Environment: open Add platform target on this declared target, once. */
      openPlatformLink?: string | null;
      onPlatformLinkOpened?: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [preparing, setPreparing] = React.useState(false);
    const [preparationOutcome, setPreparationOutcome] = React.useState<DeploymentActionOutcome | null>(null);
    const {
      running: deploying, outcome, reviewPending, press,
    } = useDeploymentPress(props.review, props.onOpenReceipt);
    const environment = useDeploymentEnvironment(
      props.controller,
      props.environmentId,
      props.demand,
    );
    const history = useDeploymentHistory(
      props.controller,
      props.environmentId,
      props.demand,
    );
    const detail = environment.snapshot.value;
    const runtime = detail?.runtimeTargetLink ?? null;
    const activeId = runtime?.activeDeploymentId ?? null;
    const active = useDeploymentReceipt(
      props.controller,
      props.environmentId,
      activeId,
      props.demand,
    );
    // The serving deploy's pre-migration backup, from the same receipt lease: the restore entry on Settings → Backups.
    const backupSummary = useEnvironmentBackupSummary(
      props.controller,
      props.environmentId,
      activeId,
      props.demand,
    );
    const machineIds = React.useMemo(
      () => runtime?.machines ?? [],
      [runtime?.machines],
    );
    // Build and controller Machines are named too, so Settings still names them while nothing is linked.
    const controllerMachineId = detail?.environment.controllerMachineId ?? null;
    const buildMachineId = detail?.environment.buildMachineId ?? null;
    const namedMachineIds = React.useMemo(
      () => [...new Set([...machineIds, ...(controllerMachineId ? [controllerMachineId] : []), ...(buildMachineId ? [buildMachineId] : [])])],
      [buildMachineId, controllerMachineId, machineIds],
    );
    const machineNames = useMachineDisplayNamesById(namedMachineIds);
    // A platform Environment's header names its platform (lab d4), as the rail row does.
    const platformTitle = useDeploymentPlatformTargetTitles(props.lifetime ?? null, runtime?.source.kind === 'plugin');
    // Its Triggers run where it is deployed (OPS-AUTOMATIONS-1102 D2), or on its controller before anything is.
    const triggerMachineId = machineIds[0] ?? controllerMachineId;
    const triggerSubject = React.useMemo(() => triggerMachineId
      ? { kind: 'environment' as const, machineId: triggerMachineId, environmentId: props.environmentId } : null,
    [triggerMachineId, props.environmentId]);
    const [ownDestination, setOwnDestination] =
      React.useState<DeploymentEnvironmentDestinationV1>(OVERVIEW);
    const { tab, section: settingsSection } =
      props.destination ?? ownDestination;
    const onNavigate = props.onNavigate ?? setOwnDestination;
    const navigationScope = React.useMemo(() => ({ serverId: props.serverId, accountId: props.accountId }), [props.serverId, props.accountId]);
    const navigation = useEnvironmentNavigation({ scope: navigationScope, environmentId: props.environmentId,
      destination: props.destination ?? ownDestination, phone: props.phone,
      presented: props.demand.mounted && props.demand.visible && props.demand.focused, navigate: onNavigate });
    const executeNavigation = useMountedScopeActionCommand(navigationScope);
    const selectPage = (id: string) => selectEnvironmentNavigationItem(executeNavigation, navigation.model, id);
    const openTab = (
      next: EnvironmentTab,
      section: DeploymentEnvironmentSettingsSectionV1 | null = null,
    ) => {
        selectEnvironmentNavigationItem(executeNavigation, navigation.model, next, section);
    };
    // The draft lives with the page, so a tab switch keeps unsaved Variables edits.
    const bindings = useEnvironmentSecretBindingsDraft({
      environmentId: props.environmentId,
      lifetime: props.lifetime ?? null,
      snapshot: environment.snapshot,
      setBindings: props.setBindings ?? null,
    });
    const disposition = useDeploymentEnvironmentDeletion({
      environmentId: props.environmentId,
      lifetime: props.lifetime ?? null,
      snapshot: environment.snapshot,
      actions: props.disposition ?? null,
      controller: props.controller,
      demand: props.demand,
    });
    // Only the verdict is subscribed, so presence heartbeats do not redraw the page.
    const machineOnline = useServerScopedMachine(
      props.serverId,
      machineIds.length === 1 ? machineIds[0] : null,
      readMachineOnline,
    );
    // A platform draft opens Add platform target as soon as its new Environment can be linked.
    const openPlatformRef = React.useRef<((initialTargetKey?: string) => void) | null>(null);
    const { openPlatformLink, onPlatformLinkOpened } = props;
    const canOpenPlatform = detail !== null && disposition.canLink;
    React.useEffect(() => {
      if (!openPlatformLink || !canOpenPlatform || !openPlatformRef.current) return;
      openPlatformRef.current(openPlatformLink);
      onPlatformLinkOpened?.();
    }, [openPlatformLink, canOpenPlatform, onPlatformLinkOpened]);

    if (!detail) {
      return (
        <ItemList testID="project-deployments.environment.state">
          <EnvironmentPageNavigation navigation={navigation} phone={props.phone} onSelect={selectPage} />
          {environment.snapshot.status === 'unavailable' ? (
            <SurfaceStateCard
              kind="error"
              title={t('projects.deployments.environmentErrorTitle')}
              diagnosticCode={environment.snapshot.failure?.code ?? null}
              action={{
                label: t('common.retry'),
                onPress: () => {
                  void environment.refresh();
                },
              }}
            />
          ) : (
            <SurfaceStateCard
              kind="loading"
              title={t('projects.deployments.loading')}
            />
          )}
        </ItemList>
      );
    }

    const machineName = (machineId: string) =>
      machineNames[machineId] ?? t('projects.deployments.aMachine');
    // Where a name is only a fact or a clause, an unknown Machine drops out instead of reading "a machine".
    const knownMachine = (machineId: string | undefined) => (machineId ? machineNames[machineId] ?? null : null);
    const definition = deploymentDefinitionLabel(detail.content);
    const platformName = runtime?.source.kind === 'plugin' ? platformTitle(runtime.source) : null;
    const meta: PageHeaderMetaFact[] = [
      ...(platformName ? [{ key: 'platform', text: platformName }] : []),
      ...machineIds.flatMap((machineId) => {
        const name = knownMachine(machineId);
        return name ? [{ key: `machine:${machineId}`, text: name, icon: 'hard-drives' as const }] : [];
      }),
      // Only a Compose definition runs with Compose; a platform builds the repository itself.
      ...(definition
        ? [{ key: 'compose', text: t('projects.deployments.compose') },
            { key: 'definition', text: definition, mono: true }]
        : []),
    ];
    const environmentEditing: DeploymentEnvironmentEditing | null = props.environmentActions ? {
      actions: props.environmentActions,
      serverId: props.serverId,
      review: props.review,
      onChanged: () => { void environment.refresh(); },
    } : null;
    const availability = deploymentDeployAvailability(detail);
    const ready = availability.kind === 'ready' && props.deploy !== null;
    const offline = ready && machineOnline === false;
    const { deploy, review, environmentId } = props;
    const pressDeploy = async () => {
      if (!deploy || availability.kind !== 'ready') return;
      await press(() => deploy({ environmentId, targetLinkId: availability.targetLinkId }));
    };
    const liveSha =
      active.snapshot.value?.content.sourceIntent?.kind === 'repository'
        ? active.snapshot.value.content.sourceIntent.sha
        : null;
    const pressRedeploy = async () => {
      if (!deploy || availability.kind !== 'ready' || !liveSha) return;
      await press(() => deploy({ environmentId, targetLinkId: availability.targetLinkId, sha: liveSha }));
    };
    const deployBlocked =
      deploying ||
      offline ||
      reviewPending ||
      (outcome?.kind === 'refused' && outcome.reason === 'unsupported');
    const primaryDeploy = ready ? (
      <RoundButton
        testID="project-deployments.environment.deploy"
        size="normal"
        // Beside its chevron the two read as one split control (lab d1 header).
        joinedEdge={liveSha ? 'end' : undefined}
        // A phone's pinned primary spans the bar (lab d1p).
        style={props.phone ? styles.phoneDeploy : undefined}
        title={t('projects.deployments.deploy')}
        leading={
          <Icon
            name="rocket-launch"
            size={14}
            color={theme.colors.button.primary.tint}
          />
        }
        loading={deploying}
        disabled={
          deploying ||
          offline ||
          reviewPending ||
          (outcome?.kind === 'refused' && outcome.reason === 'unsupported')
        }
        onPress={() => {
          void pressDeploy();
        }}
      />
    ) : undefined;
    // Deploy's chevron holds the other ways to deploy that can succeed now (lab d1 header).
    const deployButton =
      primaryDeploy && liveSha ? (
        <View style={[styles.split, props.phone && styles.phoneSplit]}>
          {primaryDeploy}
          <DeployMoreMenu
            disabled={deployBlocked}
            phone={props.phone}
            onRedeploy={() => {
              void pressRedeploy();
            }}
          />
        </View>
      ) : (
        primaryDeploy
      );
    // Earlier settled teardowns are named to the removal, which admits them as proof nothing of it still runs.
    const settledTeardowns = (history.snapshot.value?.items ?? [])
      .filter((receipt) => receipt.operation === 'teardown' && receipt.state === 'succeeded')
      .map((receipt) => receipt.id);
    const openDisposition = (targetLinkId: string | null) => {
      const links = disposition.review.retainedTargets;
      const subject = targetLinkId ? links.find((link) => link.id === targetLinkId) ?? null : null;
      const running = subject ? subject.activeDeploymentId !== null : links.some((link) => link.activeDeploymentId !== null);
      const machines = subject ? subject.machines : machineIds;
      const { onDeleted } = props;
      showDeploymentDispositionSheet({
        subject: targetLinkId ? { kind: 'target', targetLinkId } : { kind: 'environment' },
        name: detail.content.name,
        machine: machines.length > 0 ? machines.map(machineName).join(', ') : null,
        running,
        canRemove: true,
        ...(!targetLinkId || running ? { domains: { controller: props.controller, environmentId: detail.environment.id } } : {}),
        // This review is the person's confirmation of the exact Actions, so the front door does not ask again.
        // The teardown owner stops the shown target and removes the Environment in that admitted operation.
        run: (choice) => choice === 'remove' && (running || (!targetLinkId && detail.environment.runtimeTargetLinkId != null))
          ? disposition.stopAndRemove(targetLinkId)
          : targetLinkId
            ? disposition.unlink(targetLinkId, choice === 'detach' ? { kind: 'detachKeepRunning' } : { kind: 'afterTeardown' },
              { presentUserConfirmation: { actionId: 'deployments.targets.unlink' } })
            : disposition.deleteEnvironment(choice === 'detach'
              ? { kind: 'detachKeepRunning' }
              : { kind: 'afterTeardown', deploymentIds: settledTeardowns },
            { presentUserConfirmation: { actionId: 'deployments.environments.delete' } }),
        onApproval: review.request,
        onDone: (outcome) => {
          if (outcome.kind === 'deleted') onDeleted?.();
        },
      });
    };
    // Link a machine (lab `servers/add`): the sheet is where the link is made, wherever the person asks for it.
    const openLink = disposition.canLink ? () => {
      showDeploymentLinkMachineSheet({
        name: detail.content.name,
        serverId: props.serverId,
        suggestedMachineId: detail.environment.controllerMachineId,
        run: (machine) => disposition.link(machine, { presentUserConfirmation: { actionId: 'deployments.targets.link' } }),
        onApproval: review.request,
      });
    } : null;
    // Add a platform target: the same manage-targets capability as a machine link, through the plugin's own target.
    const platformLink = props.platformLink ?? null;
    const lifetime = props.lifetime ?? null;
    const openPlatform = disposition.canLink && platformLink && lifetime ? (initialTargetKey?: string) => {
      showDeploymentPlatformTargetSheet({
        initialTargetKey: initialTargetKey ?? null,
        name: detail.content.name,
        environment: { id: detail.environment.id, revision: detail.environment.revision,
          projectSourceId: detail.environment.projectSourceId },
        ownerAccountId: props.accountId,
        lifetime,
        actions: platformLink,
        onApproval: review.request,
      });
    } : null;
    openPlatformRef.current = openPlatform;
    // Restore a backup: the pre-migration dump the serving deploy kept, read from the active receipt the page
    // already holds. The restore Action decides admission at each press.
    const servingReceipt = active.snapshot.value;
    const retainedBackup = backupSummary.result.value && servingReceipt
      ? retainedBackupFromSummary(backupSummary.result.value, deploymentSourceLabel(servingReceipt.content)) : null;
    const restoreAction = props.restore ?? null;
    const restoreOperands = retainedBackup ? deploymentRestoreOperands(detail, retainedBackup) : null;
    const openRestore = restoreAction && retainedBackup && restoreOperands ? () => {
      showDeploymentRestoreSheet({
        name: detail.content.name,
        machine: machineName(restoreOperands.machineId),
        backup: retainedBackup,
        operands: restoreOperands,
        restore: (input) => restoreAction(input),
        onApproval: review.request,
      });
    } : null;
    const environmentMenu = (
      <EnvironmentMenu
        onDuplicate={props.onDuplicate ? () => props.onDuplicate?.(detail) : undefined}
        onOpenHistory={() => selectPage('history')}
        onOpenSettings={() => selectPage('settings')}
        deleteTitle={disposition.canDelete ? t('projects.deployments.menuDelete', { name: detail.content.name }) : null}
        onDelete={() => openDisposition(null)}
      />
    );
    const machineLabel = machineName(machineIds[0] ?? '');
    const receipts = history.result.items;
    const recentReceipts = receipts.filter((receipt) => receipt.id !== activeId).slice(0, RECENT_COUNT);
    const receiptRow = (receipt: DeploymentReceiptHeaderV1) => (
      <DeploymentReceiptRow
        key={receipt.id}
        receipt={receipt}
        live={receipt.id === activeId}
        byYou={receipt.requestedByAccountId === props.accountId}
        phone={props.phone}
        onPress={() => props.onOpenReceipt(receipt.id)}
      />
    );
    const activeReceipt = active.snapshot.value;
    const servingNotice = activeReceipt ? deploymentStateNotice(activeReceipt.deployment.state) : null;
    const services = activeReceipt ? deploymentServices(activeReceipt.content) : NO_SERVICES;

    return (
      <View style={styles.page}>
        <ItemList testID="project-deployments.environment">
          <PageHeader
            testID="project-deployments.environment.header"
            title={detail.content.name}
            alwaysShowTitle
            leading={
              <PageHeaderMarkIcon name="hard-drives" />
            }
            titleAccessory={
              detail.environment.protection === 'production' ? (
                <StatusPill
                  variant="neutral"
                  hideDot
                  label={t('projects.deployments.production')}
                />
              ) : undefined
            }
            meta={meta}
            {...(detail.environment.capabilities.deploy
              ? {}
              : { description: t('projects.deployments.managersOnly') })}
            actions={
              props.phone ? (
                environmentMenu
              ) : (
                <View style={styles.headerActions}>
                  {deployButton}
                  {environmentMenu}
                </View>
              )
            }
            actionsPlacement="page"
            // The mark and the actions hang from the name's line, as on a Machine page, so a long name never
            // pushes the phone's ⋯ onto a row of its own.
            actionsLayout="hang"
          />

          <ItemGroup surface="none" header="none">
            <EnvironmentPageNavigation navigation={navigation} phone={props.phone} onSelect={selectPage} />
          </ItemGroup>
          {/* What Deploy can or cannot do now reads under the tabs, as the lab's freshness line does. */}
          {offline ? (
            <SurfaceFreshnessLine
              testID="project-deployments.environment.offline"
              reason={t('projects.deployments.machineOffline', {
                machine: machineLabel,
              })}
            />
          ) : null}
          {availability.kind === 'noTarget' ? (
            <AttentionBanner
              testID={`project-deployments.environment.unavailable.${availability.kind}`}
              tone="neutral"
              title={t('projects.deployments.deployUnavailableTitle')}
              description={definition
                ? t('projects.deployments.deployNoTarget')
                : t('projects.deployments.platformLink.deployNoPlatform')}
              // The rail's Machine is the controller; deploying needs a runtime link, which the Link a machine sheet makes.
              // A Machine runs a Compose file, so an Environment without one is offered only a platform.
              {...(openLink && definition
                ? { action: { label: t('projects.deployments.linkMachine'), onPress: openLink } }
                : {})}
              {...(openPlatform
                ? definition
                  ? { secondaryAction: { label: t('projects.deployments.platformLink.usePlatform'), onPress: () => openPlatform() } }
                  : { action: { label: t('projects.deployments.platformLink.usePlatform'), onPress: () => openPlatform() } }
                : {})}
            />
          ) : null}
          {outcome ? (
            <DeployOutcomeBanner
              outcome={outcome}
              pending={reviewPending}
              machine={runtime?.source.kind === 'plugin' ? null : machineLabel}
              onOpenReview={review.open}
            />
          ) : null}
          {tab === 'overview' && servingNotice && activeReceipt?.deployment.state === 'running_unverified' ? (
            // The receipt's own notice, where the person looks first (lab d1 `unverified`).
            <AttentionBanner
              testID="project-deployments.environment.serving.notice.running_unverified"
              tone={servingNotice.tone}
              title={deploymentStateLabel(activeReceipt.deployment.state)}
              description={servingNotice.text}
            />
          ) : null}
          {tab === 'overview' ? (
            <>
              <DeploymentSecretBindingsNotice bindings={detail.content.bindings} scope={props.lifetime?.scope ?? null} />
              {/* The hero (lab d1 `dk-now`): what serves now, how it got there, then the four facts that say how it is.
                  Flat, so its glyph, name and facts start on the section headings' edge rather than a card's inner one. */}
              <ItemGroupDefaultSurfaceProvider value="flat">
              <ItemGroup
                testID="project-deployments.environment.serving"
                // "Serving now" heads only something that serves; an undeployed environment says so on its own.
                {...(activeId ? { title: t('projects.deployments.servingNow') } : { header: 'none' as const })}
              >
                {activeReceipt ? (
                  <>
                    <Item
                      testID="project-deployments.environment.serving.receipt"
                      contentAlign="start"
                      leftElement={
                        <WorkStatusGlyph
                          status={deploymentWorkStatus(
                            activeReceipt.deployment.state,
                          )}
                          testIDSuffix={`deployment-${activeReceipt.deployment.id}`}
                        />
                      }
                      // The commit's subject names the version when it has one, and its short id leads the facts;
                      // without a subject the short id is the title and is not repeated beneath it.
                      title={
                        activeReceipt.content.commitSubject ??
                        deploymentSourceLabel(activeReceipt.content)
                      }
                      subtitle={
                        <ReceiptFactsLine
                          sha={
                            activeReceipt.content.commitSubject
                              ? deploymentSourceLabel(activeReceipt.content)
                              : null
                          }
                          facts={servingFacts(
                            activeReceipt.deployment,
                            activeReceipt.deployment.requestedByAccountId ===
                              props.accountId,
                          )}
                        />
                      }
                      // The steps belong to the version they deployed: one hero block, no divider between them.
                      bottomElement={activeReceipt.content.steps.length > 0 ? (
                        <View style={styles.strip}>
                          <DeploymentStepStrip
                            variant={props.phone ? 'compact' : 'full'}
                            captioned
                            steps={activeReceipt.content.steps}
                            testID="project-deployments.environment.serving.steps"
                          />
                        </View>
                      ) : undefined}
                      showChevron={false}
                      onPress={() =>
                        props.onOpenReceipt(activeReceipt.deployment.id)
                      }
                    />
                    <View style={styles.facts}>
                      <FactStrip
                        testID="project-deployments.environment.facts"
                        facts={overviewFacts(detail, services.length, props.phone, activeReceipt?.facts.retainedPreviousCount ?? null, activeReceipt.deployment.state)}
                      />
                    </View>
                  </>
                ) : activeId && active.snapshot.status === 'unavailable' ? (
                  <SurfaceStateCard
                    testID="project-deployments.environment.serving.error"
                    size="line"
                    kind="error"
                    title={t('projects.deployments.servingErrorTitle')}
                    diagnosticCode={active.snapshot.failure?.code ?? null}
                    action={{
                      label: t('common.retry'),
                      testID:
                        'project-deployments.environment.serving.error.retry',
                      onPress: () => active.refresh(),
                    }}
                  />
                ) : activeId ? (
                  <SurfaceStateCard
                    size="line"
                    kind="loading"
                    title={t('projects.deployments.loading')}
                  />
                ) : (
                  <Item
                    testID="project-deployments.environment.serving.none"
                    title={t('projects.deployments.nothingDeployedTitle')}
                    // The linked target decides what deploys it; only an unlinked Environment falls back to its definition.
                    subtitle={(runtime ? runtime.source.kind === 'plugin' : !definition)
                      ? t('projects.deployments.platformLink.nothingDeployedBody')
                      : knownMachine(machineIds[0])
                        ? t('projects.deployments.nothingDeployedBody', { machine: knownMachine(machineIds[0])! })
                        : t('projects.deployments.nothingDeployedBodyAny')}
                    mode="info"
                  />
                )}
                {!activeId && props.openPreparation && detail.content.definition.kind === 'repository' && !detail.content.definition.compose && runtime?.source.kind !== 'plugin' ? (
                  <Item testID="project-deployments.environment.prepare"
                    title={t('projects.deployments.copy.prepareTitle')}
                    subtitle={t('projects.deployments.copy.prepareBody')}
                    disabled={preparing}
                    onPress={() => {
                      setPreparing(true);
                      setPreparationOutcome(null);
                      void props.openPreparation?.({ environmentId: detail.environment.id, name: detail.content.name })
                        .catch(error => {
                          const result = readDeploymentActionError(error);
                          if (result.kind === 'approval') review.request(result.artifactId);
                          setPreparationOutcome(result);
                        }).finally(() => setPreparing(false));
                    }} />
                ) : null}
                {preparationOutcome?.kind === 'refused' ? (
                  <SurfaceStateCard kind="error" size="line"
                    title={t('projects.deployments.copy.prepareTitle')}
                    diagnosticCode={preparationOutcome.code}
                    reason={deploymentActionRefusalRemedy(preparationOutcome.code)} />
                ) : preparationOutcome?.kind === 'approval' ? (
                  <DeployOutcomeBanner outcome={preparationOutcome}
                    pending={props.review.pendingId === preparationOutcome.artifactId} machine={null} onOpenReview={review.open} copy="setting" />
                ) : null}
              </ItemGroup>
              </ItemGroupDefaultSurfaceProvider>
              {services.length > 0 ? (
                <ItemGroup
                  testID="project-deployments.environment.services"
                  title={t('projects.deployments.servicesTitle')}
                  titleAccessory={<ManagedSectionCount count={services.length} />}
                  description={knownMachine(machineIds[0])
                    ? t('projects.deployments.servicesDescription', { machine: knownMachine(machineIds[0])! })
                    : t('projects.deployments.servicesDescriptionAny')}
                  action={machineIds.length === 1 ? (
                    <SectionActionButton
                      testID="project-deployments.environment.services.open"
                      // The description already names the Machine; the action says where it goes.
                      title={t('projects.deployments.openMachineServices')}
                      destination
                      onPress={() => router.push(machinePageHref({
                        door: 'rail', target: { machineId: machineIds[0]!, serverId: props.serverId }, tab: { id: 'services' },
                      }) as never)}
                    />
                  ) : undefined}
                >
                  {services.map((service) => (
                    <Item
                      key={service.name}
                      testID={`project-deployments.environment.services.${service.name}`}
                      title={service.name}
                      subtitle={service.reference
                        ? <Text variant="body" style={[styles.factsLine, styles.mono]} numberOfLines={1}>{service.reference}</Text>
                        : t('projects.deployments.serviceBuiltHere')}
                      mode="info"
                    />
                  ))}
                </ItemGroup>
              ) : null}
              {recentReceipts.length > 0 ? (
                <ItemGroup
                  testID="project-deployments.environment.recent"
                  title={t('projects.deployments.recent')}
                  action={
                    <SectionActionButton
                      testID="project-deployments.environment.recent.history"
                      title={t('projects.deployments.history')}
                      destination
                      onPress={() => openTab('history')}
                    />
                  }
                >
                  {recentReceipts.map(receiptRow)}
                </ItemGroup>
              ) : null}
              <DeploymentDataCard detail={detail}
                onOpen={props.onOpenDatabase}
                onVariables={() => openTab('variables')}
                onBackups={() => openTab('settings', 'backups')}
                onAdd={() => router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', query: 'database',
                  machine: { serverId: props.serverId, machineId: detail.environment.controllerMachineId } }) as never)} />
              {triggerSubject ? (
                <SubjectTriggersSection subject={triggerSubject}
                  subjectName={props.environmentTitle?.(props.environmentId) ?? machineName(triggerSubject.machineId)} />
              ) : null}
            </>
          ) : tab === 'history' ? (
            // The History tab names this list already; a section title would repeat it (lab d1 `history`).
            <ItemGroup
              testID="project-deployments.environment.history"
              header="none"
            >
              {receipts.map(receiptRow)}
              {history.hasPreviousPage || history.hasNextPage ? (
                <View style={styles.paging}>
                  {history.hasPreviousPage ? (
                    <SectionActionButton
                      testID="project-deployments.environment.history.newer"
                      title={t('projects.deployments.pageNewer')}
                      icon="caret-left"
                      onPress={history.previousPage}
                    />
                  ) : null}
                  {history.hasNextPage ? (
                    <SectionActionButton
                      testID="project-deployments.environment.history.older"
                      title={t('projects.deployments.pageOlder')}
                      icon="caret-right"
                      onPress={history.nextPage}
                    />
                  ) : null}
                </View>
              ) : null}
              <DeploymentTabState
                result={history.result}
                testID="project-deployments.environment.history"
                errorTitle={t('projects.deployments.historyErrorTitle')}
                emptyTitle={t('projects.deployments.historyEmpty')}
              />
            </ItemGroup>
          ) : tab === 'variables' ? (
            <DeploymentVariablesPanel
              draft={bindings}
              phone={props.phone}
              environmentName={props.environmentTitle ?? noEnvironmentName}
              sealedOn={
                machineIds.length > 0 ? machineName(machineIds[0]!) : null
              }
              review={review}
              scope={props.lifetime?.scope ?? null}
              lifetime={props.lifetime ?? null}
              environmentId={props.environmentId}
              machineId={machineIds.length === 1 ? machineIds[0] : null}
            />
          ) : tab === 'domains' ? (
            <DeploymentDomainsPanel
              controller={props.controller}
              environmentId={props.environmentId}
              demand={props.demand}
              phone={props.phone}
              editing={props.domainActions ? {
                actions: props.domainActions,
                environmentRevision: detail.environment.revision,
                targetLink: runtime ? { id: runtime.id, revision: runtime.revision } : null,
                review,
                machine: knownMachine(controllerMachineId ?? undefined) ?? t('projects.deployments.aMachine'),
                onChanged: () => { void environment.refresh(); },
              } : null}
            />
          ) : tab === 'permissions' ? (
            <DeploymentPermissionsPanel
              detail={detail}
              machineName={machineName}
              onOpenController={() => openTab('settings', 'controller')}
              editing={environmentEditing}
            />
          ) : (
            <DeploymentEnvironmentSettingsPanel
              detail={detail}
              controller={props.controller}
              demand={props.demand}
              machineName={machineName}
              environmentTitle={props.environmentTitle ?? noEnvironmentName}
              focusSection={settingsSection}
              onUnlink={disposition.canDelete ? openDisposition : null}
              onLink={openLink}
              onAddPlatform={openPlatform}
              retainedBackup={openRestore ? retainedBackup : null}
              onRestore={openRestore}
              review={review}
              lifetime={props.lifetime ?? null}
              editing={environmentEditing}
              onOpenMachineServices={(machineId) => router.push(machinePageHref({
                door: 'rail', target: { machineId, serverId: props.serverId }, tab: { id: 'services' },
              }) as never)}
            />
          )}
        </ItemList>
        {props.phone && deployButton ? (
          <KeyboardStickyFooter>
            <PagePinnedBar>{deployButton}</PagePinnedBar>
          </KeyboardStickyFooter>
        ) : null}
      </View>
    );
  },
);

/** The page's approval continuation, as the Environment and receipt pages use it. */
export type DeploymentReviewHandle = Readonly<{
  /** The approval still waiting on a decision, if any. */
  pendingId: string | null;
  request: (artifactId: string) => void;
  open: () => void;
}>;

/**
 * What the last Deploy, Roll back or Cancel press led to, in one banner: a review still open, accepted work, or a
 * refusal. `placement="inline"` draws it inside the pinned bar a phone pressed from.
 */
export function DeployOutcomeBanner(
  props: Readonly<{
    outcome: DeploymentActionOutcome;
    pending: boolean;
    /** Null for a platform target: no Machine to name, so the refusal's own code says why. */
    machine: string | null;
    onOpenReview: () => void;
    copy?: 'deploy' | 'rollback' | 'cancel' | 'domain' | 'setting';
    placement?: 'inline';
  }>,
) {
  const { outcome, placement } = props;
  const rollback = props.copy === 'rollback';
  const cancel = props.copy === 'cancel';
  const domain = props.copy === 'domain' || props.copy === 'setting';
  const setting = props.copy === 'setting';
  if (outcome.kind === 'receipt') return null;
  if (outcome.kind === 'approval') {
    // Once decided, the receipt itself speaks; a stale "waiting" would be untrue.
    if (!props.pending) return null;
    return (
      <AttentionBanner
        testID="project-deployments.outcome.approval"
        placement={placement}
        tone="neutral"
        title={t('projects.deployments.reviewWaitingTitle')}
        description={
          rollback
            ? t('projects.deployments.rollbackApprovalBody')
            : cancel
              ? t('projects.deployments.cancelApprovalBody')
              : domain
                ? t('projects.deployments.domainApprovalBody')
                : props.machine
                  ? t('projects.deployments.reviewWaitingBody', { machine: props.machine })
                  // A platform target has no Machine to name.
                  : t('projects.deployments.domainApprovalBody')
        }
        action={{
          label: t('projects.deployments.openReview'),
          onPress: props.onOpenReview,
        }}
      />
    );
  }
  if (outcome.kind === 'started') {
    // An accepted cancel settles on the receipt itself; "Deploy started" belongs to a new deploy only.
    if (cancel || domain) return null;
    return (
      <AttentionBanner
        testID="project-deployments.outcome.started"
        tone="neutral"
        title={t('projects.deployments.deployStartedTitle')}
        description={t('projects.deployments.deployStartedBody')}
      />
    );
  }
  // A cancel has no build to explain: an unsupported refusal reads as any other "couldn't cancel".
  const unsupported = outcome.reason === 'unsupported' && !cancel && !domain;
  const failure = outcome.failure ? presentActionFailureOutcome(outcome.failure, 'deployment') : null;
  return (
    <AttentionBanner
      testID={`project-deployments.outcome.refused.${outcome.reason}`}
      placement={placement}
      tone={
        unsupported || outcome.reason === 'machine'
          ? 'neutral'
          : 'danger'
      }
      title={
        unsupported
          ? t('projects.deployments.deployUnavailableTitle')
          : rollback
            ? t('projects.deployments.rollbackFailedTitle')
            : cancel
              ? t('projects.deployments.cancelFailedTitle')
              : setting
                ? t('projects.deployments.settingChangeFailedTitle')
                : domain
                  ? t('projects.deployments.domainChangeFailedTitle')
                : t('projects.deployments.deployFailedTitle')
      }
      description={
        failure?.reason ?? (outcome.reason === 'permission'
          ? t('projects.deployments.managersOnly')
          : outcome.reason === 'machine' && props.machine !== null
            ? t('projects.deployments.machineOffline', {
                machine: props.machine,
              })
            : unsupported && props.machine !== null
              ? t('projects.deployments.deployNeedsBuild', {
                  machine: props.machine,
                })
              : refusalConsequence(outcome.code))
      }
      // The typed code is for support; the sentence says what it left.
      details={failure ? failure.technicalDetails.map(line => `${line.label}: ${line.value}`) : [outcome.code]}
    />
  );
}

/**
 * What a refused press left, by its typed code. A press whose receipt settled failed or uncertain did change
 * something, so it never reads "Nothing changed": an uncertain one says so, a failed one lets the title speak.
 */
function refusalConsequence(code: string): string | undefined {
  if (code === 'outcome_unknown') return t('projects.deployments.unknownBody');
  if (code === 'deployment_failed' || code === 'cancelled') return undefined;
  return t('projects.deployments.nothingChanged');
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, minHeight: 0 },
  phoneDeploy: { flexGrow: 1 },
  phoneSplit: { flexGrow: 1, alignSelf: 'stretch' },
  split: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
  // The row already insets its bottom content; the strip only keeps its distance from the commit line.
  strip: { paddingTop: theme.space.s12 },
  facts: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s8,
  },
  factsLine: { color: theme.colors.text.secondary },
  mono: Typography.mono(),
  danger: { color: theme.colors.state.danger.textForeground },
  warning: { color: theme.colors.state.attention.textForeground },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 },
  rowMetaText: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  // The age column keeps one width so every row's duration lines up beside it.
  rowAge: { minWidth: theme.space.s48 + theme.space.s16, textAlign: 'right' },
}));

type DeploymentService = Readonly<{ name: string; reference: string | null }>;
const NO_SERVICES: readonly DeploymentService[] = [];

/**
 * What the receipt runs: its Compose services in order. A pulled image keeps its name and tag (the digest
 * stays on the receipt); an image this deploy built has no reference, so its row says where it was built.
 */
function deploymentServices(content: DeploymentContentV1): readonly DeploymentService[] {
  const names = content.ownServer?.approvedInputBasis.services
    ?? [...new Set(content.images.map((image) => image.service))];
  return names.map((name) => {
    const reference = content.images.find((candidate) => candidate.service === name)?.registryReference;
    return { name, reference: reference ? reference.split('@')[0]!.split('/').pop()! : null };
  });
}

/** The serving version's facts after its commit: who asked, when it settled, how long it took. */
function servingFacts(receipt: DeploymentReceiptHeaderV1, byYou: boolean): string[] {
  const facts: string[] = [];
  if (byYou) facts.push(t('projects.deployments.byYou'));
  facts.push(formatAsOfTime(receipt.settledAtMs ?? receipt.startedAtMs ?? receipt.requestedAtMs));
  const duration = deploymentDurationMs(receipt);
  if (duration !== null) facts.push(t('projects.deployments.took', { duration: formatElapsedDuration(duration) }));
  return facts;
}

/** The four headline facts under the serving version (lab `fc-facts`): health, services, rollout, rollback. */
function overviewFacts(detail: DeploymentEnvironmentDetailV1, serviceCount: number, phone: boolean, kept: number | null,
  servingState: DeploymentReceiptHeaderV1['state']): FactStripFact[] {
  const health = detail.healthAggregate;
  const facts: FactStripFact[] = [{
    key: 'health',
    testID: 'project-deployments.environment.facts.health',
    label: t('projects.deployments.healthTitle'),
    ...deploymentHealthFact(health, servingState),
  }];
  if (serviceCount > 0) {
    facts.push({ key: 'services', label: t('projects.deployments.servicesTitle'),
      value: t('projects.deployments.servicesFact', { count: serviceCount }) });
  }
  // A phone keeps the two facts a glance needs (lab d1p); rollout and rollback live in Settings.
  if (phone) return facts;
  if (detail.content.ownServer) {
    facts.push({ key: 'rollout', label: t('projects.deployments.sectionRollout'),
      value: detail.content.ownServer.rollout === 'startFirst'
        ? t('projects.deployments.rolloutFactStartFirst')
        : t('projects.deployments.rolloutFactRecreate') });
  }
  if (kept !== null) facts.push({ key: 'kept', label: t('projects.deployments.keptForRollback'),
    value: kept > 0 ? t('projects.deployments.keptCount', { count: kept }) : t('projects.deployments.keptNone') });
  return facts;
}

/** One quiet facts line: an optional state word in its tone, the short commit in mono, then the rest. */
function ReceiptFactsLine(props: Readonly<{
  sha: string | null;
  facts: readonly string[];
  lead?: Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null;
}>) {
  const parts: React.ReactNode[] = [];
  const push = (node: React.ReactNode) => {
    if (parts.length > 0) parts.push(' · ');
    parts.push(node);
  };
  if (props.lead) {
    push(<Text key="lead" style={props.lead.tone === 'danger' ? styles.danger : props.lead.tone === 'warning' ? styles.warning : null}>{props.lead.text}</Text>);
  }
  if (props.sha) push(<Text key="sha" style={styles.mono}>{props.sha}</Text>);
  for (const fact of props.facts) push(fact);
  return <Text variant="body" style={styles.factsLine} numberOfLines={1}>{parts}</Text>;
}

/** "you · 2 hours ago · took 49 s": who, when, how long, from the receipt header alone. */
export function describeReceipt(
  receipt: DeploymentReceiptHeaderV1,
  byYou: boolean,
): string {
  const parts: string[] = [];
  if (byYou) parts.push(t('projects.deployments.byYou'));
  parts.push(
    formatRelativeTime(
      receipt.settledAtMs ?? receipt.startedAtMs ?? receipt.requestedAtMs,
    ),
  );
  const duration = deploymentDurationMs(receipt);
  if (duration !== null)
    parts.push(
      t('projects.deployments.took', {
        duration: formatElapsedDuration(duration),
      }),
    );
  return parts.join(' · ');
}

const DeploymentReceiptRow = React.memo(function DeploymentReceiptRow(
  props: Readonly<{
    receipt: DeploymentReceiptHeaderV1 & Readonly<{ title?: string; failure?: DeploymentReceiptFailureV1 | null }>;
    live: boolean;
    byYou: boolean;
    phone: boolean;
    onPress: () => void;
  }>,
) {
  const { receipt } = props;
  const duration = deploymentDurationMs(receipt);
  const age = formatRelativeTimeShort(receipt.settledAtMs ?? receipt.startedAtMs ?? receipt.requestedAtMs, Date.now());
  // A settled success says nothing; trouble and work in progress lead the facts line in their tone.
  const lead = receipt.title ? deploymentHistoryLead(receipt, receipt.failure) : null;
  const facts = props.byYou ? [t('projects.deployments.byYou')] : [];
  // A phone keeps the title's width: duration and age join the facts line instead of a right column.
  if (props.phone) facts.push(...(duration !== null ? [formatElapsedDuration(duration)] : []), age);
  return (
    <Item
      testID={`project-deployments.receipt.row.${receipt.id}`}
      leftElement={
        <WorkStatusGlyph
          status={deploymentWorkStatus(receipt.state)}
          testIDSuffix={`deployment-${receipt.id}`}
        />
      }
      // The receipt's own title names what was deployed; without one its state is the title.
      title={receipt.title ?? deploymentStateLabel(receipt.state)}
      titleAccessory={
        props.live ? (
          <StatusPill
            variant="neutral"
            hideDot
            label={t('projects.deployments.live')}
          />
        ) : undefined
      }
      subtitle={lead || facts.length > 0 ? <ReceiptFactsLine sha={null} lead={lead} facts={facts} /> : undefined}
      rightElement={props.phone ? undefined : (
        <View style={styles.rowMeta}>
          {duration !== null ? (
            <Text variant="meta" style={styles.rowMetaText}>{formatElapsedDuration(duration)}</Text>
          ) : null}
          <Text variant="meta" style={[styles.rowMetaText, styles.rowAge]}>{age}</Text>
        </View>
      )}
      rightElementYields
      onPress={props.onPress}
    />
  );
});

/** Deploy's chevron (lab d1): Redeploy what is live. "Deploy a commit…" joins it when a commit picker exists. */
function DeployMoreMenu(
  props: Readonly<{
    disabled: boolean;
    phone: boolean;
    onRedeploy: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      {
        id: 'redeploy',
        testID: 'project-deployments.environment.deploy.more.redeploy',
        title: t('projects.deployments.redeployLive'),
        subtitle: t('projects.deployments.redeployLiveHint'),
        icon: (
          <Icon
            name="arrow-clockwise"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
    ],
    [theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={t('projects.deployments.moreWaysToDeploy')}
      onSelect={(id) => {
        if (id === 'redeploy') props.onRedeploy();
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID="project-deployments.environment.deploy.more"
          size="normal"
          joinedEdge="start"
          accessibilityLabel={t('projects.deployments.moreWaysToDeploy')}
          disabled={props.disabled}
          onPress={toggle}
          leading={
            <Icon
              name="caret-down"
              size={14}
              color={theme.colors.button.primary.tint}
            />
          }
        />
      )}
    />
  );
}

/** The header's ⋯ (lab d1): the Environment's rare operations, each leading to the page that owns it. */
function EnvironmentMenu(
  props: Readonly<{
    onOpenHistory: () => void;
    onOpenSettings: () => void;
    onDuplicate?: () => void;
    /** "Delete Staging…", last and destructive; null where this viewer cannot delete it. */
    deleteTitle: string | null;
    onDelete: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      ...(props.onDuplicate ? [{ id: 'duplicate', testID: 'project-deployments.environment.menu.duplicate',
        title: t('projects.deployments.copy.menu'),
        icon: <Icon name="copy" size={16} color={theme.colors.text.secondary} /> }] : []),
      {
        id: 'history',
        testID: 'project-deployments.environment.menu.history',
        title: t('projects.deployments.menuRollBack'),
        subtitle: t('projects.deployments.menuRollBackHint'),
        icon: (
          <Icon
            name="clock-counter-clockwise"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
      {
        id: 'settings',
        testID: 'project-deployments.environment.menu.settings',
        title: t('projects.deployments.menuEdit'),
        icon: (
          <Icon
            name="sliders-horizontal"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
      ...(props.deleteTitle
        ? [{
            id: 'delete',
            testID: 'project-deployments.environment.menu.delete',
            title: props.deleteTitle,
            destructive: true,
            icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />,
          }]
        : []),
    ],
    [props.deleteTitle, props.onDuplicate, theme.colors.state.danger.foreground, theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={t('common.more')}
      onSelect={(id) => {
        if (id === 'history') props.onOpenHistory();
        else if (id === 'duplicate') props.onDuplicate?.();
        else if (id === 'settings') props.onOpenSettings();
        else if (id === 'delete') props.onDelete();
      }}
      trigger={({ toggle }) => (
        <IconButton
          testID="project-deployments.environment.menu"
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('common.more')}
          onPress={toggle}
        />
      )}
    />
  );
}
