import type { MachineSecurityInspectResultV1 } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';
import { MACHINE_SETUP_PLAN_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MACHINE_REBOOT_ACTION_IDS } from '@happier-dev/protocol/machines/rebootActionIdsV1';

type Projection = MachineSecurityInspectResultV1;
type Row = Projection['rows'][number];
type Observation = Readonly<{ row: Row; family: string; minimum: number; maximum: number }>;

function band(penalty: number) {
  switch (penalty) {
    case 0: return 'A';
    case 1: return 'B';
    case 2: return 'C';
    case 3: return 'D';
    default: return 'F';
  }
}

function grade(observations: readonly Observation[]): Projection['grade'] {
  const families = new Map<string, { minimum: number; maximum: number }>();
  for (const { row, family, minimum, maximum } of observations) {
    if (row.state === 'inapplicable') continue;
    const prior = families.get(family);
    families.set(family, {
      minimum: Math.max(minimum, prior?.minimum ?? 0),
      maximum: Math.max(maximum, prior?.maximum ?? 0),
    });
  }
  if (!families.size) return { kind: 'no_applicable_evidence' };
  let minimum = 0;
  let maximum = 0;
  for (const bounds of families.values()) {
    minimum += bounds.minimum;
    maximum += bounds.maximum;
  }
  const lowerBand = band(minimum);
  const upperBand = band(maximum);
  return lowerBand === upperBand ? { kind: 'graded', band: lowerBand } : { kind: 'incomplete', lowerBand, upperBand };
}

function unread(check: Row['check'], family: string, maximum: number, reason: NonNullable<Row['reason']>): Observation {
  return { row: { check, state: 'unread', reason }, family, minimum: 0, maximum };
}

export function projectMachineSecurity(params: Readonly<{
  machineId: string;
  canManage: boolean;
  updates: Projection['updates'];
}>): Projection {
  const { updates, machineId, canManage } = params;
  const target = { machineId };
  const reason = updates.reason ?? 'required_fact_unavailable';
  const fresh = updates.status === 'satisfied' || updates.status === 'drifted';
  const pendingAll = fresh ? updates.pendingAll : undefined;
  const pendingSecurity = fresh ? updates.pendingSecurity : undefined;
  const rebootNeeded = fresh ? updates.rebootNeeded : undefined;
  const packageCounts = {
    ...(pendingAll === undefined ? {} : { pendingAll }),
    ...(pendingSecurity === undefined ? {} : { pendingSecurity }),
  };
  const maintenance = (check: Row['check'], minimum: number, maximum: number, evidence: Row['evidence'],
    repair?: Row['repair']): Observation => ({
    family: check, minimum, maximum,
    row: { check, state: minimum > 0 ? 'fail' : maximum > 0 ? 'unread' : 'pass', evidence,
      ...(minimum === 0 && maximum > 0 ? { reason } : {}), ...(repair && canManage ? { repair } : {}) },
  });
  let update: Observation;
  if (pendingSecurity !== undefined && pendingSecurity > 0) {
    update = maintenance('osUpdates', 2, 2, packageCounts, {
      actionId: MACHINE_SETUP_PLAN_ACTION_ID_V1, target, inputHints: { scope: 'security' },
    });
  } else if (pendingAll === undefined) {
    update = unread('osUpdates', 'osUpdates', pendingSecurity === 0 ? 1 : 2, reason);
  } else if (pendingAll > 0) {
    update = maintenance('osUpdates', 1, pendingSecurity === undefined ? 2 : 1, packageCounts, {
      actionId: MACHINE_SETUP_PLAN_ACTION_ID_V1, target, inputHints: { scope: 'all' },
    });
  } else {
    update = maintenance('osUpdates', 0, 0, packageCounts);
  }
  const reboot = rebootNeeded === undefined ? unread('rebootRequired', 'rebootRequired', 1, reason)
    : maintenance('rebootRequired', Number(rebootNeeded), Number(rebootNeeded), { rebootNeeded },
      rebootNeeded ? { actionId: MACHINE_REBOOT_ACTION_IDS[0], target } : undefined);
  // U4 replaces these gaps with the local owners' settled observations.
  // A deferred control's applicability is still unknown on the enrolled Machine.
  const observations = [
    unread('sshRootCredential', 'ssh', 4, 'required_fact_unavailable'),
    unread('sshPassword', 'ssh', 2, 'required_fact_unavailable'),
    unread('privateExposure', 'privateExposure', 4, 'required_fact_unavailable'),
    unread('firewall', 'firewall', 2, 'required_fact_unavailable'),
    unread('isolation', 'isolation', 2, 'required_fact_unavailable'),
    update, reboot,
  ];
  return { updates, grade: grade(observations), rows: observations.map(({ row }) => row) };
}
