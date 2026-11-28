// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ariaOwnedChildViolations } from '@/dev/testkit/harness/ariaOwnership';
import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import type { FilesystemBrowserNode } from './filesystemBrowserTypes';
import { Pressable, Text, View } from 'react-native';
import { FilesystemBrowserList } from './FilesystemBrowserList';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const nodes = [
  {
    path: 'src',
    name: 'src',
    type: 'directory',
    depth: 0,
    isExpanded: false,
    isLoadingChildren: false,
  },
  {
    path: 'README.md',
    name: 'README.md',
    type: 'file',
    depth: 0,
    isExpanded: false,
    isLoadingChildren: false,
  },
] satisfies FilesystemBrowserNode[];

/**
 * Cut 58 axe (Project overview, Code widget): the file tree owned its commit strip (`aria-busy` while pending), its
 * pending listing and its "Open in Code" link. A tree owns only its items; the page's slots stand beside them.
 */
describe('the file tree on the web', () => {
  const harness = createWebListDomHarness({
    rowSelector: '[role="treeitem"]',
    rowHeight: 38,
  });

  const renderList = async (
    props: Readonly<{
      presentation?: 'inline';
      nodes: readonly FilesystemBrowserNode[];
    }>,
  ) => {
    await act(async () =>
      harness.root.render(
        <div
          id="virtualized-list-host"
          style={{ display: 'flex', flexDirection: 'column', height: 400 }}
        >
          <FilesystemBrowserList
            treeRole
            {...(props.presentation
              ? { presentation: props.presentation }
              : {})}
            nodes={props.nodes}
            rootLoading={false}
            rootError={null}
            loadingLabel="Loading"
            inlineRetryLabel="Retry"
            retryRoot={() => {}}
            listHeader={<View testID="strip-pending" aria-busy />}
            listEmpty={<View testID="listing-pending" aria-busy />}
            listFooter={
              <Pressable testID="footer-open" role="link" onPress={() => {}}>
                <Text>Open in Code</Text>
              </Pressable>
            }
            renderRow={({ node }) => (
              <div
                role="treeitem"
                aria-level={1}
                data-testid={`row-${node.path}`}
              >
                {node.name}
              </div>
            )}
          />
        </div>,
      ),
    );
    await harness.flush();
  };

  it.each([undefined, 'inline'] as const)(
    'owns only its rows, never the strip, the pending listing or the footer (%s)',
    async (presentation) => {
      await renderList({ presentation, nodes });
      const trees = harness.container.querySelectorAll('[role="tree"]');
      expect(trees).toHaveLength(1);
      expect(trees[0]!.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
      expect(
        ariaOwnedChildViolations(trees[0]!, ['treeitem', 'group']),
      ).toEqual([]);
      // The slots are still drawn, beside the rows.
      for (const testID of ['strip-pending', 'footer-open']) {
        expect(
          harness.container.querySelector(`[data-testid="${testID}"]`),
        ).not.toBeNull();
      }
    },
  );

  it.each([undefined, 'inline'] as const)(
    'leaves a first listing that has not answered outside any tree (%s)',
    async (presentation) => {
      await renderList({ presentation, nodes: [] });
      expect(
        harness.container.querySelector('[data-testid="listing-pending"]'),
      ).not.toBeNull();
      for (const tree of harness.container.querySelectorAll('[role="tree"]')) {
        expect(ariaOwnedChildViolations(tree, ['treeitem', 'group'])).toEqual(
          [],
        );
      }
    },
  );
});
