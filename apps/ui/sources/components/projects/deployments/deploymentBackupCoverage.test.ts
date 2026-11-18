import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { ProjectReadinessReadResultV1 } from '@happier-dev/protocol/projects/readinessV1';
import { planVisibleBackupReadiness, projectBackupCoverage } from './deploymentBackupCoverage';
const headers = Array.from({ length: 120 }, (_, index) => createDeploymentEnvironmentHeaderV1({ id: 'env-' + index,
  projectSourceId: index < 60 ? 'project-a' : 'project-b', controllerMachineId: 'machine-a' }));
describe('visible Environment backup coverage', () => {
 it('bounds demand before fan-out, batching visible Environments rather than apps or inventory', () => {
  const visible = [headers[0]!, headers[1]!, headers[80]!];
  expect(planVisibleBackupReadiness(visible, false)).toEqual([]);
  const requests = planVisibleBackupReadiness(visible, true);
  expect(requests).toHaveLength(2);
  expect(requests.flatMap(request => request.environments.map(item => item.environmentId))).toEqual(['env-0', 'env-1', 'env-80']);
  expect(requests.every(request => request.environments.every(item => item.expectedRevision === 1))).toBe(true);
 });
 it('uses backup facts alone, preserves unknowns and excludes explicit no-backup-needed', () => {
  const visible = headers.slice(0, 5); const input = planVisibleBackupReadiness(visible, true)[0]!;
  const result: ProjectReadinessReadResultV1 = { serverId: input.serverId, projectId: input.projectId, status: 'unavailable', facts: [
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-0', status: 'ready', reason: 'configured_sources_verified' },
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-1', status: 'actionNeeded', reason: 'no_verified_backup_yet' },
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-2', status: 'ready', reason: 'notNeeded' },
    { kind: 'health', owner: 'healthChecks', environmentId: 'env-3', status: 'ready', reason: 'healthy' },
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-4', status: 'unavailable', reason: 'machine_offline' },
  ] };
  const coverage = projectBackupCoverage(visible, [{ input, result, pending: false, failureCode: null }]);
  expect(coverage).toMatchObject({ covered: 1, uncovered: 1, notNeeded: 2, unresolved: 1, total: 3, status: 'partial' });
  expect(coverage.rows.map(row => row.status)).toEqual(['covered', 'uncovered', 'notNeeded', 'notNeeded', 'unavailable']);
  expect(coverage.rows[1]?.reason).toBe('no_verified_backup_yet');
  expect(projectBackupCoverage([{ ...visible[0]!, revision: 2 }], [{ input, result, pending: false, failureCode: null }]).rows[0]?.status).toBe('loading');
  expect(projectBackupCoverage(visible, [{ input, result, pending: false, failureCode: 'machine_offline' }]).status).toBe('partial');
 });
 it('carries when the last backup completed, from the recorded facts the readiness owner already reads (owner D4)', () => {
  const visible = headers.slice(0, 2); const input = planVisibleBackupReadiness(visible, true)[0]!;
  const result: ProjectReadinessReadResultV1 = { serverId: input.serverId, projectId: input.projectId, status: 'ready', facts: [
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-0', status: 'ready', reason: 'configured_sources_verified',
      backups: { lastSuccessfulBackup: { operationId: 'op-1', completedAt: 1_700_000_000_000, configRevision: 1, snapshotIds: ['snap-1'] } } },
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-1', status: 'actionNeeded', reason: 'no_verified_backup_yet' },
  ] };
  const coverage = projectBackupCoverage(visible, [{ input, result, pending: false, failureCode: null }]);
  expect(coverage.rows.map(row => row.lastBackupAt)).toEqual([1_700_000_000_000, null]);
 });
 it('never says "not backed up" about backups that exist but are not yet verified (PAGE-ACCEPT-176 D13)', () => {
  const visible = headers.slice(0, 2); const input = planVisibleBackupReadiness(visible, true)[0]!;
  const result: ProjectReadinessReadResultV1 = { serverId: input.serverId, projectId: input.projectId, status: 'ready', facts: [
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-0', status: 'actionNeeded', reason: 'backup_verification_required',
      backups: { lastSuccessfulBackup: { operationId: 'op-1', completedAt: 1_700_000_000_000, configRevision: 1, snapshotIds: ['snap-1'] } } },
    { kind: 'backups', owner: 'deploymentBackups', environmentId: 'env-1', status: 'actionNeeded', reason: 'no_verified_backup_yet' },
  ] };
  const coverage = projectBackupCoverage(visible, [{ input, result, pending: false, failureCode: null }]);
  expect(coverage.rows.map(row => row.status)).toEqual(['unverified', 'uncovered']);
  expect(coverage).toMatchObject({ uncovered: 1, unverified: 1 });
 });
 it('settles missing, failed and pending reads without claiming coverage or fetching', () => {
  const visible = headers.slice(0, 1); const input = planVisibleBackupReadiness(visible, true)[0]!;
  expect(projectBackupCoverage([], []).status).toBe('empty');
  expect(projectBackupCoverage(visible, []).status).toBe('loading');
  expect(projectBackupCoverage(visible, [{ input, result: null, pending: false, failureCode: 'machine_offline' }])).toMatchObject({ status: 'unavailable', unresolved: 1 });
  expect(projectBackupCoverage(visible, [{ input, result: null, pending: true, failureCode: null }]).status).toBe('loading');
 });
});
