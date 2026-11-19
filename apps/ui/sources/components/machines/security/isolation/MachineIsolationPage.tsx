import * as React from 'react';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import { MachineIsolationMutationResultV1Schema } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readMachineProvisionerAgentNativeSandboxSupportV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { useManagedProvisioners } from '@/components/settings/machines/managed/useManagedProvisioners';
import {
  MANAGED_PROVISIONER_MARK_SIZE,
  ManagedPresetMark,
} from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { useMachineIsolationPolicy } from '@/hooks/machine/useMachineIsolationPolicy';
import { Modal } from '@/modal';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { t } from '@/text';

import {
  withMachineIsolationLifecycle,
  withMachineIsolationSandbox,
  withMachineIsolationWorkTarget,
  withoutMachineIsolationSandbox,
  type MachineIsolationLifecycle,
  type MachineIsolationWorkKind,
} from './machineIsolationChoices';
import {
  MachineIsolationPageView,
  type MachineIsolationEntryRow,
  type MachineIsolationFailure,
  type MachineIsolationPageViewProps,
} from './MachineIsolationPageView';
import { useMachineIsolationPresets } from './useMachineIsolationSummary';
import { describeMachineIsolationAvailability } from './MachineIsolationAvailability';
import { MachineIsolationAddSandboxModal, type MachineIsolationAddedSandbox } from './MachineIsolationAddSandboxModal';
import { randomUUID } from '@/platform/randomUUID';
import { useHostMachineSandboxes } from '@/components/settings/machines/managed/useHostMachineSandboxes';
import { projectManagedPresetAllocationCounts } from '@/components/settings/machines/managed/hostMachineSandboxes';


type SaveFailure = Readonly<
  | { kind: 'failed'; policy: MachineIsolationPolicyV1; code?: string; message?: string }
  | { kind: 'conflict' }
>;
type ViewBase = Omit<MachineIsolationPageViewProps, 'entries' | 'checkFailure'>;

/**
 * Machine → Security → Isolation. The policy is the synced Machine metadata read by `useMachineIsolationPolicy`, so it
 * stays visible offline; every change is one `machines.isolation.set` with the complete policy. Choosing never creates
 * a sandbox: they are created when work starts.
 */
export function MachineIsolationPage(
  props: Readonly<{
    serverId: string;
    machine: Machine;
    machineName: string;
    online: boolean | null;
    /** Another door asked to add a sandbox for this kind of work: the add flow opens once, then the intent clears. */
    addFor?: MachineIsolationWorkKind;
    onAddHandled?: () => void;
  }>,
) {
  const { serverId, machine, machineName } = props;
  const isolation = useMachineIsolationPolicy({ serverId, machine });
  const { policy, savePolicy, targetKey } = isolation;
  const latestPolicy = React.useRef(policy);
  latestPolicy.current = policy;
  const latestTarget = React.useRef(targetKey);
  latestTarget.current = targetKey;
  const [failedSave, setFailedSave] = React.useState<Readonly<{ targetKey: string; failure: SaveFailure }> | null>(null);
  const failure = failedSave?.targetKey === targetKey ? failedSave.failure : null;
  const controller = React.useMemo<ManagedControllerV1 | undefined>(
    () =>
      machine.installationId
        ? { machineId: machine.id, installationId: machine.installationId }
        : undefined,
    [machine.id, machine.installationId],
  );
  const { readOnlyReason, offline } = describeMachineIsolationAvailability(machine, props.online);

  const save = React.useCallback(
    async (next: MachineIsolationPolicyV1) => {
      if (latestTarget.current !== targetKey) return;
      setFailedSave(null);
      const showFailure = (failure: SaveFailure) => {
        if (latestTarget.current === targetKey) setFailedSave({ targetKey, failure });
      };
      try {
        const result = await savePolicy(next);
        if (!result) return;
        const parsed = result.ok
          ? MachineIsolationMutationResultV1Schema.safeParse(result.result)
          : null;
        const status = parsed?.success ? parsed.data.status : null;
        if (
          status === 'applied' ||
          status === 'satisfied' ||
          status === 'unchanged' ||
          status === 'cancelled'
        )
          return;
        if (status === 'conflict') {
          showFailure({ kind: 'conflict' });
          return;
        }
        if (!result.ok && result.errorCode === 'action_account_scope_changed')
          return;
        showFailure({
          kind: 'failed',
          policy: next,
          code: result.ok ? (status ?? 'invalid_result') : result.errorCode,
          message: result.ok
            ? undefined
            : resolveActionExecutionErrorMessage(result, t('machineDetailPage.isolation.saveFailed')),
        });
      } catch {
        showFailure({ kind: 'failed', policy: next, code: 'unavailable' });
      }
    },
    [savePolicy, targetKey],
  );
  const onChooseTarget = React.useCallback(
    (kind: MachineIsolationWorkKind, id: string | null) => {
      if (latestPolicy.current)
        void save(
          withMachineIsolationWorkTarget(latestPolicy.current, kind, id),
        );
    },
    [save],
  );
  const onChooseLifecycle = React.useCallback(
    (kind: MachineIsolationWorkKind, lifecycle: MachineIsolationLifecycle) => {
      if (latestPolicy.current)
        void save(
          withMachineIsolationLifecycle(latestPolicy.current, kind, lifecycle),
        );
    },
    [save],
  );
  const onToggleNative = React.useCallback(
    (on: boolean) => {
      if (latestPolicy.current)
        void save({ ...latestPolicy.current, agentNativeSandboxEnabled: on });
    },
    [save],
  );
  const onRemove = React.useCallback(
    (entry: MachineIsolationEntryRow) => {
      void Modal.confirm(
        t('machineDetailPage.isolation.sandboxes.removeTitle', {
          name: entry.name,
        }),
        t('machineDetailPage.isolation.sandboxes.removeBody'),
        {
          confirmText: t('machineDetailPage.isolation.sandboxes.remove'),
          destructive: true,
        },
      ).then((confirmed) => {
        if (confirmed && latestPolicy.current)
          void save(
            withoutMachineIsolationSandbox(latestPolicy.current, entry.id),
          );
      });
    },
    [save],
  );
  const canAdd = readOnlyReason === null && isolation.snapshot.status === 'ready';
  const openAdd = React.useCallback((useFor?: MachineIsolationWorkKind) => {
    Modal.show({ component: MachineIsolationAddSandboxModal, props: { serverId, controller, machineName,
      ...(useFor ? { useFor } : {}),
      onAdded: (entry: MachineIsolationAddedSandbox) => {
        if (latestPolicy.current) void save(withMachineIsolationSandbox(latestPolicy.current, { ...entry, ...(useFor ? { useFor } : {}) }, randomUUID).policy);
      } } });
  }, [serverId, controller, machineName, save]);
  const onAdd = React.useCallback(() => openAdd(), [openAdd]);
  const { addFor, onAddHandled } = props;
  React.useEffect(() => {
    if (!addFor || !canAdd) return;
    onAddHandled?.();
    openAdd(addFor);
  }, [addFor, canAdd, onAddHandled, openAdd]);
  const onRetryRead = React.useCallback(() => {
    void getSyncSingleton()
      .refreshMachines({ serverId })
      .catch(() => {});
  }, [serverId]);

  const saveFailure: MachineIsolationFailure | null =
    failure?.kind === 'conflict'
      ? { title: t('machineDetailPage.isolation.changed') }
      : failure
        ? {
            title: failure.message ?? t('machineDetailPage.isolation.saveFailed'),
            code: failure.code,
            onRetry: () => {
              void save(failure.policy);
            },
          }
        : null;
  const view: ViewBase = {
    machineName,
    status: isolation.snapshot.status,
    policy,
    readOnlyReason,
    offline,
    busy: isolation.saving,
    saveFailure,
    onRetryRead,
    onChooseTarget,
    onChooseLifecycle,
    onToggleNative,
    onRemove,
    // A manager sees the add row even offline (disabled there, like every control on the page).
    ...(isolation.snapshot.status === 'ready' && canManageMachine(machine) ? { onAdd } : {}),
  };
  // Presets and sandbox type declarations are read only once a sandbox is configured.
  return policy && Object.keys(policy.configuredSandboxes).length > 0 ? (
    <MachineIsolationConfiguredPage
      {...view}
      policy={policy}
      serverId={serverId}
      controller={controller}
    />
  ) : (
    <MachineIsolationPageView
      {...view}
      entries={NO_ENTRIES}
      checkFailure={null}
    />
  );
}

const NO_ENTRIES: readonly MachineIsolationEntryRow[] = Object.freeze([]);

function MachineIsolationConfiguredPage(
  props: ViewBase &
    Readonly<{
      policy: MachineIsolationPolicyV1;
      serverId: string;
      controller: ManagedControllerV1 | undefined;
    }>,
) {
  const { policy, serverId, controller, ...view } = props;
  const presets = useMachineIsolationPresets(serverId, policy);
  // Running (MACH-PRESETS-DATA-1119): this host's live sandboxes per preset, from the existing managed inventory;
  // nothing is said while that read hasn't settled or a sandbox's power is unknown.
  const host = useHostMachineSandboxes({ serverId, controller });
  const hostSettled = host.entry?.status === 'ready';
  const running = React.useMemo(
    () => (hostSettled && controller ? projectManagedPresetAllocationCounts(host.sandboxes, controller) : null),
    [controller, host.sandboxes, hostSettled],
  );
  const catalog = useManagedProvisioners(serverId, undefined, controller);
  const accountScope = catalog.binding?.scope ?? null;
  const catalogSettled = !catalog.loading && !catalog.error;
  const entries = React.useMemo(
    () =>
      Object.entries(policy.configuredSandboxes).map(
        ([id, configured]): MachineIsolationEntryRow => {
          const preset = presets.byEntry.get(id) ?? null;
          const key = buildQualifiedPluginContributionKey(
            configured.provisioner,
          );
          const provisioner = catalog.provisioners.find(
            (candidate) =>
              buildQualifiedPluginContributionKey(candidate.contribution) ===
              key,
          );
          return {
            id,
            name:
              preset?.name ??
              t('machineDetailPage.isolation.sandboxes.presetUnavailable'),
            supportsAgentNativeSandbox:
              provisioner && preset?.launch
                ? readMachineProvisionerAgentNativeSandboxSupportV1(
                    provisioner.descriptor,
                    preset.launch.choices,
                  )
                : null,
            missingType: catalogSettled && !provisioner,
            ...(running && !running.get(configured.presetId)?.powerUnknown
              ? { running: running.get(configured.presetId)?.running ?? 0 } : {}),
            serverId,
            accountScope,
            ...(preset
              ? {
                  mark: (
                    <ManagedPresetMark
                      serverId={serverId}
                      accountScope={accountScope}
                      preset={preset}
                      size={MANAGED_PROVISIONER_MARK_SIZE.row}
                    />
                  ),
                  preset,
                }
              : {}),
          };
        },
      ),
    [
      policy.configuredSandboxes,
      policy.workKinds,
      presets.byEntry,
      catalog.provisioners,
      catalogSettled,
      running,
      serverId,
      accountScope,
    ],
  );
  const checkFailure: MachineIsolationFailure | null = catalog.error
    ? {
        title: t('machineDetailPage.isolation.sandboxes.checkFailed'),
        code: catalog.error,
        onRetry: catalog.refresh,
      }
    : null;
  return (
    <MachineIsolationPageView
      {...view}
      policy={policy}
      entries={entries}
      checkFailure={checkFailure}
    />
  );
}
