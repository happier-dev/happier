import { randomUUID } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import { updateSettings } from '@/persistence';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { isMachineIdConflictError, isMachineReplacedError, isMachineRevokedError } from './machineRegistrationErrors';

type RecoveryLogger = Readonly<{
  info: (message: string, ...args: ReadonlyArray<unknown>) => void;
}>;

function throwIfMachineRegistrationIsQuiescing(isShuttingDown: (() => boolean) | undefined): void {
  if (isShuttingDown?.() !== true) return;
  const error = new Error('Machine registration cancelled because the daemon is quiescing');
  error.name = 'MachineRegistrationQuiescingError';
  throw error;
}

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

    const normalizedTokenSub = typeof settings.lastTokenSubByServerId?.[activeServerId] === 'string'
      ? (settings.lastTokenSubByServerId?.[activeServerId] ?? '').trim()
      : '';

    const nextByServerIdByAccountId = (() => {
      if (!normalizedTokenSub) return settings.machineIdByServerIdByAccountId;

      const next = { ...(settings.machineIdByServerIdByAccountId ?? {}) };
      const nextForServer = { ...(next[activeServerId] ?? {}) };
      nextForServer[normalizedTokenSub] = nextMachineId;
      next[activeServerId] = nextForServer;
      return next;
    })();

    const normalizedAccountId = normalizedTokenSub || '';
    const nextReplacementCandidates = { ...(settings.machineReplacementCandidatesByServerIdByAccountId ?? {}) };
    if (normalizedAccountId) {
      const byAccount = { ...(nextReplacementCandidates[activeServerId] ?? {}) };
      byAccount[normalizedAccountId] = {
        machineId: opts.expectedCurrentMachineId,
        replacementReason: 'rotation',
        createdAt: Date.now(),
      };
      nextReplacementCandidates[activeServerId] = byAccount;
    }

    const nextConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
    if (activeServerId in nextConfirmed) delete nextConfirmed[activeServerId];

    return {
      ...settings,
      machineIdByServerId: nextByServerId,
      ...(nextByServerIdByAccountId ? { machineIdByServerIdByAccountId: nextByServerIdByAccountId } : {}),
      machineReplacementCandidatesByServerIdByAccountId: Object.keys(nextReplacementCandidates).length
        ? nextReplacementCandidates
        : {},
      machineIdConfirmedByServerByServerId: nextConfirmed,
      // derived (not persisted in v5+)
      machineId: nextMachineId,
    };
  });

  return updated.machineId ?? nextMachineId;
}

async function adoptReplacementMachineIdForActiveServer(opts: Readonly<{
  expectedCurrentMachineId: string;
  replacementMachineId: string;
}>): Promise<string> {
  const updated = await updateSettings((settings) => {
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
      'cloud',
    );

    const nextByServerId = { ...(settings.machineIdByServerId ?? {}) };
    const current = nextByServerId[activeServerId];
    if (typeof current === 'string' && current.trim() && current !== opts.expectedCurrentMachineId) {
      return settings;
    }
    nextByServerId[activeServerId] = opts.replacementMachineId;

    const normalizedTokenSub = typeof settings.lastTokenSubByServerId?.[activeServerId] === 'string'
      ? (settings.lastTokenSubByServerId?.[activeServerId] ?? '').trim()
      : '';

    const nextByServerIdByAccountId = (() => {
      if (!normalizedTokenSub) return settings.machineIdByServerIdByAccountId;
      const next = { ...(settings.machineIdByServerIdByAccountId ?? {}) };
      const nextForServer = { ...(next[activeServerId] ?? {}) };
      nextForServer[normalizedTokenSub] = opts.replacementMachineId;
      next[activeServerId] = nextForServer;
      return next;
    })();

    const nextReplacementCandidates = { ...(settings.machineReplacementCandidatesByServerIdByAccountId ?? {}) };
    if (normalizedTokenSub && nextReplacementCandidates[activeServerId]) {
      const byAccount = { ...(nextReplacementCandidates[activeServerId] ?? {}) };
      const candidate = byAccount[normalizedTokenSub];
      if (candidate?.machineId === opts.expectedCurrentMachineId) {
        delete byAccount[normalizedTokenSub];
      }
      if (Object.keys(byAccount).length > 0) {
        nextReplacementCandidates[activeServerId] = byAccount;
      } else {
        delete nextReplacementCandidates[activeServerId];
      }
    }

    const nextConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
    if (activeServerId in nextConfirmed) delete nextConfirmed[activeServerId];

    return {
      ...settings,
      machineIdByServerId: nextByServerId,
      ...(nextByServerIdByAccountId ? { machineIdByServerIdByAccountId: nextByServerIdByAccountId } : {}),
      machineReplacementCandidatesByServerIdByAccountId: nextReplacementCandidates,
      machineIdConfirmedByServerByServerId: nextConfirmed,
      machineId: opts.replacementMachineId,
    };
  });

  return updated.machineId ?? opts.replacementMachineId;
}

export async function ensureMachineRegistered(opts: Readonly<{
  api: Pick<ApiClient, 'getOrCreateMachine'>;
  machineId: string;
  metadata: MachineMetadata;
  daemonState?: DaemonState;
  timeoutMs?: number;
  caller?: string;
  recoveryLogger?: RecoveryLogger;
  isShuttingDown?: () => boolean;
}>): Promise<{
  machine: Machine;
  machineId: string;
  didRotateMachineId: boolean;
}> {
  throwIfMachineRegistrationIsQuiescing(opts.isShuttingDown);
  try {
    const machine = await opts.api.getOrCreateMachine({
      machineId: opts.machineId,
      metadata: opts.metadata,
      daemonState: opts.daemonState,
      timeoutMs: opts.timeoutMs,
    });
    return { machine, machineId: opts.machineId, didRotateMachineId: false };
  } catch (error) {
    throwIfMachineRegistrationIsQuiescing(opts.isShuttingDown);

    if (isMachineReplacedError(error)) {
      const caller = opts.caller ? ` (${opts.caller})` : '';
      const recoveryLogger = opts.recoveryLogger ?? logger;
      recoveryLogger.info(
        `[MACHINE] [RECOVERED] Machine identity replaced${caller}: adopting replacement machine id ${error.replacementMachineId}.`,
      );

      const replacementMachineId = await adoptReplacementMachineIdForActiveServer({
        expectedCurrentMachineId: opts.machineId,
        replacementMachineId: error.replacementMachineId,
      });

      throwIfMachineRegistrationIsQuiescing(opts.isShuttingDown);
      const machine = await opts.api.getOrCreateMachine({
        machineId: replacementMachineId,
        metadata: opts.metadata,
        daemonState: opts.daemonState,
        timeoutMs: opts.timeoutMs,
      });

      return { machine, machineId: replacementMachineId, didRotateMachineId: true };
    }

    if (!isMachineIdConflictError(error) && !isMachineRevokedError(error)) {
      throw error;
    }

    const caller = opts.caller ? ` (${opts.caller})` : '';
    const recoveryLogger = opts.recoveryLogger ?? logger;
    // Retry exactly once: if a second conflict happens, bubble it up rather than looping indefinitely.
    recoveryLogger.info(
      `[MACHINE] [RECOVERED] Machine identity invalid${caller}: ${opts.machineId} cannot be reused on this server; generating a new machine id and retrying once.`,
    );

    const rotated = await rotateMachineIdForActiveServer({ expectedCurrentMachineId: opts.machineId });

    throwIfMachineRegistrationIsQuiescing(opts.isShuttingDown);
    const machine = await opts.api.getOrCreateMachine({
      machineId: rotated,
      metadata: opts.metadata,
      daemonState: opts.daemonState,
      timeoutMs: opts.timeoutMs,
    });

    recoveryLogger.info(`[MACHINE] [RECOVERED] Machine id rotated${caller}: ${opts.machineId} -> ${rotated}`);

    return { machine, machineId: rotated, didRotateMachineId: true };
  }
}
