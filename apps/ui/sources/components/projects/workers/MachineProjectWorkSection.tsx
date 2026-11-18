import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { useUnistyles } from 'react-native-unistyles';
import type { ProjectWorkerActionOutputV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';

import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useProjectCommandOutputOpener } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import { RunClock, RunGlyph } from '@/components/projects/projectSetup/ProjectRunMarks';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { CheckoutReachabilityLine, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { Switch } from '@/components/ui/forms/Switch';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useActiveActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useMachineFreshCopies, type MachineFreshCopy, type MachineFreshCopyNotice } from './useMachineFreshCopies';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { executeProjectWorkerActionV1 } from '@/sync/ops/actions/projectWorkerActions';
import { isMachineActivityPlaceholder } from '@/sync/domains/machines/machineActivity';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { presentProjectRun } from '@/components/projects/projectSetup/projectScriptPresentation';

import { useObservedWorkerSetting } from './useObservedWorkerSetting';
import { describeObservedWorkerSettingNotice } from './observedWorkerSettingNotice';

type ReadyPolicy = Extract<ProjectWorkerActionOutputV1<'machines.worker.policy.get'>, { status: 'ready' }>;

/** The Machine's own finite work policy, read and changed through `machines.worker.policy.*` (30s1). */
export function useMachineWorkerPolicy(serverId: string, machineId: string) {
  const machine = useServerScopedMachine(serverId, machineId);
  const setting = useObservedWorkerSetting<ReadyPolicy, ReadyPolicy['policy'], ProjectWorkerActionOutputV1<'machines.worker.policy.set'>>({
    // The metadata port needs the discovered row's storage/encryption context. Credentials
    // and presence can arrive first; a heartbeat-only row is not that context.
    enabled: machine != null && !isMachineActivityPlaceholder(machine),
    serverId,
    scopeKey: JSON.stringify(['machines.worker.policy', serverId, machineId]),
    read: (accountId) =>
      executeProjectWorkerActionV1(
        'machines.worker.policy.get',
        { serverId, machineId },
        { expectedAccountId: accountId },
      ),
    // A receipt that carries the policy is what the Machine now stores.
    observedFromReceipt: (receipt): ReadyPolicy | null =>
      'policy' in receipt
        ? { status: 'ready', source: 'stored', policy: receipt.policy, metadataVersion: receipt.metadataVersion }
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

/**
 * One of your runs on this Machine, read through the Scripts row presentation (plan 31 §2/§8):
 * queued/copying/preparing/offline/stop-unconfirmed come from the operation's own facts, and the
 * clock starts only once a terminal exists. Open uses the same output opener as the Scripts row.
 */
function RunningHereRow(
  props: Readonly<{ operation: ActionOperationProjection; machineName: string; testID: string }>,
) {
  const { theme } = useUnistyles();
  const ref = props.operation.snapshot.domainRef;
  const command = ref?.kind === 'projectCommand' ? ref : null;
  const source = useServerScopedMachine(
    command?.sourceWorkspace?.serverId ?? props.operation.serverId,
    command?.sourceWorkspace?.machineId ?? '',
  );
  const presentation = presentProjectRun(props.operation, props.machineName, '');
  const output = useProjectCommandOutputOpener(props.operation);
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
              machine: getMachineSentenceName(source),
            })
          : null,
        presentation.text,
      ]
        .filter(Boolean)
        .join(' · ')}
      icon={<RunGlyph glyph={presentation.glyph} />}
      showChevron={false}
      rightElement={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
          {presentation.live && presentation.startedAt ? (
            <RunClock startedAt={presentation.startedAt} />
          ) : null}
          <RoundButton
            size="small"
            display="secondary"
            title={t('projectWorkers.open')}
            testID={`${props.testID}.open`}
            onPress={() => void output.open(props.operation, { title: `${name} · ${props.machineName}`, name })}
          />
        </View>
      }
    />
  );
}

/**
 * One kept worker copy (lab `s-workers MACHINE` / `MACHINEp`): where it came from, when it was last
 * cleanly synced and its measured size (unknown facts are left out, never guessed). Remove… names the
 * two outcomes; consent belongs to the Action, so a pending approval is shown, not asked again here.
 */
const DEPENDENCY_STATE: Readonly<Record<NonNullable<MachineFreshCopyNotice['dependencies']>[number]['state'], () => string>> = {
  queued: () => t('projectWorkers.dependencyQueued'),
  reserved: () => t('projectWorkers.dependencyReserved'),
  copying: () => t('projectWorkers.dependencyCopying'),
  setup: () => t('projectWorkers.dependencySetup'),
  running: () => t('projectWorkers.dependencyRunning'),
};

function FreshCopyRow(
  props: Readonly<{
    testID: string;
    serverId: string;
    machineName: string;
    copy: MachineFreshCopy;
    compact: boolean;
    busy: boolean;
    approvalId: string | null;
    notice: MachineFreshCopyNotice | null;
    onRemove: (choice?: Readonly<{ removeFiles?: boolean }>) => void;
    onRefresh: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const source = useServerScopedMachine(props.serverId, props.copy.sourceMachineId);
  const from = source ? t('projectWorkers.copyFrom', { machine: getMachineSentenceName(source) }) : null;
  const time =
    props.copy.lastCleanSyncAtMs === null
      ? null
      : formatRelativeTimeShort(props.copy.lastCleanSyncAtMs, Date.now());
  const synced =
    time === null
      ? null
      : props.compact
        ? t('projectWorkers.copySynced', { time })
        : t('projectWorkers.copyLastSynced', { time });
  const size = props.copy.sizeBytes === null ? null : formatHappierDataBytes(props.copy.sizeBytes, { kind: 'storage' });
  // Phone keeps the row to "Synced … · size"; where it came from moves into the opened sheet.
  const facts = [props.compact ? null : from, synced, size].filter(Boolean).join(' · ');
  const icon = <Icon name="folder" size={18} color={theme.colors.text.secondary} />;
  const anchor = React.useRef<View>(null);
  const choices = [
    {
      id: 'keep',
      testID: `${props.testID}.remove:keep`,
      title: t('projectWorkers.removeKeepFiles'),
      subtitle: t('projectWorkers.removeDetail'),
    },
    {
      id: 'files',
      testID: `${props.testID}.remove:files`,
      title: t('projectWorkers.removeWithFiles'),
      subtitle: t('projectWorkers.removeWithFilesDetail', { machine: props.machineName }),
      destructive: true,
    },
  ];
  const choose = (id: string) => props.onRemove(id === 'files' ? { removeFiles: true } : undefined);
  const menu = (trigger: (control: Readonly<{ toggle: () => void }>) => React.ReactNode) => (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      rowKind="item"
      showCategoryTitles={false}
      placement="bottom"
      popoverAnchorAlign="end"
      matchTriggerWidth={false}
      maxWidthCap={340}
      items={choices}
      onSelect={choose}
      trigger={trigger}
    />
  );
  const approvalId = props.notice?.kind === 'approval' ? props.approvalId : null;
  // The executor's typed dependencies, named from your own operations where known (31s3).
  const active = useActiveActionOperations();
  const dependencies = props.notice?.dependencies ?? [];
  const ownDependency = dependencies
    .map((dependency) => active.find((operation) => operation.snapshot.operationId === dependency.operationId))
    .find((operation) => operation !== undefined) ?? null;
  const dependencyLines = dependencies.map((dependency) => {
    const operation = active.find((candidate) => candidate.snapshot.operationId === dependency.operationId);
    const ref = operation?.snapshot.domainRef;
    const name = (ref?.kind === 'projectCommand' ? ref.script?.name : null) ?? operation?.snapshot.title ?? t('projectWorkers.dependencyOther');
    return `${name} · ${DEPENDENCY_STATE[dependency.state]()}`;
  });
  return (
    <>
      {props.compact ? (
        <View ref={anchor} collapsable={false}>
          <Item
            testID={props.testID}
            title={props.copy.name}
            subtitle={facts || undefined}
            icon={icon}
            disabled={props.busy}
            onPress={() => setOpen(true)}
          />
          <Popover
            open={open}
            anchorRef={anchor}
            phonePresentation="sheet"
            accessibilityLabel={props.copy.name}
            onRequestClose={() => setOpen(false)}
          >
            {({ maxHeight }) => (
              <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
                <Item
                  title={props.copy.name}
                  subtitle={[from, synced, size].filter(Boolean).join(' · ') || undefined}
                  icon={icon}
                  mode="info"
                  showChevron={false}
                />
                {choices.map((choice) => (
                  <Item
                    key={choice.id}
                    testID={choice.testID}
                    title={choice.title}
                    subtitle={choice.subtitle}
                    destructive={choice.destructive === true}
                    showChevron={false}
                    onPress={() => {
                      setOpen(false);
                      choose(choice.id);
                    }}
                  />
                ))}
              </FloatingOverlay>
            )}
          </Popover>
        </View>
      ) : (
        <Item
          testID={props.testID}
          title={props.copy.name}
          subtitle={facts || undefined}
          icon={icon}
          showChevron={false}
          rightElement={menu(({ toggle }) => (
            <RoundButton
              size="small"
              display="inverted"
              title={t('projectWorkers.remove')}
              testID={`${props.testID}.remove`}
              disabled={props.busy}
              onPress={toggle}
            />
          ))}
        />
      )}
      {props.notice ? (
        <AttentionBanner
          testID={`${props.testID}.notice`}
          tone={props.notice.kind === 'saving' || props.notice.kind === 'approval' ? 'neutral' : 'warning'}
          title={props.notice.text}
          details={dependencyLines.length > 0 ? dependencyLines : undefined}
          action={
            approvalId
              ? {
                  label: t('approvals.title'),
                  testID: `${props.testID}.approval`,
                  onPress: () =>
                    router.push(
                      buildApprovalHref(approvalId, props.serverId),
                    ),
                }
              : ownDependency
                ? {
                    label: t('projectWorkers.openWork'),
                    testID: `${props.testID}.openWork`,
                    onPress: () =>
                      openActionOperationDetail({
                        serverId: ownDependency.serverId,
                        operationId: ownDependency.snapshot.operationId,
                      }),
                  }
                : props.notice.kind === 'unknown'
                  ? {
                      // Inspection only: rereads the copy's facts, never repeats the removal.
                      label: t('projectWorkers.checkAgain'),
                      testID: `${props.testID}.checkAgain`,
                      onPress: props.onRefresh,
                    }
                  : null
          }
        />
      ) : null}
    </>
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
  const freshCopies = useMachineFreshCopies(props.serverId, props.machineId);
  const state = policy.state;
  const value = state.kind === 'ready' ? state.value.policy : null;
  // An unreachable Machine keeps its last-known policy, says so once, and takes no edits it can't receive.
  // Whether it takes new work is not a fact while it is offline, so its Accept new work switch is not shown.
  const machineScope = React.useMemo(() => ({ serverId: props.serverId, machineId: props.machineId }), [props.serverId, props.machineId]);
  const reachability = useCheckoutReachability(machineScope);
  const unreachable = reachability.unreachable;
  // Someone who only uses this Machine reads its policy; Manage changes it, and the row says so.
  const { recipient } = useMachineTabFacts(props.serverId, props.machineId);
  const disabled = !value || policy.busy || unreachable || recipient;
  const acceptingState = !value
    ? t('common.loading')
    : value.accepting
      ? t('projectWorkers.acceptingNow')
      : `${t('projectWorkers.notAccepting')} · ${t('projectWorkers.notAcceptingDetail')}`;
  const notice = describeObservedWorkerSettingNotice(policy.notice);
  // One Run at most field: inline on wide screens, inside the phone sheet on a phone (lab MACHINEp).
  const capacityField = (
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
      value={value?.runAtMost === null || value?.runAtMost === undefined ? '' : String(value.runAtMost)}
      onCommit={(draft) => {
        if (!value) return;
        const trimmed = draft.trim();
        if (trimmed === '') {
          if (value.runAtMost !== null) void policy.save({ ...value, runAtMost: null });
          return '';
        }
        const count = Number(trimmed);
        if (!Number.isSafeInteger(count) || count < 1) {
          // The typed draft stays so it can be corrected; nothing is written.
          setCapacityError(t('projectWorkers.capacityInvalid'));
          return;
        }
        if (count !== value.runAtMost) void policy.save({ ...value, runAtMost: count });
        return String(count);
      }}
    />
  );

  return (
    <>
      <ItemGroup
        title={t('projectWorkers.workSection')}
        description={t('projectWorkers.workSectionDetail')}
      >
        {/* The Machine page already says its Machine is offline; standing alone, the section says it once itself. */}
        {reachability.announced ? null : (
          <CheckoutReachabilityLine scope={machineScope} testID={`${testID}.reachability`} />
        )}
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
          <SurfaceStateCard
            testID={`${testID}.unavailable`}
            size="line"
            kind="unavailable"
            title={t('projectWorkers.policyUnavailable')}
            action={{ label: t('common.retry'), onPress: policy.refresh }}
          />
        ) : (
          <>
            {unreachable ? null : <Item
              testID={`${testID}.accepting`}
              title={t('projectWorkers.accepting')}
              subtitle={recipient && value ? `${acceptingState} · ${t('machines.widgets.body.common.recipient')}` : acceptingState}
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
            />}
            {compact ? (
              // Phone (lab MACHINEp): the row shows its value and opens the same field in a sheet.
              <View ref={capacityAnchor} collapsable={false}>
                <Item
                  testID={`${testID}.capacity.row`}
                  title={t('projectWorkers.capacity')}
                  // Only a read policy has a ceiling to show; loading never claims No limit.
                  detail={!value ? t('common.loading') : value.runAtMost === null ? t('projectWorkers.noLimit') : String(value.runAtMost)}
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
                      {capacityField}
                    </FloatingOverlay>
                  )}
                </Popover>
              </View>
            ) : (
              capacityField
            )}
          </>
        )}
      </ItemGroup>

      {/* Present only once something runs here (MPG-8, lab s-workers MACHINE): an empty "Running here" is noise. */}
      {running.length > 0 ? (
        <ItemGroup surface="none" title={t('projectWorkers.runningHere')}>
          {running.map((operation) => (
            <RunningHereRow
              machineName={props.machineName}
              key={operation.snapshot.operationId}
              operation={operation}
              testID={`${testID}.running:${operation.snapshot.operationId}`}
            />
          ))}
        </ItemGroup>
      ) : null}

      {/* Running work and fresh copies are records to browse: flat on the page (DESIGN "browse flat"). */}
      <ItemGroup
        surface="none"
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
        {[...freshCopies.notices.values()].filter(notice => (notice.filesUnknown || notice.filesPresent)
          && !freshCopies.copies?.some(copy => copy.relationship.relationshipId === notice.relationshipId)).map(notice => (
          <AttentionBanner
            key={notice.relationshipId}
            testID={`${testID}.copies.notice:${notice.relationshipId}`}
            tone="warning"
            title={freshCopies.copies === null ? notice.text : t('projectWorkers.copyDefinitionRetired')}
            description={freshCopies.copies === null ? undefined : notice.text}
            points={[[{ code: notice.targetRootPath }]]}
            action={{
              label: t('projectWorkers.checkAgain'),
              testID: `${testID}.copies.checkAgain:${notice.relationshipId}`,
              onPress: freshCopies.refresh,
            }}
            onDismiss={() => freshCopies.dismissNotice(notice.relationshipId)}
          />
        ))}
        {freshCopies.loading ? (
          <SurfaceStateCard
            testID={`${testID}.copies.loading`}
            size="line"
            kind="loading"
            title={t('common.loading')}
          />
        ) : freshCopies.copies === null ? (
          // A settled unknown census is not evidence that there are no copies.
          <SurfaceStateCard
            testID={`${testID}.copies.unavailable`}
            size="line"
            kind="unavailable"
            title={t('projectWorkers.freshCopiesUnavailable')}
            action={{ label: t('projectWorkers.checkAgain'), onPress: freshCopies.refresh }}
          />
        ) : freshCopies.copies.length === 0 ? (
          <SurfaceStateCard
            testID={`${testID}.copies.empty`}
            size="line"
            kind="empty"
            title={t('projectWorkers.freshCopiesEmpty')}
          />
        ) : (
          freshCopies.copies.map((copy) => (
            <FreshCopyRow
              key={copy.relationship.relationshipId}
              testID={`${testID}.copy:${copy.relationship.relationshipId}`}
              serverId={props.serverId}
              machineName={props.machineName}
              copy={copy}
              compact={compact}
              busy={freshCopies.busy}
              approvalId={freshCopies.approvalId}
              notice={freshCopies.notices.get(copy.relationship.relationshipId) ?? null}
              onRemove={(choice) => void freshCopies.remove(copy, choice)}
              onRefresh={freshCopies.refresh}
            />
          ))
        )}
      </ItemGroup>
    </>
  );
}
