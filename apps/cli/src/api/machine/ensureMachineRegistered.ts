import { randomUUID } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import { isMachineIdConflictError } from '@/api/api';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import { updateSettings } from '@/persistence';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

async function rotateMachineIdForActiveServer(opts: Readonly<{ expectedCurrentMachineId: string }>): Promise<string> {
  // Extremely defensive: UUID collisions are practically impossible, but avoid a no-op rotation.
  let nextMachineId = randomUUID();
  if (nextMachineId === opts.expectedCurrentMachineId) nextMachineId = randomUUID();

  const updated = await updateSettings((settings) => {
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
      'cloud',
    );

    const nextByServerId = { ...(settings.machineIdByServerId ?? {}) };
    const current = nextByServerId[activeServerId];
    // If another process already rotated the machine id, do not rotate again.
    if (typeof current === 'string' && current.trim() && current !== opts.expectedCurrentMachineId) {
      return settings;
    }
    nextByServerId[activeServerId] = nextMachineId;

    const nextConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
    if (activeServerId in nextConfirmed) delete nextConfirmed[activeServerId];

    return {
      ...settings,
      machineIdByServerId: nextByServerId,
      machineIdConfirmedByServerByServerId: nextConfirmed,
      // derived (not persisted in v5+)
      machineId: nextMachineId,
    };
  });

  return updated.machineId ?? nextMachineId;
}

export async function ensureMachineRegistered(opts: Readonly<{
  api: Pick<ApiClient, 'getOrCreateMachine'>;
  machineId: string;
  metadata: MachineMetadata;
  daemonState?: DaemonState;
  caller?: string;
}>): Promise<{
  machine: Machine;
  machineId: string;
  didRotateMachineId: boolean;
}> {
  try {
    const machine = await opts.api.getOrCreateMachine({
      machineId: opts.machineId,
      metadata: opts.metadata,
      daemonState: opts.daemonState,
    });
    return { machine, machineId: opts.machineId, didRotateMachineId: false };
  } catch (error) {
    if (!isMachineIdConflictError(error)) {
      throw error;
    }

    const caller = opts.caller ? ` (${opts.caller})` : '';
    // Retry exactly once: if a second conflict happens, bubble it up rather than looping indefinitely.
    logger.info(
      `[MACHINE] [RECOVERED] Machine id conflict${caller}: ${opts.machineId} is registered to another account on this server; generating a new machine id and retrying once.`,
    );

    const rotated = await rotateMachineIdForActiveServer({ expectedCurrentMachineId: opts.machineId });

    const machine = await opts.api.getOrCreateMachine({
      machineId: rotated,
      metadata: opts.metadata,
      daemonState: opts.daemonState,
    });

    logger.info(`[MACHINE] [RECOVERED] Machine id rotated${caller}: ${opts.machineId} -> ${rotated}`);

    return { machine, machineId: rotated, didRotateMachineId: true };
  }
}
