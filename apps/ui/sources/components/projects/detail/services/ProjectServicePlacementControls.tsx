import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type {
  ProjectServicePlacementGetResultV1,
  ProjectServicePlacementV1,
} from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { executeServiceRelocationAction, type ServiceRelocationOutcome } from './serviceRelocationAction';
import { ProjectServiceRelocateResultV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { ProjectServicePlacementObservationProvider, useProjectServicePlacementObservation } from './projectServicePlacementObservation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { projectExecutionChoicesEqualV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

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
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import { randomUUID } from '@/platform/randomUUID';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { withDefaultActionExecuteContext } from '@/sync/ops/actions/defaultActionExecutor';
import { executeProjectWorkerActionV1 } from '@/sync/ops/actions/projectWorkerActions';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import { useViewportClass } from '@/utils/platform/useViewportClass';

/** The SOURCE checkout a declared service belongs to: its Home, accepted ref and own Machine. */
export type ProjectServiceSource = Readonly<{ serverId: string; refId: string; machineId: string }>;

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
  const displayChoice: ProjectExecutionChoiceV1 | null = actual?.status === 'present'
    ? actual.target.machineId === source.machineId ? { kind: 'primary' }
      : { kind: 'workers', destination: { kind: 'machine', machineId: actual.target.machineId } }
    : actual?.status === 'absent' ? desiredPlacement?.runsOn ?? null : null;
  const canSaveNextStart = !setting.busy && actual?.status === 'absent';
  const canMove = !setting.busy && actual?.status === 'present' && actual.target.serviceState === 'running';
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
  return { ...setting, address, actual, desiredPlacement, displayChoice, canSaveNextStart, canMove, save };
}

function sameChoice(left: ProjectExecutionChoiceV1, right: ProjectExecutionChoiceV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'primary' || right.kind === 'primary') return true;
  const a = left.destination;
  const b = right.destination;
  return a.kind === 'machine'
    ? b.kind === 'machine' && a.machineId === b.machineId
    : b.kind === 'pool' && a.poolId === b.poolId;
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
  | Readonly<{ phase: 'confirm'; destination: ProjectExecutionChoiceV1 }>
  | Readonly<{ phase: 'requesting'; destination: ProjectExecutionChoiceV1 }>
  | Readonly<{ phase: 'approval'; destination: ProjectExecutionChoiceV1; artifactId: string }>
  | Readonly<{ phase: 'refused'; text: string; code?: string }>
  | null;

/**
 * Runs `projects.service.relocate` through the canonical Action front door for the Account that
 * showed the service. The single reviewed set-plus-Move producer (Main71) is not published: today
 * the catalog keeps the Action off every surface, which this surface reports as is.
 */
async function requestServiceRelocation(
  input: Readonly<{
    address: Readonly<{ serverId: string; refId: string }>;
    serviceName: string;
    actual: ManagedActual;
    destination: ProjectExecutionChoiceV1;
    expectedAccountId: string;
    signal: AbortSignal;
    onApprovalPending: (registration: ActionApprovalRegistration) => void;
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
      const result = await executeServiceRelocationAction({
        execute: async request => {
          const result = await executor.execute(request.actionId, request.input, request.context);
          return result.ok ? result.result : result;
        },
        request: {
          workspace: input.address,
          serviceName: input.serviceName,
          requestId: randomUUID(),
          currentTarget: {
            kind: 'managed_service',
            managedServiceId,
            machineId: input.actual.machineId,
            ...(input.actual.workspaceId ? { workspaceId: input.actual.workspaceId } : {}),
            ...(input.actual.cwd ? { cwd: input.actual.cwd } : {}),
            ...(input.actual.declaration ? { declaration: input.actual.declaration } : {}),
          },
          destination: input.destination,
        },
        context: {
          surface: 'ui',
          serverId: account.serverId,
          runtimeAccountId: account.accountId,
          actionRequestId: randomUUID(),
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
    /** Changes whenever the Services feed observes this service's lifecycle; the binding is then re-read. */
    lifecycleKey?: string;
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
  const placement = useProjectServicePlacement(props.source, props.serviceName, { lifecycleKey: props.lifecycleKey });
  const { refresh } = placement;
  const anchorRef = React.useRef<View>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [requestedMove, setMove] = React.useState<MoveState>(null);
  const observation = useProjectServicePlacementObservation(props.serviceName);
  const move = observation.attachment ? { phase: 'operation' as const, ...observation.attachment } : requestedMove;
  const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
  const moveRequest = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    setMove(null);
    return () => { moveRequest.current?.abort(); };
  }, [binding, props.source.serverId, props.source.refId, props.source.machineId, props.serviceName]);

  const state = placement.state;
  const ready = state.kind === 'ready' ? state.value : null;
  const observed = ready?.actual ?? null;
  const actual = observed?.status === 'present' ? observed.target : null;
  const runsOn = ready?.placement.runsOn ?? null;
  const portable = props.declaration?.portable === true;
  const label = useWorkerDestinationLabel(props.source.serverId, runsOn, props.source.machineId);
  const sourceMachine = useServerScopedMachine(props.source.serverId, props.source.machineId);
  const sourceName = (sourceMachine ? getMachineDisplayName(sourceMachine) : null) ?? t('projectWorkers.primary');
  const actualMachine = useServerScopedMachine(props.source.serverId, actual?.machineId ?? '');
  const pendingDestination = move && move.phase !== 'refused' ? move.destination : null;
  const pendingLabel = useWorkerDestinationLabel(props.source.serverId, pendingDestination, props.source.machineId);

  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify(['projects.service.relocate', props.source.serverId, props.source.refId, props.serviceName]),
    serverId: props.source.serverId,
    onExecuted: refresh,
  });
  const operation = observation.operation;
  const stop = observation.stop;
  const operationState = move?.phase === 'operation' ? operation?.snapshot.state ?? null : null;
  const terminal = operationState === 'succeeded' || operationState === 'failed' || operationState === 'cancelled';
  React.useEffect(() => {
    // A terminal Action state alone says nothing about native service custody.
    if (!terminal) return;
    refresh();
    if (operationState === 'succeeded') {
      const result = ProjectServiceRelocateResultV1Schema.safeParse(operation?.snapshot.result);
      if (result.success && (result.data.status === 'moved' || result.data.status === 'unchanged')) observation.clear();
    }
  }, [observation.clear, operation?.snapshot.result, operationState, refresh, terminal]);
  const phase = operation?.snapshot.progress?.kind === 'phase' ? operation.snapshot.progress.phase : null;
  const outcomeUncertain = operation?.snapshot.observation?.kind === 'outcome_uncertain'
    || operation?.snapshot.error?.errorCode === 'outcome_uncertain';
  // The canonical relocation producer publishes `stopped` right after a literally confirmed native
  // Stop and `copying` only once copying begins (FX12); the Action operation owner retains the final
  // phase on failure/cancellation. Absence is separately observed, so neither generic terminal
  // state nor a lost feed proves Stop.
  const stoppedBeforeStart = terminal && (phase === 'stopped' || phase === 'copying') && !outcomeUncertain
    && operation?.observation === 'available' && observed?.status === 'absent';

  const custodyKnown = observed?.status === 'present' || observed?.status === 'absent';
  const moving = move?.phase === 'requesting' || move?.phase === 'approval' || (move?.phase === 'operation' && !stoppedBeforeStart);
  const disabled = !ready || placement.busy || moving || !custodyKnown || !portable;
  const notice = noticeText(placement.notice);
  const toName = pendingLabel.name ?? (pendingDestination?.kind === 'primary' ? sourceName : '');
  const operationBanner = move?.phase === 'operation' ? (
    <AttentionBanner
      testID={`${testID}.move.operation`}
      tone={terminal || outcomeUncertain ? 'warning' : 'neutral'}
      title={operation?.observation !== 'available' || outcomeUncertain ? t('projectServices.moveUnknown')
        : operation?.snapshot.observation?.kind === 'stop_unconfirmed' || operation?.snapshot.error?.errorCode === 'stop_unconfirmed'
          ? t('project.run.stopUnconfirmed')
          : stoppedBeforeStart ? t(operationState === 'cancelled' ? 'projectServices.moveCancelledStopped' : 'projectServices.moveFailedStopped')
            : terminal ? t('projectServices.moveUnknown')
              : stop?.pending || stop?.stopRequested ? t('projectServices.cancelPending')
                : t('projectServices.moving', { service: props.serviceName, to: toName })}
      description={operation?.snapshot.progress?.label}
      {...(operation?.snapshot.error ? { details: [operation.snapshot.error.errorCode] } : {})}
      action={{ label: t('projectServices.inspect'), testID: `${testID}.move.inspect`,
        onPress: () => openActionOperationDetail({ serverId: props.source.serverId, operationId: move.operationId }) }}
      secondaryAction={!terminal && operation?.observation === 'available' && operation?.snapshot.cancellation === 'supported' && stop ? {
        label: t('common.cancel'), testID: `${testID}.move.stop`, disabled: stop.pending || stop.stopRequested,
        onPress: stop.requestStop,
      } : null}
    />
  ) : null;

  if (state.kind === 'refused' || state.kind === 'error') {
    return (
      <View testID={testID}>
        <Item testID={`${testID}.unavailable`} title={t('projectServices.runsOn')}
          subtitle={t('projectServices.settingsUnavailable')} mode="info" showChevron={false} />
        {operationBanner}
      </View>
    );
  }

  const desiredName = runsOn?.kind === 'primary'
    ? t('projectServices.thisMachine', { name: sourceName })
    : runsOn?.kind === 'workers' && runsOn.destination.kind === 'pool'
      ? [t('projectServices.anyWorker'), label.name].filter(Boolean).join(' · ')
      : (label.name ?? (label.missing ? t('projectServices.destinationMissing') : null));
  const actualName = actual
    ? actual.machineId === props.source.machineId
      ? t('projectServices.thisMachine', { name: sourceName })
      : (actualMachine ? getMachineDisplayName(actualMachine) : null) ?? t('projectServices.otherMachine')
    : null;
  // A live occurrence is named where it actually runs; desired intent only describes the next start.
  const value = actualName ?? (observed?.status === 'ambiguous'
      ? t('projectServices.actualAmbiguous')
      : observed?.status === 'unavailable'
        ? t('projectServices.actualUnavailable')
        : observed?.status === 'absent'
          ? !portable ? t('projectServices.thisMachine', { name: sourceName }) : desiredName
          : null);
  const hint = observed?.status === 'unavailable'
      ? t('projectServices.actualUnavailable')
      : observed?.status === 'ambiguous'
        ? t('projectServices.actualAmbiguousDetail')
        : !portable
          ? t('projectServices.primaryOnly')
          : stoppedBeforeStart && desiredName
          ? t('projectServices.willStartOn', { name: desiredName })
          : actual || !runsOn
            ? undefined
            : runsOn.kind === 'primary'
              ? t('projectServices.runsHere')
              : label.name ? t('projectServices.runsOnWorker', { name: label.name }) : undefined;

  const choose = (choice: ProjectExecutionChoiceV1) => {
    setPickerOpen(false);
    if (!ready || !custodyKnown || !portable || placement.busy || moving) return;
    if (actual) {
      // A running service never moves on selection: a different target asks first, the same one is a no-op.
      if (placement.canMove && !choiceMatchesActual(choice, actual, props.source.machineId)) setMove({ phase: 'confirm', destination: choice });
      return;
    }
    if (!placement.canSaveNextStart || sameChoice(choice, ready.placement.runsOn)) return;
    void placement.save({ ...ready.placement, runsOn: choice });
  };

  const confirmMove = async (destination: ProjectExecutionChoiceV1) => {
    if (!actual || !placement.canMove || !portable || !binding?.isCurrent() || moveRequest.current) return;
    const lifetime = new AbortController();
    moveRequest.current = lifetime;
    const retirement = binding.onRetire(() => lifetime.abort());
    setMove({ phase: 'requesting', destination });
    try {
      const result = await requestServiceRelocation({
        address: placement.address, serviceName: props.serviceName, actual, destination,
        expectedAccountId: binding.accountId, signal: lifetime.signal,
        onApprovalPending: registration => {
          approval.requestApproval(registration);
          setMove({ phase: 'approval', destination, artifactId: typeof registration === 'string' ? registration : registration.artifactId });
        },
      });
      if (lifetime.signal.aborted) return;
      if (result.status === 'accepted') {
        publishActionOperationObservation({ serverId: props.source.serverId, machineId: result.operation.scope.machineId,
          observation: 'available', snapshots: [result.operation] });
        setMove(null);
        observation.attach({ destination, operationId: result.operation.operationId });
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
          // The relocation producer is not published yet: the executor answers `unsupported`, and
          // the catalog keeps the Action off every surface (`action_disabled`). Both mean the same.
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
      if (lifetime.signal.aborted) return;
      setMove({ phase: 'refused', text: t('projectServices.moveUnknown'),
        code: error instanceof Error ? error.message : 'move_failed' });
    } finally {
      retirement.dispose();
      if (moveRequest.current === lifetime) moveRequest.current = null;
    }
  };

  const fromName = actualName ?? sourceName;

  return (
    <View testID={testID}>
      <View ref={anchorRef} collapsable={false}>
        <Item
          testID={`${testID}.runsOn`}
          title={t('projectServices.runsOn')}
          subtitle={hint}
          showChevron={compact && portable}
          accessoryLayout="adaptive"
          disabled={disabled}
          accessibilityExpanded={pickerOpen}
          onPress={() => {
            // Re-observe the binding before a lifecycle-sensitive choice.
            refresh();
            setPickerOpen(true);
          }}
          {...(compact || !portable
            ? { detail: value ?? undefined }
            : {
                rightElement: renderDropdownItemTriggerRightElement({
                  detail: value,
                  open: pickerOpen,
                  detailColor: theme.colors.text.primary,
                  chevronColor: theme.colors.text.secondary,
                  field: resolveFieldBoxColors(theme, label.missing && !actual ? 'invalid' : 'idle'),
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
          title={observed.status === 'ambiguous' ? t('projectServices.actualAmbiguous') : t('projectServices.actualUnavailable')}
          action={{ label: t('common.retry'), testID: `${testID}.custody.retry`, onPress: refresh }}
        />
      ) : null}
      <SegmentedChoiceItem<'primary' | 'fail'>
        testIDPrefix={`${testID}.fallback`}
        title={t('projectServices.whenUnavailable')}
        accessoryLayout={compact ? 'stacked' : 'adaptive'}
        disabled={!placement.canSaveNextStart || moving || !portable}
        value={ready?.placement.unavailable ?? 'fail'}
        options={[
          { id: 'primary', label: t('projectServices.fallbackPrimary') },
          { id: 'fail', label: t('projectServices.fallbackFail') },
        ]}
        onChange={(unavailable) => {
          if (!ready || unavailable === ready.placement.unavailable) return;
          void placement.save({ ...ready.placement, unavailable });
        }}
      />
      {notice ? <AttentionBanner testID={`${testID}.notice`} tone="neutral" title={notice} /> : null}
      {move?.phase === 'confirm' || move?.phase === 'requesting' ? (
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
            onPress: () => void confirmMove(move.destination),
          }}
          secondaryAction={{
            label: t('common.cancel'),
            testID: `${testID}.move.cancel`,
            disabled: move.phase === 'requesting',
            onPress: () => setMove(null),
          }}
        />
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
        />
      ) : null}
    </View>
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
    if (declaration.workspaceRefId !== source.refId && row.target.machineId === source.machineId) return null;
    // Placement lives on the SOURCE checkout's ref; a running worker copy carries its own ref.
    return (
      <ProjectServicePlacementControls
        source={source}
        serviceName={declaration.selection.name}
        declaration={declarations[declaration.selection.name]}
        // The feed's observed lifecycle of this row re-reads the actual binding (Start/Stop/reconnect).
        lifecycleKey={JSON.stringify([row.status, row.target.machineId, row.target.serviceState ?? '', row.target.id,
          row.target.sourceClass?.kind === 'managed_service' ? row.target.sourceClass.managedServiceId : null])}
      />
    );
  };
}
