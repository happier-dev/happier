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

/** The role an element exposes: its explicit role, else the implicit role of the few hosts a row can render. */
function roleOf(element: Element): string | null {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.split(' ')[0]!;
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return tag;
  return null;
}

/**
 * What axe's `aria-required-children` checks for a tree: the elements it owns (the nearest role-bearing
 * descendants, skipping generic and presentational wrappers) are `treeitem`s, or `group`s that own treeitems.
 */
function treeOwnershipViolations(tree: Element): string[] {
  const violations: string[] = [];
  const owned = (parent: Element): Element[] =>
    [...parent.children].flatMap((child) => {
      if (child.getAttribute('aria-hidden') === 'true') return [];
      const role = roleOf(child);
      return role === null || role === 'presentation' || role === 'none'
        ? owned(child)
        : [child];
    });
  const check = (parent: Element, allowed: ReadonlySet<string>) => {
    for (const child of owned(parent)) {
      const role = roleOf(child)!;
      if (!allowed.has(role))
        violations.push(
          `${role}: ${child.getAttribute('data-testid') ?? child.textContent?.slice(0, 24)}`,
        );
      if (role === 'group') check(child, new Set(['treeitem', 'group']));
    }
  };
  check(tree, new Set(['treeitem', 'group']));
  return violations;
}

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
    expect(treeOwnershipViolations(tree)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
