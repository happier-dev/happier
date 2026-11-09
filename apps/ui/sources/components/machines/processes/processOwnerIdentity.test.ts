import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { t } from '@/text';
import type { OwnerRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { processRow } from './testkit/processesAnswerFixture';
import { describeEndedOwner, describeOwnerFallbackTitle, useProcessOwnerTitles } from './processOwnerIdentity';

function terminalOwner(members: OwnerRowV1['members']): OwnerRowV1 {
  return {
    rowId: 'terminal:t1',
    state: 'running',
    owner: { kind: 'terminal', terminalId: 't1' },
    totals: { memoryBytes: 0, cpuPercent: 0, processCount: members.length },
    members,
  };
}

describe('describeOwnerFallbackTitle', () => {
  it('names a native container by its admitted Compose service, not a fabricated requester', () => {
    expect(describeOwnerFallbackTitle({ ...terminalOwner([]), owner: { kind: 'container', serverId: 'home', machineId: 'machine',
      serviceId: 'production/web', containerId: 'a'.repeat(64), composeProject: 'production', composeService: 'web', environmentId: 'environment' } }))
      .toBe('Service · web');
  });
  it('names a terminal by its shell, and a terminal whose shell is not reported plainly', () => {
    expect(describeOwnerFallbackTitle(terminalOwner([processRow('shell', 'terminal:t1', { name: 'zsh' })])))
      .toBe('Terminal · zsh');
    // No dangling separator ("Terminal · ") when the census carries no root process name.
    expect(describeOwnerFallbackTitle(terminalOwner([]))).toBe('Terminal');
  });
});

describe('describeEndedOwner', () => {
  it('names a left-behind owner by what it was, not always as a session', () => {
    expect(describeEndedOwner({ kind: 'session', sessionId: 's1' })).toBe('A session that ended');
    expect(describeEndedOwner({ kind: 'terminal', terminalId: 't1' })).toBe('A terminal that closed');
    expect(describeEndedOwner({ kind: 'service', serviceId: 'web' })).toBe('A service that stopped');
    expect(describeEndedOwner({ kind: 'run', runId: 'r1' })).toBe('A run that ended');
    expect(describeEndedOwner({ kind: 'browser_sidecar' })).toBe('A browser sidecar that closed');
    expect(describeEndedOwner({ kind: 'workspace_sync' })).toBe('A workspace sync that stopped');
    expect(describeEndedOwner({ kind: 'happier' })).toBe('A Happier helper that stopped');
  });
});


describe('process owner recording privacy', () => {
  it('conceals an incidental Session title while keeping its owner row and restores it after sharing', async () => {
    const previous = storage.getState();
    const serverId = 'process-privacy-home';
    const row = createSessionListRenderableSessionFixture({ id: 'private-process', metadata: {
      name: 'Private process project', path: '/private-process', host: 'host', machineId: 'machine',
    } });
    storage.setState({ sessionListRowsByServerId: { [serverId]: { [row.id]: row } } });
    storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
    storage.getState().setSessionTagAssignmentsOptimistic(serverId, row.id, ['private']);
    const owners: OwnerRowV1[] = [{ ...terminalOwner([]), rowId: 'session:private-process',
      owner: { kind: 'session', sessionId: row.id } }];
    const hook = await renderHook(() => useProcessOwnerTitles(owners, serverId));
    try {
      expect(hook.getCurrent().get(owners[0]!.rowId)).toBe('Private process project');
      await act(async () => { setScreenSharingPrivacyActive(true); });
      expect(hook.getCurrent().get(owners[0]!.rowId)).toBe(t('machineProcesses.owners.session'));
      await act(async () => { setScreenSharingPrivacyActive(false); });
      expect(hook.getCurrent().get(owners[0]!.rowId)).toBe('Private process project');
    } finally {
      setScreenSharingPrivacyActive(false);
      await hook.unmount();
      storage.setState(previous, true);
    }
  });
});
