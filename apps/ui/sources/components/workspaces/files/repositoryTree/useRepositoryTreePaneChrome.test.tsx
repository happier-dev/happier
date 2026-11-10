import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { PaneHeaderLine } from '@/components/appShell/panes/paneHeaderSlot';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) =>
      params?.count !== undefined ? `${key}:${String(params.count)}` : key,
  }),
);

const { useRepositoryTreePaneChrome } =
  await import('./useRepositoryTreePaneChrome');

function snapshot(isRepo: boolean): ScmWorkingSnapshot {
  // A clean checkout, in the shape the Git backend reports (as `createWritableScmSnapshot`).
  return {
    projectKey: 'machine-1:/repo', fetchedAt: 1, stashCount: 0, hasConflicts: false,
    repo: { isRepo, rootPath: '/repo', backendId: 'git' },
    branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    entries: [],
  } as ScmWorkingSnapshot;
}

function readLine(
  scmSnapshot: ScmWorkingSnapshot | null,
): Promise<PaneHeaderLine | null> {
  let line: PaneHeaderLine | null = null;
  function Probe() {
    line = useRepositoryTreePaneChrome({
      rootPath: '/repo',
      machineName: 'Mac',
      scmSnapshot,
    }).paneHeaderLine;
    return null;
  }
  return renderScreen(<Probe />).then(async (screen) => {
    await screen.unmount?.();
    return line;
  });
}

describe('useRepositoryTreePaneChrome', () => {
  it("holds the changed fact's room while the checkout is unknown, then states it in place", async () => {
    const pending = await readLine(null);
    expect(pending?.segments).toHaveLength(2);
    expect(pending?.segments[1]).toMatchObject({ pending: true });

    const known = await readLine(snapshot(true));
    expect(known?.segments).toHaveLength(2);
    expect(known?.segments[1]).not.toMatchObject({ pending: true });
  });

  it('names no change fact for a folder that is not a repository', async () => {
    const line = await readLine(snapshot(false));
    expect(line?.segments).toHaveLength(1);
  });
});
