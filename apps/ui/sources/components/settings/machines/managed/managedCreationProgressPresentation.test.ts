import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { t } from '@/text';
import { describeManagedCreationProgress } from './managedCreationProgressPresentation';

const operation: ActionOperationSnapshotV1 = {
  version: 1, operationId: 'spawn', revision: 1, actionId: 'session.spawn_new', state: 'running',
  scope: { accountId: 'account', machineId: 'controller' }, title: 'Start Session',
  createdAt: 1, cancellation: 'supported',
};
const operationAddress = { serverId: 'home', machineId: 'controller', operationId: operation.operationId };

describe('Session sandbox creation progress', () => {
  it('has no creation steps before Send admits an operation', () => {
    expect(describeManagedCreationProgress('Guest', { kind: 'idle' }).steps).toEqual([]);
  });

  it.each([false, true])('shows a continuation refusal after install completed (wrapped=%s)', (wrapped) => {
    const presentation = describeManagedCreationProgress('Guest', {
      kind: 'failed',
      code: wrapped ? 'action_failed' : 'credential_scope_denied',
      ...(wrapped ? { failureCause: { phase: 'machines.managed.get', errorClass: 'ManagedMachineControllerError',
        errorCode: 'credential_scope_denied', httpStatus: null } } : {}),
      operation: { ...operation, actionId: 'machines.managed.acquire', state: 'succeeded' },
    });
    expect(presentation).toMatchObject({
      failed: true,
      label: t('inbox.actionOperations.status.failed'),
      failureMessage: t('errors.permissionDenied'),
    });
  });

  it.each([
    ['machines.managed.acquire', ['running', 'upcoming', 'upcoming', 'upcoming']],
    ['ssh.installCli.upload', ['upcoming', 'running', 'upcoming', 'upcoming']],
    ['setup', ['upcoming', 'upcoming', 'running', 'upcoming']],
  ] as const)('projects actual %s progress into four ordered steps', (phase, states) => {
    const presentation = describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, progress: { kind: 'phase', phase, label: 'Current work' } } });
    expect(presentation.steps.map(step => step.id)).toEqual(['create', 'install', 'setup', 'ready']);
    expect(presentation.steps.map(step => step.state)).toEqual(states);
  });

  it('puts Copying project files before Setup, because setup needs the files (lab F6)', () => {
    const copying = describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, progress: { kind: 'phase', phase: 'project_files_copy', label: 'Copying project files' } } },
      { projectFiles: true });
    expect(copying.steps.map(step => step.id)).toEqual(['create', 'install', 'copy', 'setup', 'ready']);
    expect(copying.steps.map(step => step.state)).toEqual(['upcoming', 'upcoming', 'running', 'upcoming', 'upcoming']);
    // The step is reserved from the start for a Session that gets project files, so nothing moves when it begins.
    const creating = describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, progress: { kind: 'phase', phase: 'machines.managed.acquire', label: 'Creating' } } },
      { projectFiles: true });
    expect(creating.steps.map(step => step.id)).toEqual(['create', 'install', 'copy', 'setup', 'ready']);
    // A Session without a folder keeps the four steps.
    expect(describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, progress: { kind: 'phase', phase: 'setup', label: 'Setup' } } }).steps.map(step => step.id))
      .toEqual(['create', 'install', 'setup', 'ready']);
  });

  it('keeps Ready pending after acquisition success and completes only at Session success', () => {
    expect(describeManagedCreationProgress('Guest', { kind: 'acquiring',
      operation: { ...operation, actionId: 'machines.managed.acquire', state: 'succeeded' } }).steps).toEqual([]);
    expect(describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, state: 'succeeded' } }).steps.map(step => step.state)).toEqual(['upcoming', 'upcoming', 'upcoming', 'done']);
  });

  it('does not fabricate installation or Setup history for a no-Setup Session', () => {
    const presentation = describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, state: 'succeeded', progress: {
        kind: 'phase', phase: 'machines.managed.acquire', label: 'Creating',
      } } });
    expect(presentation.steps.map(step => step.state)).toEqual(['done', 'upcoming', 'upcoming', 'done']);
  });

  it.each(['failed', 'cancelled'] as const)('retains the unsuccessful setup stage when the Session is %s', state => {
    const presentation = describeManagedCreationProgress('Guest', { kind: 'session_starting', operationAddress,
      operation: { ...operation, state, progress: { kind: 'phase', phase: 'setup', label: 'Setup' } } });
    expect(presentation.steps.map(step => step.state)).toEqual(['upcoming', 'upcoming', 'failed', 'upcoming']);
    expect(presentation.failed).toBe(true);
  });
});
