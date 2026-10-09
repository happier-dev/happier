import * as React from 'react';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { describeMachineEnvironment } from './MachineEnvironmentSection';
import { useMachinePresets } from './useMachinePresets';

const execute = createFrontDoorActionExecute();

type ApplySheetProps = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
}>;

/** "Set up from a preset…" on any Machine (D53): the one apply Action, Ask first, then its live output. */
export function showMachineEnvironmentApplySheet(props: ApplySheetProps) {
  Modal.show({ component: MachineEnvironmentApplySheet, props });
}

export function MachineEnvironmentApplySheet(
  props: ApplySheetProps & CustomModalInjectedProps,
) {
  const router = useRouter();
  const { setChrome, onClose } = props;
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      header: 'none',
      title: t('machinePresets.environment.applyTitle'),
      phonePresentation: 'sheet',
    });
  }, [setChrome]);
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const { presetsByServerId, statesByServerId, refresh } =
    useMachinePresets(serverIds);
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const homeId = getServerProfileById(props.serverId)?.serverIdentityId ?? null;
  const [pending, setPending] = React.useState<string | null>(null);
  // Choosing a preset only shows what it sets up; the one primary button runs it.
  const [chosenId, setChosenId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
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
    (preset) => preset.environment && preset.archivedAt === undefined,
  );
  // A single preset is the obvious choice; several wait for the person to pick one.
  const chosen = presets.find((preset) => preset.id === chosenId) ?? (presets.length === 1 ? presets[0] : undefined);
  const busy = pending !== null || approval.approvalPending;
  const opened = (result: unknown) => {
    const output =
      ManagedMachineActionOutputSchemasV1[
        'machines.environment.apply'
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
  const apply = async (preset: ManagedMachinePresetV1) => {
    if (!binding?.isCurrent() || !homeId || pending) return;
    const input = {
      homeId,
      machineId: props.machineId,
      presetId: preset.id,
      presetRevision: preset.revision,
    };
    setPending(preset.id);
    setError(null);
    try {
      const outcome = classifyHomeActionOutcome(
        await execute('machines.environment.apply', input, {
          surface: 'ui',
          serverId: props.serverId,
          expectedAccountId: binding.accountId,
        }),
      );
      if (!binding.isCurrent()) return;
      if (outcome.kind === 'failed') {
        setError(homeDomainFailureCode(outcome.failure));
        setPending(null);
        return;
      }
      if (outcome.kind === 'approval_pending') {
        approval.requestApproval(
          createActionApprovalContinuation({
            artifactId: outcome.artifactId,
            actionId: 'machines.environment.apply',
            scope: binding.scope,
            expectedInput: input,
            onSucceeded: opened,
            onFailed: (code) => {
              setError(code);
              setPending(null);
            },
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
          testID="machine-environment-apply.approval"
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
      <ItemGroup
        title={t('machinePresets.environment.applyTitle')}
        description={t('machinePresets.environment.applyDescription', {
          machine: props.machineName,
        })}
      >
        {presets.map((preset) => (
          <Item
            key={preset.id}
            testID={`machine-environment-apply.preset:${preset.id}`}
            title={preset.name}
            // Labelled facts; the chosen preset opens them one per line, so its row says what will run.
            subtitle={describeMachineEnvironment(preset.environment)
              .map((fact) => t('machinePresets.environment.fact', { label: fact.label, value: fact.value }))
              .join(chosen?.id === preset.id ? '\n' : ' · ')}
            subtitleLines={chosen?.id === preset.id ? 0 : undefined}
            selected={chosen?.id === preset.id}
            disabled={busy}
            showChevron={false}
            onPress={() => setChosenId(preset.id)}
          />
        ))}
        {presets.length === 0 ? (
          <SurfaceStateCard
            testID="machine-environment-apply.state"
            size="line"
            kind={state?.loading ? 'loading' : state?.error ? 'error' : 'empty'}
            title={
              state?.loading
                ? t('machinePresets.loading')
                : state?.error
                  ? t('machinePresets.loadFailed')
                  : t('machinePresets.environment.applyEmpty')
            }
            action={
              state?.error
                ? { label: t('common.retry'), onPress: refresh }
                : undefined
            }
          />
        ) : null}
      </ItemGroup>
      {presets.length > 0 ? (
        <ItemGroup surface="none">
          <SectionButtonRow>
            <RoundButton
              testID="machine-environment-apply.run"
              display="default"
              title={t('machinePresets.environment.applyRun', { machine: props.machineName })}
              loading={pending !== null}
              disabled={!chosen || busy}
              onPress={() => {
                if (chosen) void apply(chosen);
              }}
            />
          </SectionButtonRow>
        </ItemGroup>
      ) : null}
      {error ? (
        <SurfaceStateCard
          testID="machine-environment-apply.error"
          kind="error"
          size="line"
          title={t('machinePresets.environment.applyFailed', {
            machine: props.machineName,
          })}
          diagnosticCode={error}
        />
      ) : null}
    </ItemList>
  );
}
