import type { MachineIsolationWorkKind } from '@/components/machines/security/isolation/machineIsolationChoices';
import {
  proposeMachineIsolationOutcome,
  readSyncedMachineIsolationPolicy,
  type MachineIsolationPolicySource,
} from '@/sync/domains/machines/machineIsolationPolicy';
import { t } from '@/text';

/** What new work does on one Machine, as its picker row says it. */
export type MachineRowIsolation =
  | Readonly<{ kind: 'directly' }>
  | Readonly<{ kind: 'fresh' | 'kept'; presetId: string }>;

const DIRECTLY: MachineRowIsolation = Object.freeze({ kind: 'directly' });

/**
 * The picker row's half of the outcome line (lab machine-sandboxes-1115 scene 2): the same synced policy read and
 * proposal the outcome line uses, reduced to what a row can say. A policy that can't be read yet, or names a
 * sandbox that isn't set up anymore, says nothing here; the outcome line explains it once the Machine is chosen.
 */
export function readMachineRowIsolation(
  machine: MachineIsolationPolicySource,
  workKind: MachineIsolationWorkKind,
): MachineRowIsolation | null {
  const snapshot = readSyncedMachineIsolationPolicy(machine);
  if (snapshot.status !== 'ready') return null;
  const outcome = proposeMachineIsolationOutcome(snapshot, workKind);
  // No stored policy: directly is the default and says so.
  if (!outcome) return DIRECTLY;
  if (outcome.status !== 'proposed') return null;
  if (outcome.choice.kind === 'directly') return DIRECTLY;
  const presetId = outcome.configuredSandbox?.presetId;
  if (!presetId) return null;
  return {
    kind: outcome.choice.lifecycle === 'fresh' ? 'fresh' : 'kept',
    presetId,
  };
}

/** "runs directly" or "new sessions run in a fresh Node 22 sandbox"; a preset not read yet takes the outcome line's stand-in. */
export function describeMachineRowIsolation(
  row: MachineRowIsolation,
  presetName: string | undefined,
): string {
  if (row.kind === 'directly')
    return t('machineDetailPage.isolation.outcome.rowDirectly');
  const name = presetName ?? t('machineDetailPage.isolation.summary.unnamed');
  return row.kind === 'fresh'
    ? t('machineDetailPage.isolation.outcome.rowFresh', { name })
    : t('machineDetailPage.isolation.outcome.rowKept', { name });
}
