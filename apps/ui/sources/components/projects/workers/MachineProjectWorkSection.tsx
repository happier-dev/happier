import * as React from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { useUnistyles } from 'react-native-unistyles';
import type { ProjectWorkerActionOutputV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';

import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { Modal } from '@/modal';
import { useActiveActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useAllMachines } from '@/sync/domains/state/storage';
import { useProjectAccountRows } from '@/sync/store/hooks';
import { readMachineFreshCopies } from '@/sync/store/domains/projectAccountRows';
import {
  executeProjectWorkerActionV1,
  ProjectWorkerActionError,
} from '@/sync/ops/actions/projectWorkerActions';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatRunClock } from '@/components/projects/projectSetup/projectScriptPresentation';

import {
  useObservedWorkerSetting,
  type ObservedWorkerSettingNotice,
} from './useObservedWorkerSetting';

type ReadyPolicy = Extract<ProjectWorkerActionOutputV1<'machines.worker.policy.get'>, { status: 'ready' }>;

function noticeText(notice: ObservedWorkerSettingNotice): string | null {
  switch (notice) {
    case 'saving':
      return t('projectWorkers.saving');
    case 'approval':
      return t('projectWorkers.approvalPending');
    case 'unknown':
      return t('projectWorkers.writeUnknown');
    case 'changed':
      return t('projectWorkers.changed');
    case 'failed':
      return t('projectWorkers.saveFailed');
    case 'locked':
      return t('projectWorkers.settingsLocked');
    default:
      return null;
  }
}

/** The Machine's own finite work policy, read and changed through `machines.worker.policy.*` (30s1). */
export function useMachineWorkerPolicy(serverId: string, machineId: string) {
  const setting = useObservedWorkerSetting<ReadyPolicy, ReadyPolicy['policy']>({
    serverId,
    scopeKey: JSON.stringify(['machines.worker.policy', serverId, machineId]),
    read: (accountId) =>
      executeProjectWorkerActionV1(
        'machines.worker.policy.get',
        { serverId, machineId },
        { expectedAccountId: accountId },
      ),
    observedFromReceipt: (receipt) =>
      'policy' in receipt
        ? ({
            ...(receipt as {
              policy: ReadyPolicy['policy'];
              metadataVersion: number;
            }),
            status: 'ready',
            source: 'stored',
          } as ReadyPolicy)
        : null,
  });
  const { mutate } = setting;
  const save = React.useCallback(
    (policy: ReadyPolicy['policy']) =>
      mutate((_accountId, current, approvalOptions) =>
        executeProjectWorkerActionV1(
          'machines.worker.policy.set',
          {
            serverId,
            machineId,
            expectedPolicy: current.policy,
            expectedMetadataVersion: current.metadataVersion,
            policy,
          },
          approvalOptions,
        ),
        policy,
      ),
    [machineId, mutate, serverId],
  );
  return { ...setting, save };
}

type FreshCopy = Readonly<{
  relationship: WorkspaceSyncRelationshipV1;
  sourceRefId: string;
  name: string;
  sourceMachineId: string;
}>;

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Present only canonical worker targets from the current Account/Home row observation. */
function useFreshCopies(
  serverId: string,
  machineId: string,
): readonly FreshCopy[] | null {
  const rows = useProjectAccountRows();
  return React.useMemo(() => {
    if (!rows) return null;
    const copies = readMachineFreshCopies({ projectAccountRows: rows }, {
      scope: { accountId: rows.scope.accountId, serverId }, machineId,
    });
    return copies?.map(({ relationship, source }) => ({
      relationship,
      sourceRefId: source.id,
      name: source.label ?? basename(source.rootPath),
      sourceMachineId: source.machineId,
    })) ?? null;
  }, [machineId, rows, serverId]);
}

function RunningHereRow(
  props: Readonly<{ operation: ActionOperationProjection; testID: string }>,
) {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const ref = props.operation.snapshot.domainRef;
  const command = ref?.kind === 'projectCommand' ? ref : null;
  const source = command?.sourceWorkspace
    ? machines.find(
        (machine) => machine.id === command.sourceWorkspace?.machineId,
      )
    : null;
  const elapsed = useElapsedTime(props.operation.snapshot.createdAt ?? null);
  const name =
    command?.script?.name ??
    props.operation.snapshot.title ??
    command?.cwd ??
    '';
  return (
    <Item
      testID={props.testID}
      title={name}
      subtitle={[
        source
          ? t('projectWorkers.yours', {
              machine: getMachineDisplayName(source) ?? '',
            })
          : null,
        elapsed !== null ? formatRunClock(elapsed) : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      leftElement={
        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
      }
      showChevron={false}
      rightElement={
        <RoundButton
          size="small"
          display="secondary"
          title={t('projectWorkers.open')}
          testID={`${props.testID}.open`}
          onPress={() =>
            openActionOperationDetail({
              serverId: props.operation.serverId,
              operationId: props.operation.snapshot.operationId,
            })
          }
        />
      }
    />
  );
}

/**
 * Machine › Work from your projects (30s3/31s3, lab `s-workers MACHINE`): whether this Machine takes
 * new Project work and how much at once, your runs on it now, and the fresh copies it keeps. Policy
 * changes only affect future admissions; accepted work is never cancelled or moved here.
 * Teammates' work stays in the existing "In use by others" summary (42s3, counts only).
 */
export function MachineProjectWorkSection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    testID?: string;
  }>,
) {
  const testID = props.testID ?? 'machine-project-work';
  const { theme } = useUnistyles();
  const router = useRouter();
  const policy = useMachineWorkerPolicy(props.serverId, props.machineId);
  const active = useActiveActionOperations();
  const running = React.useMemo(
    () =>
      active.filter((operation) => {
        const ref = operation.snapshot.domainRef;
        return (
          ref?.kind === 'projectCommand' &&
          ref.machineId === props.machineId &&
          ref.serverId === props.serverId
        );
      }),
    [active, props.machineId, props.serverId],
  );
  const [capacityError, setCapacityError] = React.useState<string | null>(null);
  const compact = useViewportClass() === 'compact';
  const capacityAnchor = React.useRef<View>(null);
  const [capacityOpen, setCapacityOpen] = React.useState(false);
  const copies = useFreshCopies(props.serverId, props.machineId);
  const machines = useAllMachines();
  const [retired, setRetired] = React.useState<ReadonlySet<string>>(new Set());
  const [copyNotice, setCopyNotice] = React.useState<Readonly<{
    relationshipId: string;
    text: string;
  }> | null>(null);
  const visibleCopies = copies?.filter(
    (copy) => !retired.has(copy.relationship.relationshipId),
  ) ?? null;
  const state = policy.state;
  const value = state.kind === 'ready' ? state.value.policy : null;
  const disabled = !value || policy.busy;
  const notice = noticeText(policy.notice);

  const remove = async (copy: FreshCopy) => {
    const confirmed = await Modal.confirm(
      t('projectWorkers.removeConfirm', {
        name: copy.name,
        machine: props.machineName,
      }),
      t('projectWorkers.removeDetail'),
      { confirmText: t('projectWorkers.removeAction') },
    );
    if (!confirmed) return;
    setCopyNotice(null);
    try {
      const result = await executeProjectWorkerActionV1(
        'projects.worker.copy.retire',
        {
          workspace: { serverId: props.serverId, refId: copy.sourceRefId },
          machineId: copy.relationship.controllerMachineId,
          expectedRelationship: copy.relationship,
        },
      );
      if (result.status === 'retired') {
        setRetired(
          (current) => new Set([...current, copy.relationship.relationshipId]),
        );
      }
    } catch (error) {
      const code =
        error instanceof ProjectWorkerActionError ? error.errorCode : '';
      setCopyNotice({
        relationshipId: copy.relationship.relationshipId,
        text:
          code === 'approval_required'
            ? t('projectWorkers.approvalPending')
            : code === 'outcome_unknown' || code === 'outcomeUnknown'
              ? t('projectWorkers.removeUnknown')
              : code.includes('in_use') || code.includes('dependen')
                ? t('projectWorkers.removeInUse')
                : t('projectWorkers.removeFailed'),
      });
    }
  };

  return (
    <>
      <ItemGroup
        title={t('projectWorkers.workSection')}
        description={t('projectWorkers.workSectionDetail')}
      >
        {notice ? (
          <AttentionBanner
            testID={`${testID}.notice`}
            tone={
              policy.notice === 'saving' || policy.notice === 'approval'
                ? 'neutral'
                : 'warning'
            }
            title={notice}
            // The intended policy that did not save stays until retried against the current value or discarded.
            {...(policy.draft && policy.notice !== 'saving' && policy.notice !== 'approval'
              ? {
                  description: t('projectWorkers.draftKept'),
                  action: {
                    label: t('projectWorkers.draftRetry'),
                    testID: `${testID}.draft.retry`,
                    onPress: () => { if (policy.draft) void policy.save(policy.draft); },
                  },
                  secondaryAction: {
                    label: t('projectWorkers.draftDiscard'),
                    testID: `${testID}.draft.discard`,
                    onPress: policy.discardDraft,
                  },
                }
              : {})}
          />
        ) : null}
        {state.kind === 'refused' || state.kind === 'error' ? (
          <Item
            testID={`${testID}.unavailable`}
            title={t('projectWorkers.policyUnavailable')}
            mode="info"
            showChevron={false}
            rightElement={
              <RoundButton
                size="small"
                display="secondary"
                title={t('common.retry')}
                onPress={policy.refresh}
              />
            }
          />
        ) : (
          <>
            <Item
              testID={`${testID}.accepting`}
              title={t('projectWorkers.accepting')}
              subtitle={
                !value
                  ? t('common.loading')
                  : value.accepting
                    ? t('projectWorkers.acceptingNow')
                    : `${t('projectWorkers.notAccepting')} · ${t('projectWorkers.notAcceptingDetail')}`
              }
              showChevron={false}
              disabled={disabled}
              rightElement={
                <Switch
                  testID={`${testID}.accepting.switch`}
                  value={value?.accepting ?? true}
                  disabled={disabled}
                  accessibilityLabel={t('projectWorkers.accepting')}
                  onValueChange={(accepting) => {
                    if (value) void policy.save({ ...value, accepting });
                  }}
                />
              }
            />
            {compact ? (
              // Phone (lab MACHINEp): the row shows its value and opens the same field in a sheet.
              <View ref={capacityAnchor} collapsable={false}>
                <Item
                  testID={`${testID}.capacity.row`}
                  title={t('projectWorkers.capacity')}
                  detail={value?.runAtMost == null ? t('projectWorkers.noLimit') : String(value.runAtMost)}
                  disabled={disabled}
                  onPress={() => setCapacityOpen(true)}
                />
                <Popover
                  open={capacityOpen}
                  anchorRef={capacityAnchor}
                  phonePresentation="sheet"
                  accessibilityLabel={t('projectWorkers.capacity')}
                  onRequestClose={() => setCapacityOpen(false)}
                >
                  {({ maxHeight }) => (
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
            <FieldValueItem
                                    testID={`${testID}.capacity`}
                                    fieldTestID={`${testID}.capacity.field`}
                                    title={t('projectWorkers.capacity')}
                                    subtitle={t('projectWorkers.capacityDetail')}
                                    kind="integer"
                                    allowEmpty
                                    error={capacityError}
                                    onDraftChange={() => setCapacityError(null)}
                                    placeholder={t('projectWorkers.noLimit')}
                                    disabled={disabled}
                                    value={
                                      value?.runAtMost === null || value?.runAtMost === undefined
                                        ? ''
                                        : String(value.runAtMost)
                                    }
                                    onCommit={(draft) => {
                                      if (!value) return;
                                      const trimmed = draft.trim();
                                      if (trimmed === '') {
                                        if (value.runAtMost !== null)
                                          void policy.save({ ...value, runAtMost: null });
                                        return '';
                                      }
                                      const count = Number(trimmed);
                                      if (!Number.isSafeInteger(count) || count < 1) {
                                        // The typed draft stays so it can be corrected; nothing is written.
                                        setCapacityError(t('projectWorkers.capacityInvalid'));
                                        return;
                                      }
                                      if (count !== value.runAtMost)
                                        void policy.save({ ...value, runAtMost: count });
                                      return String(count);
                                    }}
                                  />
                    </FloatingOverlay>
                  )}
                </Popover>
              </View>
            ) : (
            <FieldValueItem
              testID={`${testID}.capacity`}
              fieldTestID={`${testID}.capacity.field`}
              title={t('projectWorkers.capacity')}
              subtitle={t('projectWorkers.capacityDetail')}
              kind="integer"
              allowEmpty
              error={capacityError}
              onDraftChange={() => setCapacityError(null)}
              placeholder={t('projectWorkers.noLimit')}
              disabled={disabled}
              value={
                value?.runAtMost === null || value?.runAtMost === undefined
                  ? ''
                  : String(value.runAtMost)
              }
              onCommit={(draft) => {
                if (!value) return;
                const trimmed = draft.trim();
                if (trimmed === '') {
                  if (value.runAtMost !== null)
                    void policy.save({ ...value, runAtMost: null });
                  return '';
                }
                const count = Number(trimmed);
                if (!Number.isSafeInteger(count) || count < 1) {
                  // The typed draft stays so it can be corrected; nothing is written.
                  setCapacityError(t('projectWorkers.capacityInvalid'));
                  return;
                }
                if (count !== value.runAtMost)
                  void policy.save({ ...value, runAtMost: count });
                return String(count);
              }}
            />
            )}
          </>
        )}
      </ItemGroup>

      <ItemGroup
        title={t('projectWorkers.runningHere')}
      >
        {running.length === 0 ? (
          <Item
            testID={`${testID}.running.empty`}
            title={t('projectWorkers.nothingRunning')}
            mode="info"
            showChevron={false}
          />
        ) : (
          running.map((operation) => (
            <RunningHereRow
              key={operation.snapshot.operationId}
              operation={operation}
              testID={`${testID}.running:${operation.snapshot.operationId}`}
            />
          ))
        )}
      </ItemGroup>

      <ItemGroup
        title={t('projectWorkers.freshCopies')}
        description={t('projectWorkers.freshCopiesDetail')}
        action={
          <SectionActionButton
            testID={`${testID}.sync`}
            icon="arrow-right"
            title={t('projectWorkers.manageInSync')}
            onPress={() => router.push('/settings/session/handoff')}
          />
        }
      >
        {visibleCopies === null ? null : visibleCopies.length === 0 ? (
          <Item
            testID={`${testID}.copies.empty`}
            title={t('projectWorkers.freshCopiesEmpty')}
            mode="info"
            showChevron={false}
          />
        ) : (
          visibleCopies.map((copy) => {
            const sourceMachine = machines.find((machine) => machine.id === copy.sourceMachineId);
            const sourceName = sourceMachine ? getMachineDisplayName(sourceMachine) : null;
            const failure =
              copyNotice?.relationshipId === copy.relationship.relationshipId
                ? copyNotice.text
                : null;
            return (
              <Item
                key={copy.relationship.relationshipId}
                testID={`${testID}.copy:${copy.relationship.relationshipId}`}
                title={copy.name}
                subtitle={
                  failure ??
                  (sourceName
                    ? t('projectWorkers.copyFrom', { machine: sourceName })
                    : undefined)
                }
                icon={
                  <Icon
                    name="folder"
                    size={18}
                    color={theme.colors.text.secondary}
                  />
                }
                showChevron={false}
                rightElement={
                  <RoundButton
                    size="small"
                    display="inverted"
                    title={t('projectWorkers.remove')}
                    testID={`${testID}.copy:${copy.relationship.relationshipId}.remove`}
                    onPress={() => void remove(copy)}
                  />
                }
              />
            );
          })
        )}
      </ItemGroup>
    </>
  );
}
