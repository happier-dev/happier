import { randomUUID } from 'node:crypto';
import type { MachineEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/enrollmentV1';

import type { ApiClient } from '@/api/api';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import { resolveRegisteredMachineId, updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
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

export async function rotateMachineIdForActiveServer(opts: Readonly<{
  expectedCurrentMachineId: string;
  recordReplacementCandidate?: boolean;
}>): Promise<string> {
  // Extremely defensive: UUID collisions are practically impossible, but avoid a no-op rotation.
  let nextMachineId = randomUUID();
  if (nextMachineId === opts.expectedCurrentMachineId) nextMachineId = randomUUID();

  const updated = await updateMachineRegistration(current => {
    if (current.machineId?.trim() && current.machineId !== opts.expectedCurrentMachineId) return current;
    const accountId = current.accountId?.trim();
    const replacementCandidates = { ...current.replacementCandidates };
    if (accountId) {
      if (opts.recordReplacementCandidate === false) {
        // A displaced installation must not retire the Machine now owned by its successor.
        delete replacementCandidates[accountId];
      } else {
        replacementCandidates[accountId] = {
          machineId: opts.expectedCurrentMachineId, replacementReason: 'rotation', createdAt: Date.now(),
        };
      }
    }
    return {
      ...current, machineId: nextMachineId, confirmedByServer: undefined, replacementCandidates,
      ...(accountId ? { machineIdByAccountId: { ...current.machineIdByAccountId, [accountId]: nextMachineId } } : {}),
    };
  });
  return resolveRegisteredMachineId(updated) ?? nextMachineId;
}

async function adoptReplacementMachineIdForActiveServer(opts: Readonly<{
  expectedCurrentMachineId: string;
  replacementMachineId: string;
}>): Promise<string> {
  const updated = await updateMachineRegistration(current => {
    if (current.machineId?.trim() && current.machineId !== opts.expectedCurrentMachineId) return current;
    const accountId = current.accountId?.trim();
    const replacementCandidates = { ...current.replacementCandidates };
    if (accountId && replacementCandidates[accountId]?.machineId === opts.expectedCurrentMachineId) delete replacementCandidates[accountId];
    return {
      ...current, machineId: opts.replacementMachineId, confirmedByServer: undefined, replacementCandidates,
      ...(accountId ? { machineIdByAccountId: { ...current.machineIdByAccountId, [accountId]: opts.replacementMachineId } } : {}),
    };
  });
  return resolveRegisteredMachineId(updated) ?? opts.replacementMachineId;
}

async function markMachineIdConfirmedForActiveServer(machineId: string): Promise<void> {
  await updateMachineRegistration(current => current.machineId?.trim() === machineId && current.confirmedByServer !== true
    ? { ...current, confirmedByServer: true } : current);
}

export async function ensureMachineRegistered(opts: Readonly<{
  api: Pick<ApiClient, 'getOrCreateMachine'>;
  machineId: string;
  metadata: MachineMetadata;
  daemonState?: DaemonState;
  timeoutMs?: number;
  caller?: string;
  managedEnrollment?: MachineEnrollmentCorrelationV1;
  recoveryLogger?: RecoveryLogger;
  isShuttingDown?: () => boolean;
}>): Promise<{
  machine: Machine;
  machineId: string;
  didRotateMachineId: boolean;
}> {
  const completed = async (
    machine: Machine,
    machineId: string,
    didRotateMachineId: boolean,
  ) => {
    await markMachineIdConfirmedForActiveServer(machineId);
    return { machine, machineId, didRotateMachineId };
  };

  throwIfMachineRegistrationIsQuiescing(opts.isShuttingDown);
  try {
    const machine = await opts.api.getOrCreateMachine({
      machineId: opts.machineId,
      metadata: opts.metadata,
      daemonState: opts.daemonState,
      timeoutMs: opts.timeoutMs,
      ...(opts.managedEnrollment ? { managedEnrollment: opts.managedEnrollment } : {}),
    });
    return await completed(machine, opts.machineId, false);
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
        ...(opts.managedEnrollment ? { managedEnrollment: opts.managedEnrollment } : {}),
      });

      return await completed(machine, replacementMachineId, true);
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

    const rotated = await rotateMachineIdForActiveServer({ expectedCurrentMachineId: opts.machineId,
      recordReplacementCandidate: !isMachineRevokedError(error) });

    throwIfMachineRegistrationIsQuiescing(opts.isShuttingDown);
    const machine = await opts.api.getOrCreateMachine({
      machineId: rotated,
      metadata: opts.metadata,
      daemonState: opts.daemonState,
      timeoutMs: opts.timeoutMs,
      ...(opts.managedEnrollment ? { managedEnrollment: opts.managedEnrollment } : {}),
    });

    recoveryLogger.info(`[MACHINE] [RECOVERED] Machine id rotated${caller}: ${opts.machineId} -> ${rotated}`);

    return await completed(machine, rotated, true);
  }
}
