/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', async () =>
  vi.importActual<typeof import('react-native-web')>('react-native-web'),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

import { ProjectsTree } from './ProjectsTree';
import { buildProjectsTreeRows } from './projectsTreeRows';
import { ariaOwnedChildViolations } from '@/dev/testkit/harness/ariaOwnership';

it('lets the Projects tree own only treeitems and groups (axe aria-required-children)', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const rows = buildProjectsTreeRows({
    projects: [
      {
        key: 'project',
        name: 'Project',
        checkouts: [
          {
            refId: 'main',
            machineId: 'machine',
            machineName: 'Machine',
            label: 'main',
            path: '/repo',
            attention: 'needs-you',
          },
          {
            refId: 'feature',
            machineId: 'machine',
            machineName: 'Machine',
            label: 'feature',
            path: '/repo-feature',
            attention: null,
          },
        ],
      },
    ],
    openRefId: 'main',
    expandedKeys: new Set(['project']),
  });
  try {
    await act(async () =>
      root.render(
        <ProjectsTree
          rows={[...rows]}
          onToggle={() => {}}
          onOpenRef={() => {}}
          renderRowMenu={() => (
            <button type="button" aria-label="More">
              ⋯
            </button>
          )}
          saved={{
            items: [{ key: 'saved', title: 'Saved source' }],
            onOpen: () => {},
          }}
          hidden={{
            items: [
              { key: 'hidden', title: 'Hidden project', subtitle: '~/hidden' },
            ],
            open: true,
            onToggle: () => {},
            onShow: () => {},
          }}
        />,
      ),
    );
    const tree = container.querySelector('[role="tree"]')!;
    expect(tree).not.toBeNull();
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(
      2,
    );
    expect(ariaOwnedChildViolations(tree, ['treeitem', 'group'])).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
