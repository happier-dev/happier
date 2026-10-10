import * as React from 'react';

import {
  DEFAULT_MEMORY_SETTINGS,
  type MemorySettingsV1,
} from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';

import {
  fetchDaemonMemorySettings,
  writeDaemonMemorySettings,
} from '@/sync/domains/memory/fetchDaemonMemorySettings';
import { fetchDaemonMemoryStatus } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import type { ArchivedMemoryStatusRequestState } from '@/sync/domains/memory/resolveArchivedMemoryEligibilityControl';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
  useMachineAdministrationTargetSelection,
  type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';

/**
 * Whether the managed machine's memory settings can be shown and changed. Every memory setting
 * lives on the machine, so without a reachable, current daemon the page says why instead of
 * presenting defaults as the machine's settings.
 */
export type MachineMemorySettingsAccess =
  | 'noMachine'
  | 'pending'
  | 'ready'
  | 'updateRequired'
  | 'unreachable';

/** The outcome of the last settled settings read, for the machine it was read from. */
type SettledMachineRead = Readonly<{
  targetKey: string;
  access: 'ready' | 'updateRequired' | 'unreachable';
}>;

function resolveExecutionTargetKey(
  target: FreshMachineAdministrationExecutionTargetV1 | null,
): string | null {
  return target
    ? [
        target.target.serverIdentityId,
        target.target.machineId,
        target.serverId,
      ].join('\u0000')
    : null;
}

/**
 * The one reader and writer of a machine's `MemorySettingsV1` for settings pages (Memory, Search).
 * Both pages manage the same machine-local settings, so they share the machine choice as well.
 */
export function useMachineMemorySettings(
  options: Readonly<{ enabled: boolean }>,
) {
  const { enabled } = options;
  const administrationTargetSelection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory,
  );
  const executionTarget =
    administrationTargetSelection.resolveExecutionTarget();
  const executionTargetKey = resolveExecutionTargetKey(executionTarget);
  const hasExecutionTarget = executionTarget !== null;
  const isExecutionTargetCurrent = React.useCallback(
    (target: FreshMachineAdministrationExecutionTargetV1) => {
      return isMachineAdministrationExecutionTargetCurrent({
        expectedTarget: target,
        resolveCurrentTarget:
          administrationTargetSelection.resolveExecutionTarget,
      });
    },
    [administrationTargetSelection.resolveExecutionTarget],
  );

  const [settings, setSettings] = React.useState<MemorySettingsV1>(
    () => DEFAULT_MEMORY_SETTINGS,
  );
  // Settings are writable only after a read settled for the machine being managed. Until then the
  // page holds defaults (or another machine's values), and a write would post them over the machine.
  const [settledRead, setSettledRead] =
    React.useState<SettledMachineRead | null>(null);
  const settledReadRef = React.useRef<SettledMachineRead | null>(null);
  const settleRead = React.useCallback((next: SettledMachineRead | null) => {
    settledReadRef.current = next;
    setSettledRead(next);
  }, []);
  const [memoryStatus, setMemoryStatus] = React.useState<MemoryStatusV1 | null>(
    null,
  );
  const [memoryStatusRequestState, setMemoryStatusRequestState] =
    React.useState<ArchivedMemoryStatusRequestState>('unresolved');
  const [loading, setLoading] = React.useState(false);

  const refreshStatus = React.useCallback(
    async (target: FreshMachineAdministrationExecutionTargetV1) => {
      setMemoryStatusRequestState('loading');
      const statusResult = await fetchDaemonMemoryStatus({
        machineId: target.machine.id,
        serverId: target.serverId,
      })
        .then((status) => ({ status, requestState: 'resolved' as const }))
        .catch(() => ({ status: null, requestState: 'unreachable' as const }));
      if (!isExecutionTargetCurrent(target)) return;
      setMemoryStatus(statusResult.status);
      setMemoryStatusRequestState(statusResult.requestState);
    },
    [isExecutionTargetCurrent],
  );

  const fetchSettings = React.useCallback(async () => {
    if (!enabled) return;
    const target = administrationTargetSelection.resolveExecutionTarget();
    if (!target) return;
    setLoading(true);
    settleRead(null);
    setMemoryStatus(null);
    setMemoryStatusRequestState('loading');
    try {
      const [settingsResult, statusResult] = await Promise.all([
        fetchDaemonMemorySettings({
          machineId: target.machine.id,
          serverId: target.serverId,
        })
          .then((result) => ({ result, unreachable: false as const }))
          .catch(() => ({ result: null, unreachable: true as const })),
        fetchDaemonMemoryStatus({
          machineId: target.machine.id,
          serverId: target.serverId,
        })
          .then((status) => ({ status, requestState: 'resolved' as const }))
          .catch(() => ({
            status: null,
            requestState: 'unreachable' as const,
          })),
      ]);
      if (!isExecutionTargetCurrent(target)) return;
      const targetKey = resolveExecutionTargetKey(target)!;
      if (settingsResult.result) {
        setSettings(settingsResult.result.settings);
        settleRead({
          targetKey,
          access: settingsResult.result.supported ? 'ready' : 'updateRequired',
        });
      } else {
        settleRead({ targetKey, access: 'unreachable' });
      }
      setMemoryStatus(statusResult.status);
      setMemoryStatusRequestState(statusResult.requestState);
    } finally {
      if (isExecutionTargetCurrent(target)) setLoading(false);
    }
  }, [
    administrationTargetSelection.resolveExecutionTarget,
    enabled,
    isExecutionTargetCurrent,
    settleRead,
  ]);

  React.useEffect(() => {
    if (!enabled) return;
    if (!hasExecutionTarget) {
      setSettings(DEFAULT_MEMORY_SETTINGS);
      settleRead(null);
      setMemoryStatus(null);
      setMemoryStatusRequestState('unresolved');
      setLoading(false);
      return;
    }
    void fetchSettings();
  }, [
    enabled,
    executionTargetKey,
    fetchSettings,
    hasExecutionTarget,
    settleRead,
  ]);

  /** The managed machine, only once its settings were read from it and may be written back. */
  const resolveWritableTarget =
    React.useCallback((): FreshMachineAdministrationExecutionTargetV1 | null => {
      if (!enabled) return null;
      const target = administrationTargetSelection.resolveExecutionTarget();
      if (!target) return null;
      const read = settledReadRef.current;
      return read?.targetKey === resolveExecutionTargetKey(target) &&
        read.access === 'ready'
        ? target
        : null;
    }, [administrationTargetSelection.resolveExecutionTarget, enabled]);

  const writeSettings = React.useCallback(
    async (next: MemorySettingsV1) => {
      const target = resolveWritableTarget();
      if (!target) return;
      const result = await writeDaemonMemorySettings({
        machineId: target.machine.id,
        serverId: target.serverId,
        settings: next,
      });
      if (!isExecutionTargetCurrent(target)) return;
      setSettings(result.settings);
      if (!result.supported) {
        settleRead({
          targetKey: resolveExecutionTargetKey(target)!,
          access: 'updateRequired',
        });
        return;
      }
      await refreshStatus(target);
    },
    [
      isExecutionTargetCurrent,
      refreshStatus,
      resolveWritableTarget,
      settleRead,
    ],
  );

  const access: MachineMemorySettingsAccess = !hasExecutionTarget
    ? 'noMachine'
    : settledRead?.targetKey === executionTargetKey
      ? settledRead.access
      : 'pending';

  return {
    administrationTargetSelection,
    executionTarget,
    access,
    loading,
    settings,
    memoryStatus,
    memoryStatusRequestState,
    fetchSettings,
    writeSettings,
    resolveWritableTarget,
    refreshStatus,
  };
}
