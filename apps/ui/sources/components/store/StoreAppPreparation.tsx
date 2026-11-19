import { deploymentRecommendationDescription } from '@/components/projects/deployments/deploymentRecommendationDescription';
import * as React from 'react';
import { useStore } from 'zustand';
import { DeploymentTemplateChoices } from '@/components/projects/deployments/DeploymentTemplateChoices';
import { DeploymentTemplateDomainRows, projectDeploymentTemplateDomainChoices } from '@/components/projects/deployments/DeploymentTemplateDomainRows';
import { DeploymentPartialProgress } from '@/components/projects/deployments/DeploymentPartialProgress';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { renderDeploymentCreationDefaultsRows } from '@/components/projects/deployments/DeploymentCreationDefaultsRows';
import { DeploymentProjectChoiceGroups, useDeploymentProjectChoice } from '@/components/projects/deployments/DeploymentProjectChoice';
import { MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName, keepHyphenatedNameTogether } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';

import type {
  StoreAppListingState,
  StoreAppPreparationInput,
} from './useStoreAppListing';
import { useStoreAppListing } from './useStoreAppListing';
import { createStoreAppPreparationState, type StoreAppPreparationStore } from './storeAppPreparationState';
import { DeploymentAddPortsFacts } from '@/components/approvals/DeploymentAddPortsFacts';

type Ready = Extract<StoreAppListingState, { kind: 'ready' }>;
/** The Deploys field's choice for the Account's usual controller; a Machine id is never this word. */
type ReviewProps = Readonly<{
  ready: Ready;
  lifetime: ServerAccountScopeLifetime;
  /** The listing's name for the App; the template's own title when omitted. */
  name?: string;
  /** Explicit Store route choice, captured before the review opens. */
  initialMachine?: QualifiedMachineV1 | null;
  reviewState?: StoreAppPreparationStore;
  onClose: () => void;
}>;

function createReviewState(props: Pick<ReviewProps, 'initialMachine' | 'lifetime'>) {
  return createStoreAppPreparationState(props.initialMachine
    && areServerProfileIdentifiersEquivalent(props.initialMachine.serverId, props.lifetime.scope.serverId)
    ? props.initialMachine.machineId : null);
}

/** A catalog template's own words; catalog Apps carry no plugin translation bundle, so the fallback is the text. */
export function catalogText(value: DeploymentTemplateV1['title'] | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : value.fallback;
}

/** The App's preparation review (lab publish `addapp/reviewFirstRun`), over the listing that opened it. */
export function showStoreAppPreparation(
  props: Omit<ReviewProps, 'onClose'> & Readonly<{ name: string }>,
): string {
  return Modal.show({ component: StoreAppPreparationModal,
    props: { ...props, reviewState: props.reviewState ?? createReviewState(props) } });
}

function StoreAppPreparationModal(
  props: ReviewProps & CustomModalInjectedProps,
) {
  const [reviewState] = React.useState(() => props.reviewState ?? createReviewState(props));
  return <StoreAppPreparationTargeted {...props} reviewState={reviewState} />;
}

function StoreAppPreparationTargeted(props: ReviewProps & CustomModalInjectedProps & Readonly<{ reviewState: StoreAppPreparationStore }>) {
  const { ready: initialReady, lifetime, reviewState } = props;
  const selection = { sourceId: initialReady.item.summary.sourceId, itemId: initialReady.item.summary.itemId,
    ...(initialReady.item.summary.version ? { version: initialReady.item.summary.version } : {}) };
  const installMachineId = useStore(reviewState, state => state.machineId);
  const listing = useStoreAppListing({ selection, lifetime, demand: { presented: true }, installMachineId });
  const ready = listing.kind === 'ready' ? listing : null;
  return ready ? <StoreAppPreparationReview {...props} ready={ready} reviewState={reviewState} /> : null;
}

/**
 * Where it runs, which project lists it and how it deploys, chosen explicitly; Review asks the App owner to
 * prepare exactly that, and shows what it would create. Its refusal and approval are the owner's own outcomes.
 */
export function StoreAppPreparationReview(
  props: ReviewProps & Partial<Pick<CustomModalInjectedProps, 'setChrome'>>,
) {
  const { theme } = useUnistyles();
  const { ready, lifetime, onClose } = props;
  const { serverId, accountId } = lifetime.scope;
  const name =
    props.name ?? catalogText(ready.app.title) ?? ready.item.summary.title;
  const allMachines = useMachineListForServer(serverId, true);
  // A Machine runs an App through its installation; one without an installation cannot be chosen.
  const machines = React.useMemo(
    () => (allMachines ?? []).filter((machine) => Boolean(machine.installationId)),
    [allMachines],
  );
  const projectChoice = useDeploymentProjectChoice({ lifetime });
  const sources = projectChoice.sources;
  const [reviewState] = React.useState(() => props.reviewState ?? createReviewState(props));
  const { machineId, controllerId, pending, prepared, refusal, environmentName, domainHostnames, production, creating, templateChoices } = useStore(reviewState);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const [deployDefaultsOpen, setDeployDefaultsOpen] = React.useState(false);
  const partialFailure = refusal?.failure?.progress ? refusal.failure : null;
  const created = refusal?.failure?.created;
  // The Environment's own choices, with the existing create form's starting values: no name, not production,
  // managers deploy (DeploymentEnvironmentDraft).
  const domainChoices = React.useMemo(() => projectDeploymentTemplateDomainChoices(ready.app.domains, domainHostnames),
    [domainHostnames, ready.app.domains]);
  const router = useRouter();
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([serverId, accountId, ready.templateRef]),
    serverId,
    onExecuted: () => {},
  });
  const approvalReview = useInPlaceApprovalReview({
    approvalId: approval.approvalId,
    approvalPending: approval.approvalPending,
    serverId,
  });

  // Only a Machine the presence owner says can take a request is choosable; the rest say why in its words.
  const presenceNowMs = useMachinePresenceNowMs(machines);
  const selectable = React.useMemo(
    () => new Set(machines
      .filter((machine) => resolveMachinePickerPresence(machine, presenceNowMs, lifetime.scope).selectable)
      .map((machine) => machine.id)),
    [lifetime.scope, machines, presenceNowMs],
  );
  const chosen = machines.find((machine) => machine.id === machineId && selectable.has(machine.id)) ?? null;
  const nameOf = React.useCallback(
    (id: string) => {
      const machine = (allMachines ?? []).find((entry) => entry.id === id);
      return machine ? keepHyphenatedNameTogether(getMachineDisplayName(machine, allMachines ?? [])) : id;
    },
    [allMachines],
  );
  // What Review still waits for, in the order the sheet asks; the footer says it. Review only reviews, so nothing
  // the person must answer is left for after it.
  const missing = !chosen
    ? t('capabilities.store.appPage.chooseMachine')
    : !environmentName.trim()
      ? t('capabilities.store.appPage.nameEnvironment')
      : domainChoices.missingRequired
        ? t('capabilities.store.appPage.domainRequired')
        : domainChoices.invalidKeys.size > 0 ? t('capabilities.store.appPage.domainInvalid') : projectChoice.missing;

  const review = React.useCallback(async () => {
    if (reviewState.getState().pending || !chosen?.installationId || missing) return;
    const project: Pick<StoreAppPreparationInput, 'projectSourceId' | 'sourceRevision' | 'newProject'> | null = projectChoice.selection;
    if (!project) return;
    const input: StoreAppPreparationInput = {
      machineId: chosen.id,
      installationId: chosen.installationId,
      ...project,
      ...(controllerId
        ? { explicit: { controllerMachineId: controllerId } }
        : {}),
    };
    reviewState.setState({ pending: true, refusal: null });
    const outcome = await ready.prepare(input);
    if ('kind' in outcome && outcome.kind === 'prepared') {
      reviewState.setState({ pending: false, prepared: outcome });
      return;
    }
    if ('kind' in outcome && outcome.kind === 'approval_request_created') {
      reviewState.setState({ pending: false });
      approval.requestApproval(outcome.artifactId);
      return;
    }
    if ('ok' in outcome) reviewState.setState({ pending: false,
      refusal: { code: outcome.errorCode, step: 'prepare', failure: outcome } });
  }, [
    approval,
    chosen,
    controllerId,
    missing,
    projectChoice.selection,
    ready,
    reviewState,
  ]);

  const create = React.useCallback(async () => {
    if (!prepared || reviewState.getState().creating) return;
    reviewState.setState({ creating: true, ...(!partialFailure && !created ? { refusal: null } : {}) });
    const outcome = await ready.create(prepared, {
      ...templateChoices,
      name: environmentName.trim(),
      protection: production ? 'production' : 'nonProduction',
      deployerMode: 'managers',
      ...(domainChoices.bindings.length ? { domainBindings: domainChoices.bindings } : {}),
    });
    if ('environmentId' in outcome) {
      reviewState.setState({ creating: false });
      onClose();
      const href = ready.environmentHref(outcome);
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true) fireAndForget(result, { tag: 'StoreAppPreparation.created' });
      return;
    }
    if ('kind' in outcome && outcome.kind === 'approval_request_created') {
      reviewState.setState({ creating: false });
      approval.requestApproval(outcome.artifactId);
      return;
    }
    if ('ok' in outcome) reviewState.setState({ creating: false,
      refusal: { code: outcome.errorCode, step: 'create', failure: outcome } });
  }, [approval, created, domainChoices, environmentName, onClose, partialFailure, prepared, production, ready, reviewState, router, templateChoices]);

  const footer = created ? (
    <MachineSetupReviewFooter onCancel={onClose} cancelTestID="store.app.prepare.cancel"
      note={null}
      primary={{ label: t('projects.deployments.openEnvironment'),
        testID: 'store.app.prepare.recover', loading: creating,
        disabled: creating || approval.approvalPending,
        onPress: () => { void create(); } }} />
  ) : partialFailure ? (
    <MachineSetupReviewFooter onCancel={onClose} cancelTestID="store.app.prepare.cancel"
      note={t('projects.deployments.partialProgressBody')}
      primary={{ label: t(partialFailure.recovery === 'deploy' ? 'projects.deployments.deploy' : 'projects.deployments.openEnvironment'),
        testID: 'store.app.prepare.recover', loading: creating,
        disabled: creating || approval.approvalPending || !partialFailure.recovery,
        onPress: () => { void create(); } }} />
  ) : prepared ? (
    <MachineSetupReviewFooter
      onCancel={creating ? onClose : () => {
        reviewState.setState({ prepared: null, refusal: null });
      }}
      cancelLabel={t(creating ? 'common.close' : 'capabilities.store.appPage.back')}
      cancelTestID={creating ? 'store.app.prepare.cancel' : 'store.app.prepare.back'}
      note={creating || refusal?.step === 'create' ? null : t('capabilities.store.appPage.prepareDescription')}
      primary={{
        label: t(creating ? 'status.working' : 'capabilities.store.appPage.install'),
        testID: 'store.app.prepare.confirm',
        loading: creating,
        disabled: creating || approval.approvalPending,
        onPress: () => {
          void create();
        },
      }}
    />
  ) : (
    <MachineSetupReviewFooter
      onCancel={onClose}
      cancelTestID="store.app.prepare.cancel"
      note={t('capabilities.store.appPage.prepareDescription')}
      primary={{
        label: t('capabilities.store.appPage.review'),
        testID: 'store.app.prepare.review',
        loading: pending,
        disabled: pending || missing !== null || approval.approvalPending,
        ...(missing ? { disabledReason: missing } : {}),
        onPress: () => {
          void review();
        },
      }}
    />
  );
  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: t('capabilities.store.appPage.prepareTitle', { name }),
      subtitle: null,
      footer,
      phonePresentation: 'sheet' as const,
      // The card keeps its height and its body scrolls, so a step that adds rows (New project, the prepared
      // review) extends downward instead of re-centring the card upward.
      scrollHost: 'body' as const,
      dimensions: { size: 'md' as const, maxHeightRatio: 0.84 },
    }),
    [footer, name],
  );
  useModalCardChrome(props.setChrome, chrome);

  // Who may deploy has no choice here, so it reads as part of this summary rather than a row without a control.
  const deploySummary = [
    controllerId ? nameOf(controllerId) : t('capabilities.store.appPage.controllerDefault'),
    ...(production ? [t('projects.deployments.production')] : []),
    t('capabilities.store.appPage.managersDeploy'),
  ].join(' · ');

  const phase = created ? (
    <ItemGroup testID="store.app.prepare.created">
      <Item mode="info" title={t('projects.deployments.environmentCreated')} subtitle={created.environmentId} />
    </ItemGroup>
  ) : partialFailure?.progress ? (
    <DeploymentPartialProgress testID="store.app.prepare.progress" progress={partialFailure.progress} failure={partialFailure} />
  ) : prepared ? (
    <>
    <ItemGroup
      testID="store.app.prepare.prepared"
      title={creating ? t('status.working') : refusal?.step === 'create' ? undefined : t('capabilities.store.appPage.preparedTitle')}
      description={creating || refusal?.step === 'create' ? undefined : t('capabilities.store.appPage.preparedDescription')}
    >
      <Item
        mode="info"
        icon={
          <Icon
            name="cube"
            size={ICON_SIZE.md}
            color={theme.colors.text.secondary}
          />
        }
        title={t('capabilities.store.appPage.createOn', {
          name: environmentName.trim(),
          machine: nameOf(prepared.machine.machineId),
        })}
        subtitle={
          prepared.project.newProject
            ? t('capabilities.store.appPage.inNewProject', {
                name: prepared.project.newProject.name,
              })
            : t('capabilities.store.appPage.inProject', {
                project:
                  sources.rows.find(
                    (row) => row.id === prepared.project.projectSourceId,
                  )?.name ??
                  prepared.project.projectSourceId ??
                  '',
              })
        }
      />
      {prepared.recommendation ? <Item mode="info" testID="store.app.prepare.recommendation"
        title={deploymentRecommendationDescription(prepared.recommendation)} /> : null}
      {prepared.template.domains.flatMap((domain) => {
        const hostname = domainChoices.bindings.find(binding => binding.templateDomainId === domain.key)?.hostname;
        return hostname ? [(
          <Item
            key={domain.key}
            mode="info"
            icon={
              <Icon
                name="globe"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={hostname}
            subtitle={t('capabilities.store.appPage.addressBody', {
              service: domain.service,
              port: domain.containerPort,
            })}
          />
        )] : [];
      })}
      <ExpandableItem
        testID="store.app.prepare.defaults"
        expanded={deployDefaultsOpen}
        onExpandedChange={setDeployDefaultsOpen}
        header={({ headerProps }) => (
          <Item
            {...headerProps}
            icon={
              <Icon
                name="rocket"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={t('capabilities.store.appPage.defaultsTitle')}
            subtitle={deploySummary}
          />
        )}
      >
        {renderDeploymentCreationDefaultsRows({
          defaults: prepared.creationDefaults,
          machineName: nameOf,
          testID: 'store.app.prepare.defaults',
        })}
      </ExpandableItem>
    </ItemGroup>
    {/* What the definition declares about ports and names, and known clashes on the chosen Machine (SOS-GAP-PREFLIGHT #4). */}
    <DeploymentAddPortsFacts document={prepared.template.compose.document} services={prepared.template.compose.services}
      serverId={serverId} machineId={prepared.machine.machineId} testID="store.app.prepare.ports" />
    {prepared.template.firstRunSetup ? (
      <AttentionBanner
        testID="store.app.prepare.firstRunWarning"
        title={t('capabilities.store.appPage.firstRunWarningTitle')}
        description={t('capabilities.store.appPage.firstRunWarningBody')}
      />
    ) : null}
    </>
  ) : (
    <>
      <ItemGroup
        title={t('capabilities.store.appPage.whereTitle')}
        description={t('capabilities.store.appPage.whereDescription', { name })}
      >
        {machines.length === 0 ? (
          <SurfaceStateCard
            testID="store.app.prepare.noMachine"
            kind="empty"
            size="line"
            title={t('capabilities.store.appPage.noMachine')}
          />
        ) : null}
        {machines.length > 0 ? (
          // New Session's Machine picker: a Machine that can't take the request now is listed, disabled, saying why.
          <SessionMachineField
            testID="store.app.prepare.machine"
            serverId={serverId}
            machines={machines}
            machineId={machineId}
            title={t('capabilities.store.softwarePage.machineLabel')}
            placeholder={t('capabilities.store.softwarePage.chooseMachine')}
            onSelectMachine={(next) => {
              if (selectable.has(next.id)) reviewState.setState({ machineId: next.id });
            }}
          />
        ) : null}
      </ItemGroup>
      <ItemGroup title={ready.app.domains.length > 0
        ? t('capabilities.store.appPage.nameAndAddressTitle')
        : t('projects.deployments.newEnvironment')}>
        <Item
          title={t('projects.deployments.name')}
          accessoryLayout="stacked"
          rightElement={
            <FieldTextInput
              testID="store.app.prepare.environmentName"
              value={environmentName}
              onChangeText={(environmentName) => reviewState.setState({ environmentName })}
              accessibilityLabel={t('projects.deployments.name')}
              placeholder={t('projects.deployments.namePlaceholder')}
            />
          }
          showChevron={false}
        />
        <DeploymentTemplateDomainRows
          domains={ready.app.domains}
          hostname={(key) => domainHostnames[key] ?? ''} invalidKeys={domainChoices.invalidKeys}
          onChangeHostname={(key, hostname) => reviewState.setState(current => ({ domainHostnames: { ...current.domainHostnames, [key]: hostname } }))}
          testIDPrefix="store.app.prepare.domain"
        />
      </ItemGroup>
      <DeploymentTemplateChoices template={ready.app} lifetime={lifetime} value={templateChoices}
        onChange={templateChoices => reviewState.setState({ templateChoices })} testID="store.app.prepare.choices" />
      <DeploymentProjectChoiceGroups
        model={projectChoice}
        testIDPrefix="store.app.prepare.project"
        description={t('capabilities.store.appPage.projectDescription')}
        newProjectHint={t('capabilities.store.appPage.projectNewHint')}
      />
      {machines.length > 0 ? (
        <ItemGroup>
          <ExpandableItem
            testID="store.app.prepare.options"
            expanded={optionsOpen}
            onExpandedChange={setOptionsOpen}
            header={({ headerProps }) => (
              <Item
                {...headerProps}
                title={t('capabilities.store.appPage.defaultsTitle')}
                subtitle={deploySummary}
              />
            )}
          >
            <SessionMachineField
              testID="store.app.prepare.controller"
              serverId={serverId}
              machines={machines}
              machineId={controllerId}
              title={t('capabilities.store.appPage.controllerLabel')}
              defaultChoice={{
                title: t('capabilities.store.appPage.controllerDefault'),
                onChoose: () => reviewState.setState({ controllerId: null }),
              }}
              awayMachinesChoosable
              onSelectMachine={(next) => reviewState.setState({ controllerId: next.id })}
            />
            <Item
              testID="store.app.prepare.production"
              title={t('projects.deployments.production')}
              subtitle={t('projects.deployments.productionHint')}
              rightElement={<Switch value={production} onValueChange={(production) => reviewState.setState({ production })} />}
              onPress={() => reviewState.setState(current => ({ production: !current.production }))}
              showChevron={false}
            />
          </ExpandableItem>
        </ItemGroup>
      ) : null}
    </>
  );

  const notices = (
    <>
      {approval.approvalPending ? (
        <ActionApprovalPendingNotice
          testID="store.app.prepare.approval"
          presentation="banner"
          message={t('capabilities.store.appPage.approvalWaiting')}
          description={t('capabilities.store.appPage.approvalDescription')}
          onOpenApproval={approvalReview.reopen}
        />
      ) : null}
      {refusal && !partialFailure ? (
        <SurfaceStateCard
          testID="store.app.prepare.refused"
          kind="error"
          size="line"
          title={created ? t('projects.deployments.openEnvironment') : refusal.step === 'create'
            ? t('projects.deployments.createFailedTitle')
            : t('capabilities.store.appPage.refused', { name })}
          reason={readDeploymentFailureRecoveryV1(refusal.code, refusal.failure?.details).remedy}
          diagnosticCode={refusal.code}
        />
      ) : null}
    </>
  );

  return (
    // A form: each section's title and description sit above its fields, and selects show their value.
    <ItemList presentation="page" keyboardShouldPersistTaps="handled">
      {notices}
      {phase}
      {/* Without card chrome (an embedding host), the decision ends the body. */}
      {props.setChrome ? null : footer}
    </ItemList>
  );
}
