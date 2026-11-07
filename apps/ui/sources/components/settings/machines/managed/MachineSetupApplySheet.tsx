import * as React from 'react';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { HappierPageSectionContext } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { homeDomainFailureCode, homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

import { describeMachineSetup } from './MachineSetupSection';
import { describeMachineSetupAllOffline, MachineSetupPlanReview, MachineSetupReviewFooter, type MachineSetupPreparedReview } from './MachineSetupPlanReview';
import { useMachinePresets } from './useMachinePresets';
import { prepareMachineSetupPresetApplyInput } from './machineSetupApply';

const execute = createFrontDoorActionExecute();

type ApplySheetProps = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
}>;

/** "Set up from a preset…" on any Machine (D53): the one apply Action, Ask first, then its live output. */
export function showMachineSetupApplySheet(props: ApplySheetProps) {
  Modal.show({ component: MachineSetupApplySheet, props });
}

export function MachineSetupApplySheet(
  props: ApplySheetProps & CustomModalInjectedProps,
) {
  const router = useRouter();
  const { setChrome, onClose } = props;
  React.useEffect(() => {
    // The same card chrome as the machine's other sheets (Share): its title, the machine it acts on, and a close.
    setChrome?.({
      kind: 'card',
      title: t('machinePresets.setup.applyTitle'),
      subtitle: props.machineName,
      phonePresentation: 'sheet',
    });
  }, [setChrome, props.machineName]);
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const { presetsByServerId, statesByServerId, refresh } =
    useMachinePresets(serverIds);
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const homeId = getServerProfileById(props.serverId)?.serverIdentityId ?? null;
  const [pending, setPending] = React.useState<string | null>(null);
  // Choosing a preset only shows what it sets up; the one primary button first reviews its plan, then runs it.
  const [chosenId, setChosenId] = React.useState<string | null>(null);
  const [prepared, setPrepared] = React.useState<MachineSetupPreparedReview | null>(null);
  const machines = useMachineListForServer(props.serverId);
  const nameOf = React.useCallback((machineId: string) => machineId === props.machineId ? props.machineName
    : getMachineDisplayName(machines?.find(machine => machine.id === machineId)) ?? t('common.unknown'),
  [machines, props.machineId, props.machineName]);
  // One failure line; it names what failed, so a refused review isn't told as a setup that couldn't start.
  const [error, setErrorState] = React.useState<Readonly<{ code: string; during: 'review' | 'apply'; message?: string }> | null>(null);
  const setError = (code: string | null, during: 'review' | 'apply' = 'apply') =>
    setErrorState(code === null ? null : { code, during });
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([
      props.serverId,
      binding?.accountId,
      props.machineId,
    ]),
    serverId: props.serverId,
    onExecuted: () => {},
  });
  const state = statesByServerId[props.serverId];
  // Only presets that set something up can be applied; archived ones make no new setups.
  const presets = (presetsByServerId[props.serverId] ?? []).filter(
    (preset) => preset.setup && preset.archivedAt === undefined,
  );
  // A single preset is the obvious choice; several wait for the person to pick one.
  const chosen = presets.find((preset) => preset.id === chosenId) ?? (presets.length === 1 ? presets[0] : undefined);
  const busy = pending !== null || approval.approvalPending;
  const opened = (result: unknown) => {
    const output =
      ManagedMachineActionOutputSchemasV1[
        'machines.setup.apply'
      ].safeParse(result);
    if (!output.success) {
      setError('managed_response_invalid');
      setPending(null);
      return;
    }
    onClose();
    openActionOperationDetail({
      serverId: props.serverId,
      operationId: output.data.operationId,
    });
  };
  // Review: the exact effects Plan for this Machine, read before anything can run. Choosing another host or which
  // left-out items to remove reads a fresh Plan with that choice; Apply carries only what that Plan returned.
  const review = async (preset: ManagedMachinePresetV1, selectedMachineId?: string, removeItemKeys?: string[]) => {
    if (!binding?.isCurrent() || !homeId || pending) return;
    setPending(preset.id);
    setError(null);
    try {
      const context = { surface: 'ui' as const, serverId: props.serverId, expectedAccountId: binding.accountId };
      const next = await prepareMachineSetupPresetApplyInput({ executeAction: execute, context,
        homeId, machineId: props.machineId, preset, isCurrent: () => binding.isCurrent(),
        ...(selectedMachineId === undefined ? {} : { selectedMachineId }),
        ...(removeItemKeys === undefined || removeItemKeys.length === 0 ? {} : { removeItemKeys }) });
      if (!binding.isCurrent()) return;
      if (next.ok) setPrepared(next);
      else {
        // An offline Machine is a typed fact, said by name, not a review that couldn't be checked.
        const offline = describeMachineSetupAllOffline(next, nameOf);
        setErrorState({ code: homeDomainFailureCode(homeDomainFailureFromActionFailure(next)), during: 'review',
          ...(offline ? { message: offline } : {}) });
      }
      setPending(null);
    } catch {
      if (binding.isCurrent()) {
        setError('managed_request_failed', 'review');
        setPending(null);
      }
    }
  };
  // A run that fails or is declined goes back to its review: the next try reads the Plan again.
  const settleFailed = (code: string) => {
    setError(code);
    setPrepared(null);
    setPending(null);
  };
  const apply = async (preset: ManagedMachinePresetV1, reviewed: MachineSetupPreparedReview) => {
    if (!binding?.isCurrent() || !homeId || pending) return;
    setPending(preset.id);
    setError(null);
    try {
      const context = { surface: 'ui' as const, serverId: props.serverId, expectedAccountId: binding.accountId };
      const input = reviewed.input;
      const outcome = classifyHomeActionOutcome(
        await execute.confirmed('machines.setup.apply', input, context),
      );
      if (!binding.isCurrent()) return;
      if (outcome.kind === 'failed') {
        settleFailed(homeDomainFailureCode(outcome.failure));
        return;
      }
      if (outcome.kind === 'approval_pending') {
        approval.requestApproval(
          createActionApprovalContinuation({
            artifactId: outcome.artifactId,
            actionId: 'machines.setup.apply',
            scope: binding.scope,
            expectedInput: input,
            onSucceeded: opened,
            onFailed: settleFailed,
          }),
        );
        return;
      }
      opened(outcome.result);
    } catch {
      if (binding.isCurrent()) {
        setError('managed_request_failed');
        setPending(null);
      }
    }
  };
  return (
    <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
      {approval.approvalId ? (
        <AttentionBanner
          testID="machine-setup-apply.approval"
          tone="neutral"
          title={t('approvals.title')}
          description={t('approvals.status.open')}
          action={{
            label: t('approvals.details'),
            onPress: () => {
              onClose();
              router.push(
                `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never,
              );
            },
          }}
        />
      ) : null}
      {presets.length === 0 ? (
        // Nothing to apply: one flat state line on the sheet (no card against its edges) and no
        // consequence sentence for a run that cannot happen yet.
        <SheetStateLine>
          <SurfaceStateCard
            testID="machine-setup-apply.state"
            size="line"
            kind={state?.loading ? 'loading' : state?.error ? 'error' : 'empty'}
            title={
              state?.loading
                ? t('machinePresets.loading')
                : state?.error
                  ? t('machinePresets.loadFailed')
                  : t('machinePresets.setup.applyEmpty')
            }
            // Nothing to apply yet leads to where a preset is made, instead of a sentence with no way there.
            action={
              state?.error
                ? { label: t('common.retry'), onPress: refresh }
                : state?.loading
                  ? undefined
                  : {
                      label: t('machinePresets.newPreset'),
                      onPress: () => {
                        onClose();
                        router.push(`/settings/machines/presets/new?serverId=${encodeURIComponent(props.serverId)}` as never);
                      },
                    }
            }
          />
        </SheetStateLine>
      ) : (
        <ItemGroup
          description={t('machinePresets.setup.applyDescription', {
            machine: props.machineName,
          })}
        >
          {presets.map((preset) => (
            <Item
              key={preset.id}
              testID={`machine-setup-apply.preset:${preset.id}`}
              title={preset.name}
              // Labelled facts; the chosen preset opens them one per line, so its row says what will run.
              subtitle={describeMachineSetup(preset.setup)
                .map((fact) => t('machinePresets.setup.fact', { label: fact.label, value: fact.value }))
                .join(chosen?.id === preset.id ? '\n' : ' · ')}
              subtitleLines={chosen?.id === preset.id ? 0 : undefined}
              selected={chosen?.id === preset.id}
              disabled={busy}
              showChevron={false}
              onPress={() => {
                if (chosen?.id === preset.id) return;
                setChosenId(preset.id);
                setPrepared(null);
              }}
            />
          ))}
        </ItemGroup>
      )}
      {chosen && prepared ? (
        <MachineSetupPlanReview
          testID="machine-setup-apply.review"
          prepared={prepared}
          nameOf={nameOf}
          disabled={busy}
          onChangeHost={(machineId) => { void review(chosen, machineId, prepared.input.targets[0]?.removeItemKeys); }}
          onChangeRemoval={(_machineId, removeItemKeys) => {
            void review(chosen, prepared.review?.machineId ?? undefined, removeItemKeys);
          }}
        />
      ) : null}
      {/* A failure sits above the closing row, which stays last. */}
      {error ? (
        <SheetStateLine>
          <SurfaceStateCard
            testID="machine-setup-apply.error"
            kind="error"
            size="line"
            title={error.message ?? t(error.during === 'review' ? 'machinePresets.setup.review.planFailed' : 'machinePresets.setup.applyFailed', {
              machine: props.machineName,
            })}
            diagnosticCode={error.code}
          />
        </SheetStateLine>
      ) : null}
      {presets.length > 0 ? (
        <ItemGroup surface="none">
          {/* The same closing row as every setup review: who approves, Cancel, then Review changes or Set up. */}
          <BareSectionContent>
          <MachineSetupReviewFooter
            onCancel={onClose}
            cancelTestID="machine-setup-apply.cancel"
            primary={chosen && prepared ? {
              testID: 'machine-setup-apply.run',
              label: t('machinePresets.setup.applyRun', { machine: props.machineName }),
              loading: pending !== null, disabled: busy,
              onPress: () => { void apply(chosen, prepared); },
            } : {
              testID: 'machine-setup-apply.reviewRun',
              label: t('machinePresets.setup.review.reviewRun'),
              loading: pending !== null, disabled: !chosen || busy,
              onPress: () => { if (chosen) void review(chosen); },
            }}
          />
          </BareSectionContent>
        </ItemGroup>
      ) : null}
    </ItemList>
  );
}

/**
 * A state line on the sheet stands on the page row edge, where the card chrome's title and the
 * rows' text start, instead of the collection column's wider text inset.
 */
function SheetStateLine(props: Readonly<{ children: React.ReactNode }>) {
  const { theme } = useUnistyles();
  const section = React.useMemo(() => ({
    rowDividerColor: theme.colors.border.subtle,
    rowInsetPx: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
  }), [theme]);
  return <HappierPageSectionContext.Provider value={section}>{props.children}</HappierPageSectionContext.Provider>;
}
