import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({ useServerScopedMachine: () => null }));

describe('terminal-less Project command output', () => {
  it.each(['projectCommand', 'machineEnvironment'] as const)('shows canonical terminal-less $0 review, uncertainty and settled states', async (kind) => {
    const { ProjectCommandOutputPane } = await import('./ProjectCommandOutputPane');
    const base: ActionOperationProjection = {
      serverId: 'home', observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'op', revision: 1, actionId: 'projects.prepare', state: 'accepted',
        scope: { accountId: 'account', machineId: 'machine' }, title: 'Setup', createdAt: 1, cancellation: 'supported',
        domainRef: kind === 'machineEnvironment' ? { kind, serverId: 'home', machineId: 'machine', preset: { id: 'preset', revision: 4 } }
            : { kind, purpose: 'setup', serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo' } },
    };
    for (const snapshot of [
      { ...base.snapshot, state: 'failed' as const, settledAt: 2 },
      { ...base.snapshot, state: 'cancelled' as const, settledAt: 2 },
      { ...base.snapshot, state: 'succeeded' as const, settledAt: 2 },
      { ...base.snapshot, setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const, reviewedEffectDigest: 'effect', reviewedEffect: {} } },
      { ...base.snapshot, observation: { kind: 'outcome_uncertain' as const, code: 'lost' } },
    ]) {
      const screen = await renderScreen(<ProjectCommandOutputPane operation={{ ...base, snapshot }} title="Setup" />);
      expect(screen.findByTestId('project-command-output.pending')).toBeNull();
      expect(screen.findByTestId('project-command-output.status')).not.toBeNull();
      await screen.unmount();
    }
    const accepted = await renderScreen(<ProjectCommandOutputPane operation={base} title="Setup" />);
    expect(accepted.findByTestId('project-command-output.pending')).not.toBeNull();
  });
});
