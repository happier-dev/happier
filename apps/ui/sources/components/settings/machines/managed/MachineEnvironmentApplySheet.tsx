import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
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

function MachineEnvironmentApplySheet(
  props: ApplySheetProps & CustomModalInjectedProps,
) {
  const { theme } = useUnistyles();
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
            subtitle={describeMachineEnvironment(preset.environment)
              .map((fact) => fact.value)
              .join(' · ')}
            icon={
              <Icon
                name="stack"
                size={20}
                color={theme.colors.text.secondary}
              />
            }
            disabled={pending !== null || approval.approvalPending}
            showChevron={false}
            rightElement={
              pending === preset.id ? (
                <ActivitySpinner size="small" />
              ) : undefined
            }
            onPress={() => {
              void apply(preset);
            }}
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
