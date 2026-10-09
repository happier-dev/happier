import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type {
  ProjectServicePlacementGetResultV1,
  ProjectServicePlacementV1,
} from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { ProjectServiceRelocateResultV1Schema, type ProjectServiceRelocateResultV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

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
) {
  const address = React.useMemo(
    () => ({ serverId: source.serverId, refId: source.refId }),
    [source.serverId, source.refId],
  );
  const setting = useObservedWorkerSetting<ReadyPlacement>({
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
  const save = React.useCallback(
    async (value: ProjectServicePlacementV1) => {
      await mutate((accountId, current) =>
        executeProjectWorkerActionV1(
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
          { expectedAccountId: accountId },
        ),
      );
      refresh();
    },
    [address, mutate, refresh, serviceName],
  );
  return { ...setting, address, save };
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

function sameChoice(
  left: ProjectExecutionChoiceV1,
  right: ProjectExecutionChoiceV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'primary' || right.kind === 'primary') return true;
  const a = left.destination;
  const b = right.destination;
  return a.kind === 'machine'
    ? b.kind === 'machine' && a.machineId === b.machineId
    : b.kind === 'pool' && a.poolId === b.poolId;
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
  | Readonly<{ phase: 'refused'; text: string; code?: string }>
  | null;

/**
 * Runs `projects.service.relocate` through the canonical Action front door. The single reviewed
 * set-plus-Move producer (Main71) is not published: today the executor answers
 * `unsupported / service_relocation_unavailable`, which this surface reports as is.
 */
async function requestServiceRelocation(
  input: Readonly<{
    address: Readonly<{ serverId: string; refId: string }>;
    serviceName: string;
    actual: ManagedActual;
    destination: ProjectExecutionChoiceV1;
  }>,
): Promise<
  | ProjectServiceRelocateResultV1
  | Readonly<{ status: 'failed'; errorCode: string }>
  | Readonly<{ status: 'approval' }>
> {
  const managedServiceId =
    input.actual.sourceClass?.kind === 'managed_service'
      ? input.actual.sourceClass.managedServiceId
      : null;
  if (!managedServiceId)
    return { status: 'refused', reasonCode: 'service_binding_unavailable' };
  return await withDefaultActionExecuteContext(
    undefined,
    { serverId: input.address.serverId },
    async (executor, account) => {
      account.assertCurrent();
      const outcome = await executor.execute(
        'projects.service.relocate',
        {
          workspace: input.address,
          serviceName: input.serviceName,
          requestId: randomUUID(),
          currentTarget: {
            kind: 'managed_service',
            managedServiceId,
            machineId: input.actual.machineId,
            ...(input.actual.workspaceId
              ? { workspaceId: input.actual.workspaceId }
              : {}),
            ...(input.actual.cwd ? { cwd: input.actual.cwd } : {}),
            ...(input.actual.declaration
              ? { declaration: input.actual.declaration }
              : {}),
          },
          destination: input.destination,
        },
        {
          surface: 'ui',
          serverId: account.serverId,
          runtimeAccountId: account.accountId,
          actionRequestId: randomUUID(),
        },
      );
      if (!outcome.ok)
        return {
          status: 'failed',
          errorCode: outcome.errorCode ?? 'unsupported_action',
        };
      // Ask first: the reviewed request waits in its approval Artifact; nothing has moved yet.
      if (ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result).success) return { status: 'approval' };
      const parsed = ProjectServiceRelocateResultV1Schema.safeParse(outcome.result);
      return parsed.success ? parsed.data : { status: 'failed', errorCode: 'invalid_action_output' };
    },
  );
}

/**
 * A service's "Runs on" and "If it can't run there" (32s1, lab `s-services RUNSON/PICK/MOVE/RUNSONp`),
 * shown in the service's expansion (desktop) or its pushed page (phone). For a stopped service a
 * choice saves where it starts next; for a running one a different choice opens the Move
 * confirmation in place and saves nothing until confirmed.
 */
export function ProjectServicePlacementControls(
  props: Readonly<{
    testID?: string;
    source: ProjectServiceSource;
    serviceName: string;
  }>,
) {
  const testID =
    props.testID ?? `project-service-placement:${props.serviceName}`;
  const { theme } = useUnistyles();
  const compact = useViewportClass() === 'compact';
  const placement = useProjectServicePlacement(
    props.source,
    props.serviceName,
  );
  const anchorRef = React.useRef<View>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [move, setMove] = React.useState<MoveState>(null);
  const state = placement.state;
  const ready = state.kind === 'ready' ? state.value : null;
  const runsOn = ready?.placement.runsOn ?? null;
  const label = useWorkerDestinationLabel(
    props.source.serverId,
    runsOn,
    props.source.machineId,
  );
  const sourceMachine = useServerScopedMachine(
    props.source.serverId,
    props.source.machineId,
  );
  const sourceName =
    (sourceMachine ? getMachineDisplayName(sourceMachine) : null) ??
    t('projectWorkers.primary');
  const actual =
    ready?.actual.status === 'present' ? ready.actual.target : null;
  const actualMachine = useServerScopedMachine(
    props.source.serverId,
    actual?.machineId ?? '',
  );
  const pendingDestination =
    move && move.phase !== 'refused' ? move.destination : null;
  const pendingLabel = useWorkerDestinationLabel(
    props.source.serverId,
    pendingDestination,
    props.source.machineId,
  );
  const disabled = !ready || placement.busy || move?.phase === 'requesting';
  const notice = noticeText(placement.notice);

  if (state.kind === 'refused' || state.kind === 'error') {
    return (
      <Item
        testID={`${testID}.unavailable`}
        title={t('projectServices.runsOn')}
        subtitle={t('projectServices.settingsUnavailable')}
        mode="info"
        showChevron={false}
      />
    );
  }

  const value =
    runsOn?.kind === 'primary'
      ? t('projectServices.thisMachine', { name: sourceName })
      : runsOn?.kind === 'workers' && runsOn.destination.kind === 'pool'
        ? [t('projectServices.anyWorker'), label.name].filter(Boolean).join(' · ')
        : (label.name ??
          (label.missing ? t('projectServices.destinationMissing') : null));
  const hint = !runsOn
    ? undefined
    : runsOn.kind === 'primary'
      ? t('projectServices.runsHere')
      : label.name
        ? t('projectServices.runsOnWorker', { name: label.name })
        : undefined;

  const choose = (choice: ProjectExecutionChoiceV1) => {
    setPickerOpen(false);
    if (!ready) return;
    if (actual) {
      // A running service never moves on selection: a different target asks first, the same one is a no-op.
      if (!choiceMatchesActual(choice, actual, props.source.machineId))
        setMove({ phase: 'confirm', destination: choice });
      return;
    }
    if (sameChoice(choice, ready.placement.runsOn)) return;
    void placement.save({ ...ready.placement, runsOn: choice });
  };

  const confirmMove = async (destination: ProjectExecutionChoiceV1) => {
    if (!actual) return;
    setMove({ phase: 'requesting', destination });
    try {
      const result = await requestServiceRelocation({
        address: placement.address,
        serviceName: props.serviceName,
        actual,
        destination,
      });
      if (
        result.status === 'accepted' ||
        result.status === 'moved' ||
        result.status === 'unchanged'
      ) {
        setMove(null);
        placement.refresh();
        return;
      }
      setMove({
        phase: 'refused',
        text:
          result.status === 'approval'
            ? t('projectWorkers.approvalPending')
            // The relocation producer is not published yet: the executor answers `unsupported`, and
            // the catalog keeps the Action off every surface (`action_disabled`). Both mean the same.
            : result.status === 'unsupported' || (result.status === 'failed'
                && (result.errorCode === 'action_disabled' || result.errorCode === 'unsupported_action'))
            ? t('projectServices.moveUnavailable')
            : result.status === 'refused'
              ? t('projectServices.moveRefused')
              : t('projectServices.moveUnknown'),
        // The owner's reason code stays behind Details; it is never the message.
        ...('reasonCode' in result ? { code: result.reasonCode } : 'errorCode' in result ? { code: result.errorCode } : {}),
      });
    } catch (error) {
      setMove({ phase: 'refused', text: t('projectServices.moveUnknown'),
        code: error instanceof Error ? error.message : 'move_failed' });
    }
  };

  const actualName =
    (actualMachine ? getMachineDisplayName(actualMachine) : null) ?? sourceName;
  const toName =
    pendingLabel.name ??
    (pendingDestination?.kind === 'primary' ? sourceName : '');

  return (
    <View testID={testID}>
      <View ref={anchorRef} collapsable={false}>
        <Item
          testID={`${testID}.runsOn`}
          title={t('projectServices.runsOn')}
          showChevron={compact}
          accessoryLayout="adaptive"
          disabled={disabled}
          accessibilityExpanded={pickerOpen}
          onPress={() => setPickerOpen(true)}
          {...(compact
            ? { detail: value ?? undefined }
            : {
                rightElement: renderDropdownItemTriggerRightElement({
                  detail: value,
                  open: pickerOpen,
                  detailColor: theme.colors.text.primary,
                  chevronColor: theme.colors.text.secondary,
                  field: resolveFieldBoxColors(
                    theme,
                    label.missing ? 'invalid' : 'idle',
                  ),
                  placeholder: t('common.loading'),
                  placeholderColor: theme.colors.input.placeholder,
                }),
              })}
        />
      </View>
      <SegmentedChoiceItem<'primary' | 'fail'>
        testIDPrefix={`${testID}.fallback`}
        title={t('projectServices.whenUnavailable')}
        subtitle={hint}
        accessoryLayout={compact ? 'stacked' : 'adaptive'}
        disabled={disabled}
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
      {notice ? (
        <AttentionBanner
          testID={`${testID}.notice`}
          tone="neutral"
          title={notice}
        />
      ) : null}
      {move && move.phase !== 'refused' ? (
        <AttentionBanner
          testID={`${testID}.move`}
          tone="neutral"
          title={t('projectServices.moveConfirm', {
            service: props.serviceName,
            from: actualName,
            to: toName,
          })}
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
      {move?.phase === 'refused' ? (
        <AttentionBanner
          testID={`${testID}.move.refused`}
          tone="warning"
          title={move.text}
          {...(move.code ? { details: [move.code] } : {})}
          secondaryAction={{
            label: t('common.ok'),
            onPress: () => setMove(null),
          }}
        />
      ) : null}
      {ready ? (
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
          primary={{
            title: t('projectServices.thisMachine', { name: sourceName }),
          }}
          poolSelection="automatic"
          servicePresentation
          selected={pendingDestination ?? ready.placement.runsOn}
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
): ((row: ServiceRow) => React.ReactNode) | undefined {
  if (!source) return undefined;
  return (row) => {
    const declaration = row.target.declaration;
    if (!declaration || declaration.selection.kind !== 'manifest') return null;
    // Another checkout's service (This machine scope) has its own placement; only this checkout's
    // declarations, or their copies running on a worker, show this checkout's Runs on.
    if (declaration.workspaceRefId !== source.refId && row.target.machineId === source.machineId) return null;
    // Placement lives on the SOURCE checkout's ref; a running worker copy carries its own ref.
    return <ProjectServicePlacementControls source={source} serviceName={declaration.selection.name} />;
  };
}
