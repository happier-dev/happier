import * as React from 'react';
import { View } from 'react-native';
import type { ProjectSetupReviewV1 } from '@happier-dev/protocol/actions/projectSetupConsentFailure';
import { createProjectManifestActionClient } from '@/components/projects/projectSetup/projectManifestActionClient';
import { ProjectSetupReviewFacts } from '@/components/projects/projectSetup/ProjectSetupReview';
import { useUnistyles } from 'react-native-unistyles';
import type {
  ProjectServicePlacementGetResultV1,
  ProjectServicePlacementV1,
} from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { executeServiceRelocationAction, type ServiceRelocationOutcome } from './serviceRelocationAction';
import { ProjectServicePlacementObservationProvider, useProjectServicePlacementObservation, useProjectServicePlacementValueObservation } from './projectServicePlacementObservation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { projectExecutionChoicesEqualV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { hasUncertainLocalServiceNativeCustodyV1, isLocalServiceStateRunningV1 } from '@happier-dev/protocol/local/services/launcher/v1';

import {
  useObservedWorkerSetting,
  type ObservedWorkerSettingNotice,
} from '@/components/projects/workers/useObservedWorkerSetting';
import { useWorkerDestinationLabel } from '@/components/projects/workers/useWorkerDestinationLabel';
import { WorkerDestinationPicker } from '@/components/projects/workers/WorkerDestinationPicker';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';
import { Text } from '@/components/ui/text/Text';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import { randomUUID } from '@/platform/randomUUID';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { withDefaultActionExecuteContext } from '@/sync/ops/actions/defaultActionExecutor';
import { executeProjectWorkerActionV1 } from '@/sync/ops/actions/projectWorkerActions';
import { isActionApprovalRequiredForHome } from '@/sync/domains/settings/actionsSettings';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useMachinePoolSelection } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import type { ServerScopedMachinePoolSelection } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { describeManagedCreationProgress } from '@/components/settings/machines/managed/managedCreationProgressPresentation';
import { readManagedMachineSelectionName } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { isProjectServiceTargetFromSource, type ProjectServiceSource } from './projectServiceSource';

/** The SOURCE checkout a declared service belongs to: its Home, accepted ref and own Machine. */
export type { ProjectServiceSource } from './projectServiceSource';

type ReadyPlacement = Extract<
  ProjectServicePlacementGetResultV1,
  { status: 'ready' }
>;
type ManagedActual = Extract<
  ReadyPlacement['actual'],
  { status: 'present' }
>['target'];

/** A service's next-start placement plus its actual native binding, through `projects.service.placement.*` (32s1). */
export function useProjectServicePlacement(
  source: ProjectServiceSource,
  serviceName: string,
  options: Readonly<{ lifecycleKey?: string }> = {},
) {
  const address = React.useMemo(
    () => ({ serverId: source.serverId, refId: source.refId }),
    [source.serverId, source.refId],
  );
  const setting = useObservedWorkerSetting<ReadyPlacement, ProjectServicePlacementV1>({
    serverId: address.serverId,
    scopeKey: JSON.stringify([
      'projects.service.placement',
      address.serverId,
      address.refId,
      serviceName,
    ]),
    read: (accountId) =>
      executeProjectWorkerActionV1(
        'projects.service.placement.get',
        { workspace: address, serviceName },
        { expectedAccountId: accountId },
      ),
    // A mutation receipt carries the saved placement only; the actual binding stays as last observed.
    observedFromReceipt: () => null,
  });
  const { mutate, refresh } = setting;
  const lastLifecycle = React.useRef(options.lifecycleKey);
  React.useEffect(() => {
    if (lastLifecycle.current === options.lifecycleKey) return;
    lastLifecycle.current = options.lifecycleKey;
    refresh();
  }, [options.lifecycleKey, refresh]);
  const ready = setting.state.kind === 'ready' ? setting.state.value : null;
  const actual = ready?.actual ?? null;
  const desiredPlacement = ready?.placement ?? null;
  const retained = useProjectServicePlacementValueObservation(serviceName, ready);
  // A remounted control can present this scope's last observation immediately.
  // Its own fresh custody/revision remains mandatory for save and Move admission.
  const displayPlacement = setting.state.kind === 'loading' ? retained : ready;
  const displayChoice: ProjectExecutionChoiceV1 | null = actual?.status === 'present'
    ? actual.target.machineId === source.machineId ? { kind: 'primary' }
      : { kind: 'workers', destination: { kind: 'machine', machineId: actual.target.machineId } }
    : actual?.status === 'absent' ? desiredPlacement?.runsOn ?? null : null;
  const canSaveNextStart = !setting.busy && actual?.status === 'absent';
  const moveBlocked = actual?.status === 'present'
    && (!isLocalServiceStateRunningV1(actual.target.serviceState)
      || hasUncertainLocalServiceNativeCustodyV1(actual.target));
  const canMove = !setting.busy && actual?.status === 'present' && !moveBlocked;
  const save = React.useCallback(
    async (value: ProjectServicePlacementV1) => {
      await mutate((_accountId, current, approvalOptions) => current.actual.status !== 'absent'
        ? Promise.resolve({ status: 'unavailable' })
        : executeProjectWorkerActionV1(
          'projects.service.placement.set',
          {
            workspace: address,
            serviceName,
            expectedRevision: current.revision,
            expected:
              current.provenance === 'default'
                ? { kind: 'absent' }
                : { kind: 'value', value: current.placement },
            value,
          },
          approvalOptions,
        ),
        value,
      );
      refresh();
    },
    [address, mutate, refresh, serviceName],
  );
  return { ...setting, address, actual, desiredPlacement, displayPlacement, displayChoice, canSaveNextStart, canMove, moveBlocked, save };
}

function noticeText(notice: ObservedWorkerSettingNotice): string | null {
  switch (notice) {
    case 'saving':
      return t('projectServices.saving');
    case 'approval':
      return t('projectWorkers.approvalPending');
    case 'unknown':
      return t('projectServices.saveUnknown');
    case 'changed':
      return t('projectServices.changed');
    case 'failed':
    case 'locked':
      return t('projectServices.saveFailed');
    default:
      return null;
  }
}

/** The running instance is already on the chosen exact Machine: Move would be a no-op (32 §9). */
function choiceMatchesActual(
  choice: ProjectExecutionChoiceV1,
  actual: ManagedActual,
  sourceMachineId: string,
): boolean {
  if (choice.kind === 'primary') return actual.machineId === sourceMachineId;
  return (
    choice.destination.kind === 'machine' &&
    choice.destination.machineId === actual.machineId
  );
}

type MoveState =
  | Readonly<{ phase: 'resolving'; destination: ProjectExecutionChoiceV1 }>
  | Readonly<{ phase: 'confirm'; destination: ProjectExecutionChoiceV1; selectedMachineId: string; setupReview?: ProjectSetupReviewV1 }>
  | Readonly<{ phase: 'requesting'; destination: ProjectExecutionChoiceV1; selectedMachineId: string; setupReview?: ProjectSetupReviewV1 }>
  | Readonly<{ phase: 'approval'; destination: ProjectExecutionChoiceV1; selectedMachineId: string; artifactId: string }>
  | Readonly<{ phase: 'refused'; text: string; description?: string; code?: string }>
  | null;

/**
 * Runs `projects.service.relocate` through the canonical Action front door for the Account that
 * showed the service. Its request carries the placement CAS and reviewed exact Machine effect so
 * the source coordinator can settle the single set-plus-Move producer before native Stop.
 */
async function requestServiceRelocation(
  input: Readonly<{
    address: Readonly<{ serverId: string; refId: string }>;
    sourceMachineId: string;
    serviceName: string;
    actual: ManagedActual;
    destination: ProjectExecutionChoiceV1;
    currentPlacement: ReadyPlacement;
    selectedMachineId: string;
    expectedAccountId: string;
    signal: AbortSignal;
    onApprovalPending: (registration: ActionApprovalRegistration) => void;
    runtimeActionExecute?: FrontDoorRuntimeActionExecute;
    setupReview?: ProjectSetupReviewV1;
    confirmed?: true;
  }>,
): Promise<ServiceRelocationOutcome> {
  const managedServiceId =
    input.actual.sourceClass?.kind === 'managed_service'
      ? input.actual.sourceClass.managedServiceId
      : null;
  if (!managedServiceId)
    return { status: 'refused', reasonCode: 'service_binding_unavailable' };
  return await withDefaultActionExecuteContext(
    undefined,
    { serverId: input.address.serverId, expectedAccountId: input.expectedAccountId, signal: input.signal },
    async (executor, account) => {
      account.assertCurrent();
      const requestId = randomUUID();
      const result = await executeServiceRelocationAction({
        execute: input.runtimeActionExecute ?? (async request => {
          const result = await (input.confirmed ? executor.executeConfirmed : executor.execute)(
            request.actionId, request.input, request.context);
          return result.ok ? result.result : result;
        }),
        request: {
          workspace: input.address,
          sourceMachineId: input.sourceMachineId,
          serviceName: input.serviceName,
          requestId,
          currentTarget: {
            kind: 'managed_service',
            managedServiceId,
            machineId: input.actual.machineId,
            ...(input.actual.workspaceId ? { workspaceId: input.actual.workspaceId } : {}),
            ...(input.actual.cwd ? { cwd: input.actual.cwd } : {}),
            ...(input.actual.declaration ? { declaration: input.actual.declaration } : {}),
          },
          destination: input.destination,
          desiredPlacement: {
            workspace: input.address,
            serviceName: input.serviceName,
            expectedRevision: input.currentPlacement.revision,
            expected: input.currentPlacement.provenance === 'saved'
              ? { kind: 'value', value: input.currentPlacement.placement }
              : { kind: 'absent' },
            value: { ...input.currentPlacement.placement, runsOn: input.destination },
          },
          selectedTarget: { machineId: input.selectedMachineId },
          ...(input.setupReview ? { setupReview: input.setupReview } : {}),
        },
        ...(input.confirmed ? { confirmed: true } : {}),
        context: {
          surface: 'ui',
          serverId: account.serverId,
          runtimeAccountId: account.accountId,
          actionRequestId: requestId,
          signal: input.signal,
        },
        admission: { expectedAccountId: account.accountId, signal: input.signal,
          isCurrent: account.accountLifetime.isCurrent, onApprovalPending: input.onApprovalPending },
      });
      account.assertCurrent();
      return result;
    },
  );
}

/** The declaration facts the Services page knows for this service (plan 20s1 / 32s1). */
export type ProjectServiceDeclarationFacts = Readonly<{
  /** Only an explicitly portable declaration may run on a worker; anything else stays on the primary checkout. */
  portable: boolean;
  memoryDemand?: ProjectMemoryDemandV1;
  /** The inspected declaration, so changed commands/environment retire an unsubmitted continuation. */
  currentnessKey?: string;
}>;

/**
 * A service's "Runs on" and "If it can't run there" (32s1, lab `s-services RUNSON/PICK/MOVE/RUNSONp`),
 * shown in the service's expansion (desktop) or its pushed page (phone).
 * - Running: the field names where it actually runs; a different choice opens the Move confirmation.
 * - Stopped (observed absent): a choice saves where it starts next.
 * - Unavailable / ambiguous custody: neither is assumed; the choice waits for a current observation.
 */
export function ProjectServicePlacementControls(
  props: Readonly<{
    testID?: string;
    source: ProjectServiceSource;
    serviceName: string;
    declaration?: ProjectServiceDeclarationFacts;
    /** Native custody already observed by the row; presentation only while its placement reader is unread. */
    nativeTarget?: ServiceRow['target'];
    /** Changes whenever the Services feed observes this service's lifecycle; the binding is then re-read. */
    lifecycleKey?: string;
    /**
     * Injected by a grouped list that hosts this control as one row: whether a hairline follows its last
     * row. The group's own position cannot say it, because the rows inside are this control's.
     */
    showDivider?: boolean;
  }>,
) {
  const observation = useProjectServicePlacementObservation(props.serviceName);
  return observation.hasOwner ? <ProjectServicePlacementControlsBody {...props} />
    : <ProjectServicePlacementObservationProvider source={props.source}><ProjectServicePlacementControlsBody {...props} /></ProjectServicePlacementObservationProvider>;
}

function ProjectServicePlacementControlsBody(props: React.ComponentProps<typeof ProjectServicePlacementControls>) {
  const testID = props.testID ?? `project-service-placement:${props.serviceName}`;
  const { theme } = useUnistyles();
  const compact = useViewportClass() === 'compact';
  const trailingDivider = props.showDivider === true;
  const placement = useProjectServicePlacement(props.source, props.serviceName, { lifecycleKey: props.lifecycleKey });
  const { refresh } = placement;
  const anchorRef = React.useRef<View>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [requestedMove, setMove] = React.useState<MoveState>(null);
  const managedScopeKey = JSON.stringify([props.source.serverId, props.source.refId, props.source.machineId,
    props.serviceName, props.declaration, props.lifecycleKey]);
  const observation = useProjectServicePlacementObservation(props.serviceName, managedScopeKey, {
    absent: placement.state.kind === 'ready' && placement.state.value.actual.status === 'absent',
  });
  const move = observation.attachment ? { phase: 'operation' as const, ...observation.attachment } : requestedMove;
  const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
  const [managedMove, setManagedMove] = React.useState<'confirm' | 'acquiring' | null>(null);
  const managed = { draft: observation.managed?.draft ?? null, progress: observation.managed?.progress ?? null,
    busy: observation.managed?.busy ?? false, acquire: observation.managed?.acquire ?? (async () => null),
    cancel: observation.managed?.cancel ?? (() => {}), select: observation.selectManaged };
  const managedName = readManagedMachineSelectionName(managed.draft);
  const poolSelection = useMachinePoolSelection({
    requestKey: JSON.stringify(['project-service-move', props.source.serverId, props.source.refId, props.serviceName]),
    scopeKey: binding?.accountId,
    purpose: 'service-start',
    workspace: placement.address,
    ...(props.declaration?.memoryDemand ? { memoryDemand: props.declaration.memoryDemand } : {}),
    onResolved: target => {
      if (requestedMove?.phase === 'resolving' && requestedMove.destination.kind === 'workers'
        && requestedMove.destination.destination.kind === 'pool'
        && requestedMove.destination.destination.poolId === target.poolId) {
        void reviewMove(requestedMove.destination, target.machineId);
      }
    },
  });
  const moveAcquisition = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    setMove(null);
    setManagedMove(null);
    moveAcquisition.current?.abort();
    moveAcquisition.current = null;
    poolSelection.cancelPendingSelection();
    return () => { moveAcquisition.current?.abort(); };
  }, [binding, managedScopeKey, poolSelection.cancelPendingSelection, props.source.serverId, props.source.refId, props.source.machineId, props.serviceName]);
  React.useEffect(() => {
    if (requestedMove?.phase !== 'resolving'
      || (poolSelection.status.kind !== 'unavailable' && poolSelection.status.kind !== 'error')) return;
    setMove({ phase: 'refused', text: t('projectServices.moveRefused'), code: 'service_target_selection_required' });
  }, [poolSelection.status, requestedMove?.phase]);

  const state = placement.state;
  const ready = state.kind === 'ready' ? state.value : null;
  const observed = placement.displayPlacement?.actual ?? null;
  const actual = ready?.actual.status === 'present' ? ready.actual.target : null;
  // Regrouping remounts this reader. The row's completed native observation
  // already knows where it runs; retained desired/actual placement cannot contradict it.
  // Fresh placement still replaces retention and alone admits save/Move.
  const displayedActual = state.kind === 'loading' && props.nativeTarget
    ? props.nativeTarget : observed?.status === 'present' ? observed.target : null;
  const runsOn = placement.displayPlacement?.placement.runsOn ?? null;
  const portable = props.declaration?.portable === true;
  const label = useWorkerDestinationLabel(props.source.serverId, runsOn, props.source.machineId);
  const sourceMachine = useServerScopedMachine(props.source.serverId, props.source.machineId);
  const sourceName = (sourceMachine ? getMachineDisplayName(sourceMachine) : null) ?? t('projectWorkers.primary');
  const actualMachine = useServerScopedMachine(props.source.serverId, displayedActual?.machineId ?? '');
  const unavailableMachine = useServerScopedMachine(props.source.serverId, observed?.status === 'unavailable' ? observed.machineId ?? '' : '');
  const pendingDestination = move && move.phase !== 'refused' ? move.destination : null;
  const pendingLabel = useWorkerDestinationLabel(props.source.serverId, pendingDestination, props.source.machineId);
  const pendingMachineId = move && move.phase !== 'refused' && move.phase !== 'operation' && move.phase !== 'resolving'
    ? move.selectedMachineId : null;
  const pendingMachine = useServerScopedMachine(props.source.serverId, pendingMachineId ?? '');

  const operation = observation.operation;
  const stop = observation.stop;
  const operationState = operation?.snapshot.actionId === 'projects.service.relocate' ? operation.snapshot.state : null;
  const terminal = operationState === 'succeeded' || operationState === 'failed' || operationState === 'cancelled';
  React.useEffect(() => {
    // A newly observed native lifetime supersedes a prior failed Move. Returning
    // to Services must not rediscover that history as control over the new instance.
    const settledAt = operation?.snapshot.settledAt;
    if (terminal && settledAt !== undefined && actual?.startedAtMs !== undefined && actual.startedAtMs > settledAt) observation.clear();
  }, [actual?.startedAtMs, observation.clear, operation?.snapshot.settledAt, terminal]);
  React.useEffect(() => {
    // A terminal Action state alone says nothing about native service custody.
    if (!terminal) return;
    refresh();
  }, [operationState, refresh, terminal]);
  const outcomeUncertain = operation?.snapshot.observation?.kind === 'outcome_uncertain'
    || operation?.snapshot.error?.errorCode === 'outcome_uncertain';
  // The canonical relocation producer publishes `stopped` right after a literally confirmed native
  // Stop and `copying` only once copying begins (FX12); the Action operation owner retains the final
  // phase on failure/cancellation. Absence is separately observed, so neither generic terminal
  // state nor a lost feed proves Stop.
  const stoppedBeforeStart = observation.stoppedBeforeStart;

  const custodyKnown = ready?.actual.status === 'present' || ready?.actual.status === 'absent';
  const moving = observation.requestPending || managed.busy || managedMove === 'acquiring' || move?.phase === 'resolving' || move?.phase === 'requesting' || move?.phase === 'approval'
    || (move?.phase === 'operation' && observation.relocating);
  const moveBlockedReason = actual && placement.moveBlocked
    ? resolveReasonCopy({ kind: 'localServiceLauncher', reasonCode: actual.unavailableReason ?? actual.serviceState }).body : null;
  const disabled = !ready || placement.busy || moving || !custodyKnown || !portable || moveBlockedReason !== null;
  const notice = noticeText(placement.notice);
  const toName = pendingMachineId
    ? (pendingMachine ? getMachineDisplayName(pendingMachine) : pendingMachineId)
    : pendingLabel.name ?? (pendingDestination?.kind === 'primary' ? sourceName : '');
  const operationBanner = move?.phase === 'operation' ? (
    <AttentionBanner
      testID={`${testID}.move.operation`}
      tone={terminal || outcomeUncertain ? 'warning' : 'neutral'}
      title={operation?.observation !== 'available' || outcomeUncertain ? t('projectServices.moveUnknown')
        : operation?.snapshot.observation?.kind === 'stop_unconfirmed' || operation?.snapshot.error?.errorCode === 'stop_unconfirmed'
          ? t('projects.scripts.run.stopUnconfirmed')
          : stoppedBeforeStart ? t(operationState === 'cancelled' ? 'projectServices.moveCancelledStopped' : 'projectServices.moveFailedStopped')
            : observation.failedBeforeStop ? t('projectServices.moveRefused')
            : terminal ? t('projectServices.moveUnknown')
              : stop?.pending || stop?.stopRequested ? t('projectServices.cancelPending')
                : t('projectServices.moving', { service: props.serviceName, to: toName })}
      // While it runs, the Move names itself and the description says its current phase in the app's
      // words; the producer's own English phase label would only repeat it.
      description={!terminal && !outcomeUncertain && !(stop?.pending || stop?.stopRequested)
        && observation.progressText !== t('projectServices.moving', { service: props.serviceName, to: toName })
        && observation.progressText !== t('projectServices.moveUnknown')
        ? observation.progressText ?? undefined : undefined}
      {...(operation?.snapshot.error ? { details: [operation.snapshot.error.errorCode] } : {})}
      action={{ label: t('projectServices.inspect'), testID: `${testID}.move.inspect`,
        onPress: () => openActionOperationDetail({ serverId: props.source.serverId, operationId: move.operationId }) }}
      secondaryAction={stoppedBeforeStart ? { label: t('common.retry'), testID: `${testID}.move.retry`,
        onPress: refresh }
        : !terminal && operation?.observation === 'available' && operation?.snapshot.cancellation === 'supported' && stop ? {
        label: t('common.cancel'), testID: `${testID}.move.stop`, disabled: stop.pending || stop.stopRequested,
        onPress: stop.requestStop,
      } : null}
    />
  ) : null;

  if (state.kind === 'refused' || state.kind === 'error') {
    return (
      <ItemGroupRowPositionBoundary>
        <View testID={testID}>
          <Item testID={`${testID}.unavailable`} title={t('projectServices.runsOn')}
            subtitle={state.reasonCode ? resolveReasonCopy({ kind: 'localServiceAction', reasonCode: state.reasonCode }).body
              : t('projectServices.settingsUnavailable')} mode="info" showChevron={false} showDivider={compact && trailingDivider} />
          {operationBanner}
        </View>
      </ItemGroupRowPositionBoundary>
    );
  }

  const desiredName = runsOn?.kind === 'primary'
    ? t('projectServices.thisMachine', { name: sourceName })
    : runsOn?.kind === 'workers' && runsOn.destination.kind === 'pool'
      ? [t('projectServices.anyWorker'), label.name].filter(Boolean).join(' · ')
      : (label.name ?? (label.missing ? t('projectServices.destinationMissing') : null));
  const actualName = displayedActual
    ? displayedActual.machineId === props.source.machineId
      ? t('projectServices.thisMachine', { name: sourceName })
      : (actualMachine ? getMachineDisplayName(actualMachine) : null) ?? t('projectServices.otherMachine')
    : null;
  const unavailableReason = observed?.status === 'unavailable'
    ? observed.reasonCode === 'observation_changed' || observed.reasonCode === 'topology_unavailable'
      ? t('projectServices.changed')
      : observed.machineId
        ? resolveReasonCopy({ kind: 'localServiceLauncher', reasonCode: 'project_service_binding_unavailable',
            machineName: unavailableMachine ? getMachineDisplayName(unavailableMachine)
              : observed.machineId === props.source.machineId ? sourceName : t('projectServices.otherMachine') }).body
        : t('projectServices.settingsUnavailable')
    : null;
  // A live occurrence is named where it actually runs; desired intent only describes the next start.
  const value = actualName ?? managedName ?? (observed?.status === 'ambiguous'
      ? t('projectServices.actualAmbiguous')
      : observed?.status === 'unavailable'
        ? t('projectServices.actualUnavailable')
        : observed?.status === 'absent'
          ? !portable ? t('projectServices.thisMachine', { name: sourceName }) : desiredName
          : null);
  // Why the row cannot act, or where its next start goes: always the row's own subtitle.
  const hint = observed?.status === 'unavailable'
      ? undefined
      : observed?.status === 'ambiguous'
        ? t('projectServices.actualAmbiguousDetail')
        : !portable
          ? t('projectServices.primaryOnly')
          : moveBlockedReason
          ? moveBlockedReason
          : stoppedBeforeStart && desiredName
          ? t('projectServices.willStartOn', { name: desiredName })
          : undefined;
  // Where it runs, as a plain statement: the subtitle on a phone, the lab's helper line under the rows on a
  // wider page (RUNSON). A live service names only the checkout's own machine; one running elsewhere has no
  // sentence of its own here.
  const where = hint !== undefined || observed?.status === 'unavailable' ? undefined
    : displayedActual
      ? displayedActual.machineId === props.source.machineId ? t('projectServices.runsHere') : undefined
      : !runsOn ? undefined
        : runsOn.kind === 'primary'
          ? t('projectServices.runsHere')
          : label.name ? t('projectServices.runsOnWorker', { name: label.name }) : undefined;
  // Under the rows, on their text edge (the rows reserve the leading column the Services row's mark sits in).
  const noteStyle = {
    color: theme.colors.text.secondary,
    paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
    paddingRight: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingBottom: theme.space.s8,
  };

  const choose = (choice: ProjectExecutionChoiceV1, selectedPool?: ServerScopedMachinePoolSelection) => {
    if (!ready || !custodyKnown || !portable || placement.busy || moving) return;
    setPickerOpen(false);
    if (actual && !placement.canMove) {
      setMove({ phase: 'refused', text: t('projectServices.moveRefused'),
        ...(moveBlockedReason ? { description: moveBlockedReason } : {}) });
      return;
    }
    managed.select(null);
    setManagedMove(null);
    if (actual) {
      // A different target follows the person's Action policy; the same target is a no-op.
      if (choiceMatchesActual(choice, actual, props.source.machineId)) return;
      if (choice.kind === 'workers' && choice.destination.kind === 'pool') {
        if (!selectedPool || choice.destination.selection !== 'automatic') {
          setMove({ phase: 'refused', text: t('projectServices.moveRefused'), code: 'service_target_selection_required' });
          return;
        }
        setMove({ phase: 'resolving', destination: choice });
        void poolSelection.selectPool(selectedPool);
        return;
      }
      if (choice.kind === 'primary') void reviewMove(choice, props.source.machineId);
      else if (choice.destination.kind === 'machine') void reviewMove(choice, choice.destination.machineId);
      return;
    }
    if (!placement.canSaveNextStart || projectExecutionChoicesEqualV1(choice, ready.placement.runsOn)) return;
    void placement.save({ ...ready.placement, runsOn: choice });
  };

  async function reviewMove(destination: ProjectExecutionChoiceV1, selectedMachineId: string) {
    try {
      if (!binding?.isCurrent()) return;
      const inspection = props.source.rootPath ? await createProjectManifestActionClient({
        workspace: { serverId: props.source.serverId, machineId: props.source.machineId,
          workspaceId: props.source.refId, rootPath: props.source.rootPath }, expectedAccountId: binding.accountId,
      }).inspect({ kind: 'setup' }) : null;
      if (inspection && !inspection.setupReview) throw new Error('project_setup_review_unavailable');
      const setupReview = inspection?.setupReview;
      const [moveRequired, setupRequired] = await Promise.all([
        isActionApprovalRequiredForHome('projects.service.relocate', { surface: 'ui' }, props.source.serverId),
        setupReview && inspection?.setupReadiness?.kind !== 'notRequired'
          ? isActionApprovalRequiredForHome('projects.prepare', { surface: 'ui' }, props.source.serverId) : false,
      ]);
      if (!binding?.isCurrent()) return;
      if (moveRequired || setupRequired) setMove({ phase: 'confirm', destination, selectedMachineId, ...(setupReview ? { setupReview } : {}) });
      else await confirmMove(destination, selectedMachineId, setupReview);
    } catch (error) {
      if (!binding?.isCurrent()) return;
      setMove({ phase: 'refused', text: t('projectServices.moveUnknown'),
        code: error instanceof Error ? error.message : 'move_failed' });
    }
  }

  async function confirmMove(destination: ProjectExecutionChoiceV1, selectedMachineId: string, setupReview?: ProjectSetupReviewV1, confirmed?: true) {
    if (!actual || !placement.canMove || !portable || !binding?.isCurrent() || observation.requestPending) return;
    if (!ready) {
      setMove({ phase: 'refused', text: t('projectServices.moveRefused'), code: 'service_target_selection_required' });
      return;
    }
    setMove({ phase: 'requesting', destination, selectedMachineId, ...(setupReview ? { setupReview } : {}) });
    try {
      const exactDestination: ProjectExecutionChoiceV1 = destination.kind === 'primary' ? destination
        : { kind: 'workers', destination: { kind: 'machine', machineId: selectedMachineId } };
      const result = await observation.executeMove(exactDestination, (signal, onApprovalPending) => requestServiceRelocation({
        address: placement.address, sourceMachineId: props.source.machineId, serviceName: props.serviceName, actual, destination,
        currentPlacement: ready, selectedMachineId,
        expectedAccountId: binding.accountId, signal,
        runtimeActionExecute: observation.runtimeActionExecute,
        ...(setupReview ? { setupReview } : {}), ...(confirmed ? { confirmed: true } : {}),
        onApprovalPending: registration => {
          onApprovalPending(registration);
          setMove({ phase: 'approval', destination, selectedMachineId,
            artifactId: typeof registration === 'string' ? registration : registration.artifactId });
        },
      }));
      if (!result || !binding.isCurrent()) return;
      if (result.status === 'accepted') {
        setMove(null);
        return;
      }
      if (result.status === 'moved' || result.status === 'unchanged') {
        setMove(null);
        refresh();
        return;
      }
      setMove({
        phase: 'refused',
        text:
          result.status === 'unsupported' || (result.status === 'failed'
            && (result.errorCode === 'action_disabled' || result.errorCode === 'unsupported_action'))
            ? t('projectServices.moveUnavailable')
            : result.status === 'refused'
              ? t('projectServices.moveRefused')
              : t('projectServices.moveUnknown'),
        // The owner's reason code stays behind Details; it is never the message.
        ...('reasonCode' in result ? { code: result.reasonCode } : 'errorCode' in result ? { code: result.errorCode } : {}),
      });
    } catch (error) {
      if (!binding.isCurrent()) return;
      setMove({ phase: 'refused', text: t('projectServices.moveUnknown'),
        code: error instanceof Error ? error.message : 'move_failed' });
    }
  }

  const fromName = actualName ?? sourceName;
  const creation = managed.draft && managed.progress ? describeManagedCreationProgress(managedName ?? t('managedMachines.picker.newMachine'), managed.progress) : null;
  const confirmManagedMove = () => {
    if (!managed.draft || !placement.canMove || !portable || managed.busy) return;
    setManagedMove('acquiring');
    const cancellation = new AbortController();
    moveAcquisition.current = cancellation;
    void managed.acquire(cancellation.signal).then(destination => {
      if (cancellation.signal.aborted || moveAcquisition.current !== cancellation) return;
      moveAcquisition.current = null;
      if (!destination) { setManagedMove('confirm'); return; }
      setManagedMove(null);
      if (destination.destination.kind === 'machine') void confirmMove(destination, destination.destination.machineId);
    });
  };

  // A row with its own sentence ("Runs next to this checkout.") leaves a narrow row no room for the value beside
  // it: the value reads under the sentence, at full width, instead of squeezing the sentence into a column. A
  // phone always stacks; a pane stacks when the row is narrow. A movable service keeps its control; only a plain
  // value moves. The phone's sentence is the hint or, without one, where it runs.
  const runsOnSubtitle = hint ?? (compact ? where : undefined);
  const plainValueWithSentence = (compact || !portable) && Boolean(value) && Boolean(runsOnSubtitle);
  return (
    <ItemGroupRowPositionBoundary>
    <View testID={testID}>
      <View ref={anchorRef} collapsable={false}>
        <Item
          testID={`${testID}.runsOn`}
          title={t('projectServices.runsOn')}
          subtitle={runsOnSubtitle}
          subtitleLines={0}
          showDivider={compact && (portable || trailingDivider)}
          showChevron={compact && portable}
          accessoryLayout={plainValueWithSentence && compact ? 'stacked' : 'adaptive'}
          // A primary-only service has nothing to choose: its row is a plain statement, not a dimmed control.
          disabled={portable && disabled}
          // Held only by the first binding read: say it is still checking rather than only dimming the choices.
          loading={portable && state.kind === 'loading' && !ready}
          accessibilityExpanded={pickerOpen}
          {...(portable ? { onPress: () => {
            // Re-observe the binding before a lifecycle-sensitive choice.
            refresh();
            setPickerOpen(true);
          } } : {})}
          {...(plainValueWithSentence
            ? { rightElement: <Text variant="body" style={{ color: theme.colors.text.secondary }}>{value}</Text> }
            : compact || !portable
            ? { detail: value ?? undefined }
            : {
                rightElement: renderDropdownItemTriggerRightElement({
                  detail: value,
                  open: pickerOpen,
                  detailColor: theme.colors.text.primary,
                  chevronColor: theme.colors.text.secondary,
                  field: resolveFieldBoxColors(theme, label.missing && !displayedActual ? 'invalid' : 'idle'),
                  placeholder: t('common.loading'),
                  placeholderColor: theme.colors.input.placeholder,
                }),
              })}
        />
      </View>
      {observed?.status === 'unavailable' || observed?.status === 'ambiguous' ? (
        <AttentionBanner
          testID={`${testID}.custody`}
          tone="neutral"
          title={observed.status === 'ambiguous' ? t('projectServices.actualAmbiguous') : unavailableReason!}
          action={{ label: t('common.retry'), testID: `${testID}.custody.retry`, onPress: refresh }}
        />
      ) : null}
      {portable ? (
        <SegmentedChoiceItem<'primary' | 'fail'>
          testIDPrefix={`${testID}.fallback`}
          title={t('projectServices.whenUnavailable')}
          subtitle={placement.actual?.status === 'present' ? t('projectServices.fallbackLocked') : undefined}
          accessoryLayout={compact ? 'stacked' : 'adaptive'}
          disabled={!placement.canSaveNextStart || moving}
          showDivider={compact && trailingDivider}
          value={placement.displayPlacement?.placement.unavailable ?? 'fail'}
          options={[
            { id: 'primary', label: t('projectServices.fallbackPrimary') },
            { id: 'fail', label: t('projectServices.fallbackFail') },
          ]}
          onChange={(unavailable) => {
            if (!ready || unavailable === ready.placement.unavailable) return;
            void placement.save({ ...ready.placement, unavailable });
          }}
        />
      ) : null}
      {where && !compact ? <Text testID={`${testID}.note`} variant="meta" style={noteStyle}>{where}</Text> : null}
      {notice ? <AttentionBanner testID={`${testID}.notice`} tone="neutral" title={notice} /> : null}
      {managedMove === 'confirm' && managed.draft ? <AttentionBanner testID={`${testID}.move`} tone="neutral"
        title={t('projectServices.moveConfirm', { service: props.serviceName, from: fromName, to: managedName ?? t('managedMachines.picker.newMachine') })}
        description={t('projectServices.moveDetail')}
        action={{ label: t('projectServices.move'), testID: `${testID}.move.confirm`, onPress: confirmManagedMove }}
        secondaryAction={{ label: t('common.cancel'), testID: `${testID}.move.cancel`, onPress: () => { managed.select(null); setManagedMove(null); } }} /> : null}
      {creation && managed.progress?.kind !== 'ready' ? <AttentionBanner testID={`${testID}.creation`}
        tone={creation.failed ? 'warning' : 'neutral'} title={creation.label}
        {...(managed.progress?.kind === 'failed' ? { details: [managed.progress.code] } : {})}
        secondaryAction={managed.busy ? { label: t('common.cancel'), testID: `${testID}.creation.cancel`, onPress: () => { moveAcquisition.current?.abort(); managed.cancel(); setManagedMove(null); } } : null} /> : null}
      {move?.phase === 'resolving' ? (
        <AttentionBanner testID={`${testID}.move.resolving`} tone="neutral" title={t('machinePools.resolvingTarget')}
          secondaryAction={{ label: t('common.cancel'), testID: `${testID}.move.cancel`, onPress: () => {
            poolSelection.cancelPendingSelection();
            setMove(null);
          } }} />
      ) : null}
      {move?.phase === 'confirm' || move?.phase === 'requesting' ? (
        <View testID={move.setupReview ? `${testID}.move.setup` : undefined}>
          {move.setupReview ? <ProjectSetupReviewFacts testID={`${testID}.move.setup`} reviewedEffect={move.setupReview.reviewedEffect}
            machineName={toName} sharedRunAs={pendingMachine?.isShared ? pendingMachine.metadata?.username ?? null : null} /> : null}
          <AttentionBanner
          testID={`${testID}.move`}
          tone="neutral"
          title={t('projectServices.moveConfirm', { service: props.serviceName, from: fromName, to: toName })}
          description={t('projectServices.moveDetail')}
          action={{
            label: t('projectServices.move'),
            testID: `${testID}.move.confirm`,
            loading: move.phase === 'requesting',
            disabled: move.phase === 'requesting',
            onPress: () => void confirmMove(move.destination, move.selectedMachineId, move.setupReview, true),
          }}
          secondaryAction={{
            label: t('common.cancel'),
            testID: `${testID}.move.cancel`,
            disabled: move.phase === 'requesting',
            onPress: () => setMove(null),
          }}
          />
        </View>
      ) : null}
      {move?.phase === 'approval' ? (
        <AttentionBanner testID={`${testID}.move.approval`} tone="neutral"
          title={t('projectServices.moveConfirm', { service: props.serviceName, from: fromName, to: toName })}
          description={t('projectWorkers.approvalPending')} />
      ) : null}
      {operationBanner}
      {move?.phase === 'refused' ? (
        <AttentionBanner
          testID={`${testID}.move.refused`}
          tone="warning"
          title={move.text}
          description={move.description}
          {...(move.code ? { details: [move.code] } : {})}
          secondaryAction={{ label: t('common.ok'), onPress: () => setMove(null) }}
        />
      ) : null}
      {ready && portable ? (
        <WorkerDestinationPicker
          testID={`${testID}.picker`}
          open={pickerOpen}
          onRequestClose={() => setPickerOpen(false)}
          anchorRef={anchorRef}
          title={t('projectServices.runsOn')}
          purpose="service-start"
          workspace={placement.address}
          sourceMachineId={props.source.machineId}
          subjectName={props.serviceName}
          {...(props.declaration?.memoryDemand ? { memoryDemand: props.declaration.memoryDemand } : {})}
          primary={{ title: t('projectServices.thisMachine', { name: sourceName }) }}
          poolSelection="automatic"
          servicePresentation
          selected={stoppedBeforeStart ? placement.displayChoice : pendingDestination ?? placement.displayChoice}
          onChoose={choose}
          selectedManagedMachine={managed.draft}
          onChooseManagedMachine={draft => {
            if (!ready || !custodyKnown || !portable || placement.busy || moving) return;
            setPickerOpen(false);
            if (actual && !placement.canMove) {
              setMove({ phase: 'refused', text: t('projectServices.moveRefused'),
                ...(moveBlockedReason ? { description: moveBlockedReason } : {}) });
              return;
            }
            managed.select(draft, actual ? 'move' : 'start');
            setManagedMove(actual ? 'confirm' : null);
          }}
        />
      ) : null}
    </View>
    </ItemGroupRowPositionBoundary>
  );
}

/**
 * The Services page's per-row placement slot: a service declared in the project file gets its Runs on
 * control; detected listeners and native declarations have no saved placement to show.
 */
export function createProjectServicePlacementRenderer(
  source: ProjectServiceSource | null,
  declarations: Readonly<Record<string, ProjectServiceDeclarationFacts>> = {},
): ((row: ServiceRow) => React.ReactNode) | undefined {
  if (!source) return undefined;
  return (row) => {
    const declaration = row.target.declaration;
    if (!declaration || declaration.selection.kind !== 'manifest') return null;
    // Another checkout's service (This machine scope) has its own placement; only this checkout's
    // declarations, or their copies running on a worker, show this checkout's Runs on.
    if (!isProjectServiceTargetFromSource(source, row.target)) return null;
    // Placement lives on the SOURCE checkout's ref; a running worker copy carries its own ref.
    return (
      <ProjectServicePlacementControls
        source={source}
        serviceName={declaration.selection.name}
        declaration={declarations[declaration.selection.name]}
        nativeTarget={row.target.sourceClass?.kind === 'managed_service' && row.target.serviceState !== undefined
          ? row.target : undefined}
        // The feed's observed lifecycle of this row re-reads the actual binding (Start/Stop/reconnect).
        lifecycleKey={JSON.stringify([row.status, row.target.machineId, row.target.serviceState ?? '', row.target.id,
          row.target.sourceClass?.kind === 'managed_service' ? row.target.sourceClass.managedServiceId : null])}
      />
    );
  };
}
