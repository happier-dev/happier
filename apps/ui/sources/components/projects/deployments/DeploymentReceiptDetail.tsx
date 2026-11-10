import type { DeploymentEnvironmentDestinationV1 } from '@happier-dev/deployments';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
  DeploymentReceiptFactsV1,
} from '@happier-dev/deployments';
import { isDeploymentRollbackSourceEligibleV1, type DeploymentMachineResultV1 } from '@happier-dev/deployment-protocol/v1';
import { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentStateV1';

import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { InvestigationAgentActionButtons, type InvestigationAgentActionButtonModel } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { readDeploymentRefusalRecoveryV1, type DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { useAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useInvestigationSessionResult } from '@/hooks/inbox/useInvestigationSessionResult';
import { OperationsOutcomeGroup } from '@/components/workflows/run/OperationsOutcomeGroup';
import { Item } from '@/components/ui/lists/Item';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { resolvePublicShareApplicationBaseUrl } from '@/components/sessions/sharing/publicShareApplicationUrl';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { Modal } from '@/modal';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  canPromoteDeploymentReceipt,
  deploymentDeployAvailability,
  deploymentFailureTitle,
  deploymentHeadline,
  deploymentHealthFact,
  deploymentMachineHealthLabel,
  deploymentRevisionLabel,
  deploymentSourceLabel,
  deploymentStateLabel,
  deploymentStateNotice,
  deploymentWorkStatus,
} from './deploymentPresentation';
import { describeReceipt, DeployOutcomeBanner, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { useDeploymentPress } from './deploymentActionOutcome';
import { useDeploymentCancellation } from './useDeploymentCancellation';
import type { createDeploymentActions } from './deploymentActions';
import { useDeploymentEnvironment, useDeploymentReceipt } from './useDeploymentReads';
import { DeploymentStepLogs } from './DeploymentStepLogs';
import { showDeploymentPromotionSheet } from './DeploymentPromotionSheet';
import type { DeploymentReadLogs } from './useDeploymentStepLog';

/**
 * One immutable receipt (lab d3 `failed|success|unknown|live`): what happened to which version, the outcome it
 * left (the live address and its health, or what failed, what it left serving and the log's last lines), the
 * few facts that say how it is now, then the steps on each Machine in order. Everything historical comes from
 * the receipt's own facts; current health is the Environment's, joined beside it. An uncertain outcome says so
 * once and never offers a blind retry.
 */
/** The receipt draws the person's Investigate plus its own records; an unresolved placement opens the composer. */
const RECEIPT_AGENT_ACTIONS = { agentActions: 'withDefault' } as const;

export const DeploymentReceiptDetail = React.memo(
  function DeploymentReceiptDetail(
    props: Readonly<{
      controller: DeploymentReadControllerV1;
      environmentId: string;
      deploymentId: string;
      environmentName: string | null;
      demand: DeploymentReadDemandV1;
      accountId: string;
      onBack: () => void;
      /** Leaves the receipt for one of its Environment's pages (a recovery's next action: Variables, History, Logs). */
      onOpenEnvironmentTab?: (next: DeploymentEnvironmentDestinationV1) => void;
      /** The Action owner's rollback; absent while the Source's Account is not current. */
      rollback: ReturnType<typeof createDeploymentActions>['rollback'] | null;
      /** The Action owner's cancel, offered only while the receipt read says this receipt is cancellable. */
      cancel: ReturnType<typeof createDeploymentActions>['cancel'] | null;
      /** The Action owner's Deploy, for "Deploy again" of a failed receipt's own commit. */
      deploy: ReturnType<typeof createDeploymentActions>['deploy'] | null;
      /** Resumes this teardown receipt through the same Action owner. */
      teardown?: ReturnType<typeof createDeploymentActions>['teardown'] | null;
      promote?: ReturnType<typeof createDeploymentActions>['promote'] | null;
      onOpenPromotionReceipt?: (environmentId: string, deploymentId: string) => void;
      phone: boolean;
      /** This receipt's in-app path, for Copy link; null where it has no stable address. */
      linkPath: string | null;
      review: DeploymentReviewHandle;
      onOpenReceipt: (deploymentId: string) => void;
      serverId: string;
      /** The Action owner's per-step stage-log read; absent while the Source's Account is not current. */
      readLogs: DeploymentReadLogs | null;
      /** Opens the Environment where a failure's canonical next action points (RECOVERY-COPY); absent, it is not offered. */
      onOpenRecoveryDestination?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
    }>,
  ) {
    // The serving pointer lives on the Environment's runtime link; the controller shares that read.
    const environment = useDeploymentEnvironment(props.controller, props.environmentId, props.demand);
    const environmentValue = environment.snapshot.value;
    const activeId = environmentValue?.runtimeTargetLink?.activeDeploymentId ?? null;
    // Each control keeps its own answer, so the banner speaks for the press it follows.
    const rollbackPress = useDeploymentPress(props.review, props.onOpenReceipt);
    const againPress = useDeploymentPress(props.review, props.onOpenReceipt);
    const receipt = useDeploymentReceipt(
      props.controller,
      props.environmentId,
      props.deploymentId,
      props.demand,
    );
    const value = receipt.snapshot.value;
    const { press: cancelPress, canCancel, cancelRequested, pressCancel } = useDeploymentCancellation({
      receipt: value, cancel: props.cancel, review: props.review, onOpenReceipt: props.onOpenReceipt,
    });
    const machineIds = React.useMemo(
      () => value?.content.machines ?? [],
      [value?.content.machines],
    );
    const machineNames = useMachineDisplayNamesById(machineIds);
    const { theme } = useUnistyles();
    const onBack = props.onBack;
    const backControl = usePageBackControl('project-deployments.receipt.back', onBack);
    const router = useRouter();
    // A failed receipt is evidence: Investigate hands this exact receipt to configured Triage (D5),
    // through the Account's one investigation owner, never a page-local investigator.
    const failed = value?.deployment.state === 'failed';
    const investigateSubject = React.useMemo(() => failed ? { kind: 'deploymentReceipt' as const,
      serverId: props.serverId, environmentId: props.environmentId, deploymentId: props.deploymentId } : null,
    [failed, props.serverId, props.environmentId, props.deploymentId]);
    // The person's Investigate and this receipt's own records; an unresolved placement opens the composer.
    const investigation = useInvestigateFailure(investigateSubject, RECEIPT_AGENT_ACTIONS);
    const investigationOwner = useAccountNoticeInvestigation();
    const showInvestigationOutcome = investigation.showOutcome;
    const fallbackInvestigate = React.useMemo((): readonly InvestigationAgentActionButtonModel[] => [{
      label: t('inbox.work.healthNotice.investigate'), launchMode: 'review', startable: true,
    }], []);
    const persistedInvestigation = useInvestigationSessionResult(investigationOwner, investigateSubject, investigation.outcome);
    const outcomeInput = React.useMemo(() => persistedInvestigation && investigateSubject ? {
      subject: investigateSubject,
      finding: { kind: 'investigate' as const, ...persistedInvestigation },
      produced: persistedInvestigation.produced,
      subjectReceipt: value?.deployment ?? null,
      healthServerId: props.serverId,
      health: receipt.healthFeed,
    } : null, [persistedInvestigation, investigateSubject, value?.deployment, props.serverId, receipt.healthFeed]);
    const { onOpenReceipt, onOpenPromotionReceipt } = props;
    // A remediation can land on another Environment of this Project; both open through this page's own receipt navigation.
    const openOutcomeReceipt = React.useMemo(() => ({ serverId: props.serverId,
      open: (environmentId: string, deploymentId: string) => {
        if (environmentId === props.environmentId) onOpenReceipt(deploymentId);
        else onOpenPromotionReceipt?.(environmentId, deploymentId);
      } }), [props.serverId, props.environmentId, onOpenReceipt, onOpenPromotionReceipt]);

    if (!value) {
      return (
        <ItemList testID="project-deployments.receipt.state">
          {receipt.snapshot.status === 'unavailable' ? (
            <SurfaceStateCard
              kind="error"
              title={t('projects.deployments.environmentErrorTitle')}
              diagnosticCode={receipt.snapshot.failure?.code ?? null}
              action={{
                label: t('common.retry'),
                onPress: () => {
                  void receipt.refresh();
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
    const { deployment, content, facts } = value;
    // The canonical remedy and next action for the recorded cause (RECOVERY-COPY); no page-local copy.
    const recovery = deployment.state === 'failed' && facts.failure
      ? readDeploymentRefusalRecoveryV1(facts.failure.code, facts.failure) : null;
    const { rollback, deploy, teardown, promote, environmentId, phone } = props;
    // Source eligibility is shared with admission; the serving release needs no rollback.
    const retainedTarget = facts.retainedRollbackTarget;
    const canRollBack = retainedTarget !== null && rollback !== null;
    const { review } = props;
    const rollingBack = rollbackPress.running;
    const reviewPending = rollbackPress.reviewPending;
    // Every press is reviewed or refused by the Action owner (the approval page is its confirmation); none here.
    const rollBack = (deploymentId: string, restoreBackupId?: string) => {
      if (!rollback) return;
      void rollbackPress.press(() => rollback({ environmentId, deploymentId,
        ...(restoreBackupId === undefined ? {} : { restoreBackupId }) }));
    };
    // Deploy again builds this receipt's own commit through the Environment's runtime link, as "Redeploy" does.
    const availability = environmentValue ? deploymentDeployAvailability(environmentValue) : null;
    const againSha = content.sourceIntent?.kind === 'repository' ? content.sourceIntent.sha : null;
    // A kept-for-rollback release restarts as it was (Roll back); one that was cleaned up can only be built again
    // (lab rollback/pruned). Its history must be complete before "not kept" is a fact rather than a gap.
    const releasePruned = isDeploymentRollbackSourceEligibleV1(deployment.state) && activeId !== null
      && activeId !== deployment.id && facts.retainedRollbackTarget === null && facts.retainedPreviousCount !== null;
    const retryTeardown = deployment.operation === 'teardown'
      && (deployment.state === 'failed' || deployment.state === 'outcome_unknown')
      && teardown != null && content.teardown !== undefined;
    const againTarget = deployment.operation !== 'teardown' && (deployment.state === 'failed' || releasePruned) && deploy !== null && againSha !== null
      && availability?.kind === 'ready' ? availability.targetLinkId : null;
    const pressAgain = () => {
      if (retryTeardown && teardown && content.teardown) {
        const reason = content.teardown.reason;
        void againPress.press(() => teardown({ environmentId, targetLinkId: deployment.targetLinkId,
          requestKey: deployment.requestKey, reason }, { confirmed: true }));
        return;
      }
      if (!deploy || !againTarget || !againSha) return;
      void againPress.press(() => deploy({ environmentId, targetLinkId: againTarget, sha: againSha }));
    };
    const machineName = (machineId: string) =>
      machineNames[machineId] ?? t('projects.deployments.aMachine');
    const images = 'images' in content ? content.images : NO_IMAGES;
    const notice = deploymentStateNotice(deployment.state, facts.failure);
    const serving = activeId !== null && activeId === deployment.id;
    const firstMachine = machineName(content.machines[0] ?? '');
    // A failed deploy's way back is the incumbent it recorded; the rollback Action decides admission at the press.
    const target = facts.rollbackTarget;
    const restored = content.machineResults.length > 0
      && content.machineResults.every((result) => result.restoration === 'succeeded');
    const migrationRan = content.steps.some(step => step.id === 'own-server-migration' && step.state !== 'skipped');
    const migrationPolicy = content.ownServer?.approvedInputBasis.ownServer?.migrationFailurePolicy;
    const backupId = content.ownServer?.preMigrationBackup?.source.snapshot.snapshotId;
    const needsBackupChoice = migrationRan && (migrationPolicy === 'ask' || migrationPolicy === 'restoreBackupAndRollbackCode');
    // Restoring code does not restore migrated data, even when the incumbent is already serving again.
    const backupTarget = needsBackupChoice && backupId && deployment.state === 'failed' && rollback !== null ? target : null;
    const codeTarget = (!migrationRan || migrationPolicy === 'rollbackCodeOnly' || migrationPolicy === 'ask')
      && deployment.state === 'failed' && rollback !== null && !restored ? facts.retainedRollbackTarget : null;
    const rollbackTarget = backupTarget ?? codeTarget;
    const retryRollbackTo = deployment.state === 'failed' && deployment.operation === 'rollback' && rollback !== null
      && !rollbackTarget ? deployment.rollbackOfDeploymentId ?? null : null;
    // Deploy again leads the failure when nothing better does; a phone already holds it in its pinned bar.
    const bannerAgain = deployment.state === 'failed' && !rollbackTarget && !retryRollbackTo && againTarget !== null && !phone;
    const chooseRecovery = () => {
      if (!rollbackTarget) return;
      if (backupTarget && migrationPolicy === 'ask') {
        Modal.alert(t('projects.deployments.chooseRecovery'), t('projects.deployments.chooseRecoveryBody'), [
          { text: t('projects.deployments.restoreBackupAndCode'), onPress: () => rollBack(backupTarget.deploymentId, backupId) },
          ...(codeTarget ? [{ text: t('projects.deployments.rollbackCodeOnly'), onPress: () => rollBack(codeTarget.deploymentId) }] : []),
          { text: t('common.cancel'), style: 'cancel' },
        ]);
      } else rollBack(rollbackTarget.deploymentId, backupTarget ? backupId : undefined);
    };
    const stripFacts = receiptFacts({
      facts,
      serving,
      health: environmentValue?.healthAggregate,
      state: deployment.state,
    });
    // The shared agent-action control (DEPLOY-COMPOSE R4) for each of the person's records: its face launches in the
    // record's own mode, the chevron offers the other. Until the catalog answers, the default Investigate stands in.
    const investigateControl = (
      <InvestigationAgentActionButtons
        actions={investigation.actions ?? fallbackInvestigate}
        pending={investigation.pending}
        compact={phone}
        onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }}
      />
    );
    const showLogs = deployment.state === 'failed' || deployment.state === 'outcome_unknown'
      || deployment.state === 'cancelled';
    // With a reader, the existing viewer opens operation references even when no steps were recorded.
    const logs = showLogs && !props.readLogs ? facts.logs.filter((log) => log.excerpt !== null) : [];
    const meta: PageHeaderMetaFact[] = [
      {
        key: 'when',
        text: describeReceipt(
          deployment,
          deployment.requestedByAccountId === props.accountId,
        ),
      },
      ...(props.environmentName
        ? [
            {
              key: 'environment',
              text: props.environmentName,
              icon: 'hard-drives' as const,
            },
          ]
        : []),
    ];
    // One Machine reads as one list of steps; several Machines each get their own section, in rollout order.
    const perMachine = content.machineResults.length > 1;
    const rollbackButton = canRollBack ? (
      <RoundButton
        testID="project-deployments.receipt.rollback"
        display="inverted"
        title={t('projects.deployments.rollbackTo', { version: deploymentRevisionLabel(retainedTarget!.revision) })}
        loading={rollingBack}
        disabled={rollingBack || reviewPending}
        onPress={() => { rollBack(retainedTarget!.deploymentId); }}
      />
    ) : null;
    // The running receipt's one action (lab d3 `live`): Cancel in the header, or spanning a phone's pinned bar.
    // Cancel leads only while the work runs; an unconfirmed receipt the server still lets you cancel keeps it in ⋯.
    const cancelLeads = canCancel && deploymentInProgressStates().includes(deployment.state);
    const cancelButton = cancelLeads ? (
      <RoundButton
        testID="project-deployments.receipt.cancel"
        size="normal"
        display="secondary"
        style={phone ? styles.phoneAction : undefined}
        title={t('common.cancel')}
        leading={<Icon name="stop-circle" size={14} color={theme.colors.text.secondary} />}
        loading={cancelPress.running || cancelRequested}
        disabled={cancelPress.running || cancelRequested || cancelPress.reviewPending}
        onPress={pressCancel}
      />
    ) : null;
    // A failed receipt's way forward beside Roll back (lab d3 `failed` header).
    const againButton = retryTeardown || (againTarget && deployment.state === 'failed') ? (
      <RoundButton
        testID="project-deployments.receipt.deployAgain"
        size="normal"
        display="secondary"
        style={phone ? styles.phoneAction : undefined}
        title={retryTeardown ? t('common.retry') : t('projects.deployments.deployAgain')}
        leading={<Icon name="arrow-clockwise" size={14} color={theme.colors.text.secondary} />}
        loading={againPress.running}
        disabled={againPress.running || againPress.reviewPending}
        onPress={pressAgain}
      />
    ) : null;
    const pinned = cancelButton ?? againButton;
    const pinnedOutcome = cancelButton ? cancelPress : againPress;
    const menu = (
      <ReceiptMenu
        onCancel={canCancel && !cancelLeads ? pressCancel : undefined}
        linkPath={props.linkPath}
        environmentName={props.environmentName}
        onOpenEnvironment={onBack}
        onPromote={environmentValue && canPromoteDeploymentReceipt(value, environmentValue) && promote
          ? () => showDeploymentPromotionSheet({ controller: props.controller,
              sourceEnvironmentId: environmentId, sourceDeploymentId: deployment.id,
              name: props.environmentName ?? environmentValue.content.name, version: deploymentSourceLabel(content) ?? deployment.id,
              promote, review: props.review,
              onOpenReceipt: (destinationId, deploymentId) => props.onOpenPromotionReceipt?.(destinationId, deploymentId),
            }) : undefined}
      />
    );
    const headerActions = phone ? (
      rollbackButton || menu ? <View style={styles.headerActions}>{rollbackButton}{menu}</View> : undefined
    ) : (
      <View style={styles.headerActions}>
        {rollbackButton}
        {cancelButton}
        {bannerAgain ? null : againButton}
        {menu}
      </View>
    );
    const outcomeBanner = (
      press: Readonly<{ outcome: ReturnType<typeof useDeploymentPress>['outcome']; reviewPending: boolean }>,
      copy: 'deploy' | 'rollback' | 'cancel',
      placement?: 'inline',
    ) => press.outcome ? (
      <DeployOutcomeBanner
        outcome={press.outcome}
        pending={press.reviewPending}
        machine={content.machines[0] ? firstMachine : null}
        onOpenReview={review.open}
        copy={copy}
        placement={placement}
      />
    ) : null;
    // Each step's own masked log (DEP-43); receipts whose steps carry no refs keep the tail above.
    const stepLogs = {
      facts,
      running: deployment.state === 'running' || deployment.state === 'queued',
      serverId: props.serverId,
      readLogs: props.readLogs,
      fileStem: `deploy-${deployment.id}`,
    };
    return (
      <NavigationBackChromeProvider control={backControl}>
        <View style={styles.page}>
          <ItemList testID="project-deployments.receipt">
            <PageHeader
              testID="project-deployments.receipt.header"
              title={deploymentHeadline(deployment, content)}
              alwaysShowTitle
              // The commit's own subject says what this version is; a stored definition has none.
              description={facts.commitSubject ?? undefined}
              descriptionLines={2}
              meta={meta}
              actions={headerActions}
              // A phone's lone ⋯ hangs from the title line (lab d3p); a wider Roll back still wraps beneath.
              actionsLayout={phone && !rollbackButton ? 'hang' : undefined}
              actionsPlacement="page"
            />
            {outcomeBanner(rollbackPress, 'rollback')}
            {/* A phone pressed these in its pinned bar, so their answers show there. */}
            {phone ? null : outcomeBanner(cancelPress, 'cancel')}
            {phone && !releasePruned ? null : outcomeBanner(againPress, 'deploy')}
            {releasePruned && againTarget && againSha ? (
              <AttentionBanner
                testID="project-deployments.receipt.pruned"
                tone="neutral"
                title={t('projects.deployments.receipt.prunedTitle')}
                description={t('projects.deployments.receipt.prunedBody', { sha: deploymentSourceLabel(content) ?? againSha.slice(0, 7) })}
                action={{
                  label: t('projects.deployments.receipt.deployShaAgain', { sha: deploymentSourceLabel(content) ?? againSha.slice(0, 7) }),
                  icon: 'arrow-clockwise',
                  testID: 'project-deployments.receipt.pruned.deployAgain',
                  loading: againPress.running,
                  disabled: againPress.running || againPress.reviewPending,
                  onPress: pressAgain,
                }}
              />
            ) : null}
            {deployment.state === 'failed' ? (
              <AttentionBanner
                testID="project-deployments.receipt.outcome.failed"
                tone="danger"
                iconName="x-circle"
                title={deploymentFailureTitle(facts.failure, deployment.operation)}
                // What is serving now (the receipt's own facts), then the canonical remedy for its recorded cause.
                description={[failureConsequence(facts, content.machineResults, firstMachine), recovery?.remedy ?? null]
                  .filter(Boolean).join(' ') || undefined}
                action={rollbackTarget ? {
                  label: backupTarget ? t(migrationPolicy === 'ask' ? 'projects.deployments.chooseRecovery' : 'projects.deployments.restoreBackupAndCode')
                    : migrationRan ? t('projects.deployments.rollbackCodeOnly')
                      : t('projects.deployments.rollbackTo', { version: deploymentRevisionLabel(rollbackTarget.revision) }),
                  icon: 'arrow-arc-left',
                  loading: rollingBack,
                  disabled: rollingBack || reviewPending,
                  onPress: chooseRecovery,
                } : retryRollbackTo ? {
                  // A failed rollback's way forward is the same rollback again, to the release it was restoring.
                  label: t('projects.deployments.rollbackTo', { version: deploymentSourceLabel(content) ?? retryRollbackTo.slice(0, 7) }),
                  icon: 'arrow-arc-left',
                  loading: rollingBack,
                  disabled: rollingBack || reviewPending,
                  onPress: () => rollBack(retryRollbackTo),
                } : bannerAgain ? {
                  label: t('projects.deployments.deployAgain'),
                  icon: 'arrow-clockwise',
                  loading: againPress.running,
                  disabled: againPress.running || againPress.reviewPending,
                  onPress: pressAgain,
                } : null}
                // Recovery leads when there is one; finding out why is the way forward beside it.
                control={investigateControl}
                // The canonical next action opens where the cause is fixed; it never retries anything.
                moreActions={recovery && props.onOpenRecoveryDestination ? [{
                  label: recovery.nextAction.label,
                  testID: 'project-deployments.receipt.outcome.failed.recovery',
                  onPress: () => props.onOpenRecoveryDestination?.(recovery.nextAction.destination),
                }] : undefined}
                details={facts.failure ? [facts.failure.code] : undefined}
              />
            ) : deployment.state === 'succeeded' ? (
              <SucceededOutcome
                serverId={props.serverId}
                accountId={props.accountId}
                facts={facts}
                machine={firstMachine}
                serving={serving}
              />
            ) : null}
            {showInvestigationOutcome && investigation.outcome ? <InvestigationOutcomeBanner outcome={investigation.outcome} serverId={props.serverId}
              testID="project-deployments.receipt.investigate" onChoosePlacement={investigation.investigateWithPlacement} pending={investigation.pending} /> : null}
            {notice ? (
              <AttentionBanner
                testID={`project-deployments.receipt.notice.${deployment.state}`}
                tone={notice.tone}
                title={deploymentStateLabel(deployment.state)}
                description={notice.text}
                // An unknown outcome is settled by looking at what runs: the Machine's Services say it.
                {...(deployment.state === 'outcome_unknown' && content.machines.length === 1 ? { action: {
                  label: t('projects.deployments.openMachineServices'),
                  onPress: () => router.push(machinePageHref({ door: 'rail',
                    target: { machineId: content.machines[0]!, serverId: props.serverId }, tab: { id: 'services' } }) as never),
                } } : {})}
              />
            ) : null}
            {/* The agent's finding follows what failed: it is the answer the page exists for, read before the record. */}
            {outcomeInput ? <OperationsOutcomeGroup input={outcomeInput} testID="project-deployments.receipt.outcome" openReceipt={openOutcomeReceipt} /> : null}
            {stripFacts.length > 0 ? (
              <ItemGroup surface="none" testID="project-deployments.receipt.facts">
                <View style={styles.facts}>
                  <FactStrip facts={stripFacts} />
                </View>
              </ItemGroup>
            ) : null}
            {images.length > 0 ? (
              // The exact images this release ran (lab `rollback/image`): what a rollback to it starts again.
              <ItemGroup
                testID="project-deployments.receipt.images"
                title={t('projects.deployments.receipt.imagesTitle')}
                description={t('projects.deployments.receipt.imagesDescription')}
              >
                {images.map((image) => (
                  <Item
                    key={`${image.service}:${image.platform}`}
                    testID={`project-deployments.receipt.image.${image.service}.${image.platform}`}
                    title={image.service}
                    subtitle={image.registryReference ?? image.configDigest}
                    subtitleStyle={styles.mono}
                    subtitleLines={phone ? 2 : 1}
                    detail={image.platform}
                    showChevron={false}
                  />
                ))}
              </ItemGroup>
            ) : null}
            {logs.map((log) => (
              <ItemGroup
                key={`${log.reference.machineId}:${log.reference.installationId}`}
                testID="project-deployments.receipt.log"
                title={t('projects.deployments.logTitle')}
                description={log.excerpt!.truncated
                  ? t('projects.deployments.logTail', { machine: machineName(log.reference.machineId) })
                  : t('projects.deployments.logWhole', { machine: machineName(log.reference.machineId) })}
                surface="none"
              >
                <CodeBlockView code={log.excerpt!.text} showHeaderRow={false} wrap showCopyButton />
              </ItemGroup>
            ))}
            {perMachine ? (
              content.machineResults.map((result) => (
                <DeploymentStepLogs
                  key={result.machineId}
                  testID={`project-deployments.receipt.machine.${result.machineId}`}
                  title={t('projects.deployments.stepsOn', { machine: machineName(result.machineId) })}
                  machineName={machineName(result.machineId)}
                  machineNames={machineNames}
                  outcome={machineOutcome(result) ?? undefined}
                  machineId={result.machineId}
                  steps={result.steps}
                  {...stepLogs}
                />
              ))
            ) : (
              <DeploymentStepLogs
                testID="project-deployments.receipt.steps"
                title={t('projects.deployments.steps')}
                // The outcome above already says what this Machine was left with; the steps only name where they ran.
                machineName={content.machineResults[0] ? machineName(content.machineResults[0].machineId) : firstMachine}
                machineNames={machineNames}
                machineId={content.steps.length > 0 ? undefined : content.machineResults[0]?.machineId}
                steps={content.steps.length > 0 ? content.steps : (content.machineResults[0]?.steps ?? [])}
                {...stepLogs}
              />
            )}
          </ItemList>
          {phone && pinned ? (
            <KeyboardStickyFooter>
              <PagePinnedBar testID="project-deployments.receipt.bar" style={styles.bar}>
                {outcomeBanner(pinnedOutcome, cancelButton ? 'cancel' : 'deploy', 'inline')}
                {pinned}
              </PagePinnedBar>
            </KeyboardStickyFooter>
          ) : null}
        </View>
      </NavigationBackChromeProvider>
    );
  },
);

/** The receipt header's ⋯ (lab d3): its link, and the Environment it belongs to. */
function ReceiptMenu(props: Readonly<{
  linkPath: string | null;
  environmentName: string | null;
  onOpenEnvironment: () => void;
  onPromote?: () => void;
  onCancel?: () => void;
}>) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const writeClipboard = useClipboardWrite(undefined, { enabled: open });
  const { linkPath, environmentName } = props;
  const items = React.useMemo((): readonly DropdownMenuItem[] => [
    ...(props.onCancel ? [{ id: 'cancel', testID: 'project-deployments.receipt.menu.cancel', title: t('common.cancel'),
      icon: <Icon name="stop-circle" size={16} color={theme.colors.text.secondary} />,
    }] : []),
    ...(props.onPromote ? [{ id: 'promote', testID: 'project-deployments.receipt.promote',
      title: t('projects.deployments.promotion.open'),
      icon: <Icon name="arrow-up-right" size={16} color={theme.colors.text.secondary} />,
    }] : []),
    ...(linkPath ? [{
      id: 'copy',
      testID: 'project-deployments.receipt.menu.copy',
      title: t('shareSheet.copyLink'),
      icon: <Icon name="link" size={16} color={theme.colors.text.secondary} />,
    }] : []),
    ...(environmentName ? [{
      id: 'environment',
      testID: 'project-deployments.receipt.menu.environment',
      title: t('projects.deployments.menuOpenEnvironment', { name: environmentName }),
      icon: <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
    }] : []),
  ], [environmentName, linkPath, props.onPromote, props.onCancel, theme.colors.text.secondary]);
  if (items.length === 0) return null;
  const copy = async (path: string) => {
    const copied = await writeClipboard(`${resolvePublicShareApplicationBaseUrl()}${path}`);
    if (!copied) {
      Modal.alert(t('common.error'), t('shareSheet.copyLinkFailed'));
      return;
    }
    announceAccessibilityMessage(t('shareSheet.linkCopied'));
  };
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
        if (id === 'cancel') props.onCancel?.();
        else if (id === 'promote') props.onPromote?.();
        else if (id === 'copy' && linkPath) void copy(linkPath);
        else if (id === 'environment') props.onOpenEnvironment();
      }}
      trigger={({ toggle }) => (
        <IconButton
          testID="project-deployments.receipt.menu"
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('common.more')}
          onPress={toggle}
        />
      )}
    />
  );
}

/**
 * A successful deploy's outcome is the thing itself (lab d3 `success`): the address it recorded, or the Machine
 * it serves on, with the health it had when it settled and the downtime it took.
 */
const SucceededOutcome = React.memo(function SucceededOutcome(props: Readonly<{
  facts: DeploymentReceiptFactsV1;
  machine: string;
  serving: boolean;
  serverId: string;
  accountId: string;
}>) {
  const url = props.facts.urls?.[0] ?? null;
  const address = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const members = props.facts.health.members;
  const parts: string[] = [];
  if (members.length > 0 && members.every((member) => member.health === 'healthy')) parts.push(t('projects.deployments.receiptHealthPassed'));
  else if (members.some((member) => member.health === 'unhealthy')) parts.push(t('projects.deployments.receiptHealthFailed'));
  if (props.facts.downtime === 'stopThenStart') parts.push(t('projects.deployments.downtimeBrief'));
  return (
    // The outcome is its own card (lab d3 `success` hero), like the failure notice in the same place.
    <ItemGroup testID="project-deployments.receipt.outcome.succeeded">
      <Item
        testID="project-deployments.receipt.outcome.succeeded.row"
        leftElement={<WorkStatusGlyph status={deploymentWorkStatus('succeeded')} testIDSuffix="deployment-outcome" />}
        title={address
          ? t('projects.deployments.liveAt', { address })
          : props.serving
            ? t('projects.deployments.servingOn', { machine: props.machine })
            : t('projects.deployments.ranOn', { machine: props.machine })}
        subtitle={parts.length > 0 ? parts.join(' · ') : undefined}
        rightElement={url ? (
          <View style={styles.outcomeActions}>
            <CopyIconButton text={url} testID="project-deployments.receipt.outcome.copy" />
            <RoundButton
              testID="project-deployments.receipt.outcome.open"
              size="small"
              title={t('common.open')}
              onPress={() => { void requestOpenExternalUrl(url, { serverId: props.serverId, expectedAccountId: props.accountId }); }}
            />
          </View>
        ) : undefined}
        mode="info"
      />
    </ItemGroup>
  );
});

/**
 * What the failure left, in one sentence: whether the incumbent is back (named by its own identity; there is no
 * ordinal), that nothing changed when it failed before the roll-out, or that nothing served before. Silent when
 * the receipt recorded none of it.
 */
function failureConsequence(
  facts: DeploymentReceiptFactsV1,
  results: readonly DeploymentMachineResultV1[],
  machine: string,
): string | null {
  const sha = facts.rollbackTarget ? deploymentRevisionLabel(facts.rollbackTarget.revision) : null;
  const restorations = results.flatMap((result) => (result.restoration ? [result.restoration] : []));
  if (restorations.some((restoration) => restoration === 'failed' || restoration === 'unreachable')) {
    return sha ? t('projects.deployments.failureRestoreFailed', { sha }) : t('projects.deployments.restoreFailed');
  }
  if (restorations.includes('outcome_unknown')) return t('projects.deployments.failureRestoreUnknown');
  if (restorations.length > 0) {
    return sha ? t('projects.deployments.failureRestored', { sha }) : t('projects.deployments.restoredPrevious');
  }
  const phase = facts.failure?.phase;
  if (phase === 'source' || phase === 'build' || phase === 'admission') {
    return t('projects.deployments.failureNothingChanged', { machine });
  }
  if (facts.rollbackTarget === null) return t('projects.deployments.failureFirstDeploy');
  // It failed after the roll-out and nothing restored the incumbent: say so, so the way back reads as needed.
  if (sha && (phase === 'activate' || phase === 'observe')) return t('projects.deployments.failureNotRestored', { sha });
  return null;
}

/**
 * The receipt's few facts beside its outcome (the Environment overview's `fc-facts`): current health and address
 * while it serves, the version it replaced and what the Environment keeps for rollback. The address has no
 * current producer here yet, so it says so rather than repeating a recorded one as current.
 */
function receiptFacts(input: Readonly<{
  facts: DeploymentReceiptFactsV1;
  serving: boolean;
  health: Parameters<typeof deploymentHealthFact>[0];
  state: Parameters<typeof deploymentHealthFact>[1];
}>): FactStripFact[] {
  const list: FactStripFact[] = [];
  if (input.serving) {
    list.push({ key: 'health', testID: 'project-deployments.receipt.facts.health',
      label: t('projects.deployments.factHealthNow'), ...deploymentHealthFact(input.health, input.state) });
    if (!input.facts.urls?.length) {
      list.push({ key: 'address', label: t('projects.deployments.factAddress'), value: t('projects.deployments.factNotAvailable') });
    }
  }
  const target = input.facts.previousVersion;
  if (target !== undefined) {
    list.push({ key: 'previous', testID: 'project-deployments.receipt.facts.previous',
      label: t('projects.deployments.factPrevious'),
      value: target ? deploymentRevisionLabel(target.revision) : t('projects.deployments.factFirstDeploy') });
  }
  if (input.facts.retainedPreviousCount !== null) {
    list.push({ key: 'kept', label: t('projects.deployments.keptForRollback'),
      value: input.facts.retainedPreviousCount > 0 ? t('projects.deployments.keptCount', { count: input.facts.retainedPreviousCount }) : t('projects.deployments.keptNone') });
  }
  return list;
}

/** What happened on one Machine, once there is something to say: restored, else its known health. */
function machineOutcome(result: DeploymentMachineResultV1): string | null {
  return restorationLabel(result.restoration)
    ?? (result.health === 'unknown' ? null : deploymentMachineHealthLabel(result));
}

function restorationLabel(
  restoration:
    | 'succeeded'
    | 'failed'
    | 'unreachable'
    | 'outcome_unknown'
    | undefined,
): string | null {
  if (restoration === 'succeeded')
    return t('projects.deployments.restoredPrevious');
  if (restoration === 'failed' || restoration === 'unreachable')
    return t('projects.deployments.restoreFailed');
  if (restoration === 'outcome_unknown')
    return t('projects.deployments.stateUnknown');
  return null;
}

const NO_IMAGES: readonly never[] = Object.freeze([]);

const styles = StyleSheet.create((theme) => ({
  mono: Typography.mono(),
  page: { flex: 1, minHeight: 0 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  phoneAction: { flexGrow: 1 },
  bar: { gap: theme.space.s12 },
  // The strip sits in a sheetless section, so it starts on the section's own edge like the title above it.
  facts: {
    paddingBottom: theme.space.s8,
  },
  outcomeActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
