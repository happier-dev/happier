import type { DeploymentBackupRetentionV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

export const deploymentBackupKeepFields = ['last', 'daily', 'weekly', 'monthly'] as const;
export type DeploymentBackupKeepField = typeof deploymentBackupKeepFields[number];
export const deploymentBackupKeepLabels: Readonly<Record<DeploymentBackupKeepField, 'keepLast' | 'keepDaily' | 'keepWeekly' | 'keepMonthly'>> = {
  last: 'keepLast', daily: 'keepDaily', weekly: 'keepWeekly', monthly: 'keepMonthly',
};
export function deploymentBackupRetentionDraftFrom(retention: DeploymentBackupRetentionV1): Record<DeploymentBackupKeepField, string> {
  const count = (field: DeploymentBackupKeepField) => retention.kind === 'keep' && retention[field] !== undefined ? String(retention[field]) : '';
  return { last: count('last'), daily: count('daily'), weekly: count('weekly'), monthly: count('monthly') };
}

/** Empty or 0 everywhere keeps every backup; any other entry must be a whole number. */
export function retentionFromDraft(draft: Readonly<Record<DeploymentBackupKeepField, string>>): DeploymentBackupRetentionV1 | null {
  const counts: Partial<Record<DeploymentBackupKeepField, number>> = {};
  for (const field of deploymentBackupKeepFields) {
    const text = draft[field].trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return null;
    if (value > 0) counts[field] = value;
  }
  return Object.keys(counts).length === 0 ? { kind: 'keepEverything' } : { kind: 'keep', ...counts };
}
