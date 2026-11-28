import * as React from 'react';
import type { MachineSecurityInspectResultV1 } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';

import {
  MachineSecurityGradeSummary,
  type MachineSecurityGradeView,
} from '@/components/machines/security/grade/MachineSecurityGradeSummary';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { t } from '@/text';

export const MACHINE_SECURITY_GRADE_SPECIMEN_STATES = ['toFix', 'incomplete', 'clear', 'noEvidence', 'offline', 'reading', 'failed', 'guest'] as const;
export type MachineSecurityGradeSpecimenState = (typeof MACHINE_SECURITY_GRADE_SPECIMEN_STATES)[number];

const machine = 'hetzner-fsn1';
const updates = { status: 'drifted', pendingSecurity: 3, pendingAll: 11, rebootNeeded: false } as unknown as MachineSecurityInspectResultV1['updates'];
const repairUpdates = { actionId: 'machines.setup.plan', target: { machineId: machine }, inputHints: { scope: 'security' } } as const;

/** Projection fixtures in the daemon's own shape (`machines.security.inspect`); the summary decides nothing itself. */
const RESULTS = {
  toFix: { grade: { kind: 'graded', band: 'C' }, updates, rows: [
    { check: 'osUpdates', state: 'fail', evidence: { pendingSecurity: 3, pendingAll: 11 }, repair: repairUpdates },
    { check: 'rebootRequired', state: 'pass', evidence: { rebootNeeded: false } },
    { check: 'sshPassword', state: 'pass' },
    { check: 'firewall', state: 'pass' },
    { check: 'isolation', state: 'pass' },
  ] },
  incomplete: { grade: { kind: 'incomplete', lowerBand: 'C', upperBand: 'F' }, updates, rows: [
    { check: 'osUpdates', state: 'fail', evidence: { pendingSecurity: 3, pendingAll: 11 }, repair: repairUpdates },
    { check: 'rebootRequired', state: 'pass', evidence: { rebootNeeded: false } },
    { check: 'sshPassword', state: 'unread', reason: 'needs_admin_to_check' },
    { check: 'firewall', state: 'unread', reason: 'admin_access_unavailable' },
    { check: 'isolation', state: 'pass' },
  ] },
  clear: { grade: { kind: 'graded', band: 'A' }, updates, rows: [
    { check: 'osUpdates', state: 'pass', evidence: { pendingSecurity: 0, pendingAll: 0 } },
    { check: 'rebootRequired', state: 'pass', evidence: { rebootNeeded: false } },
    { check: 'sshPassword', state: 'pass' },
    { check: 'firewall', state: 'pass' },
    { check: 'isolation', state: 'pass' },
  ] },
  noEvidence: { grade: { kind: 'no_applicable_evidence' }, updates, rows: [
    { check: 'osUpdates', state: 'inapplicable' },
    { check: 'rebootRequired', state: 'inapplicable' },
  ] },
} satisfies Record<string, MachineSecurityInspectResultV1>;

function viewFor(state: MachineSecurityGradeSpecimenState): MachineSecurityGradeView {
  switch (state) {
    case 'offline': return { kind: 'offline' };
    case 'reading': return { kind: 'reading' };
    case 'failed': return { kind: 'failed', message: 'hetzner-fsn1 refused the read.', onRetry: () => undefined };
    case 'guest': return { kind: 'ready', result: RESULTS.toFix };
    default: return { kind: 'ready', result: RESULTS[state] };
  }
}

/** Machine → Security's grade summary in each state, on the production component. */
export function MachineSecurityGradeSpecimen(props: Readonly<{ state: MachineSecurityGradeSpecimenState }>) {
  return (
    <ItemList testID="machine-security-grade-specimen">
      <PageHeader title={machine} description={t('machineDetailPage.security.description', { machine })} />
      <MachineSecurityGradeSummary view={viewFor(props.state)} machineName={machine}
        fix={{ onFix: () => undefined, busy: false, canFix: props.state !== 'guest' }} />
    </ItemList>
  );
}
