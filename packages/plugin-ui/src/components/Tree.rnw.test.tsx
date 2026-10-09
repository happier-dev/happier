import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Tree, type TreeItem } from './Tree.js';

/**
 * The public Tree draws an author's own visible projection with the shared tree row (plan 70 §5): disclosure
 * and activation are separate intents, and the keyboard is the shared tree interaction owner.
 */
const items: readonly TreeItem[] = [
  {
    key: 'docs',
    parentKey: null,
    depth: 0,
    kind: 'branch',
    expanded: true,
    title: 'docs',
  },
  {
    key: 'docs/guide',
    parentKey: 'docs',
    depth: 1,
    kind: 'leaf',
    expanded: false,
    title: 'guide.md',
    meta: '2 days',
  },
  {
    key: 'src',
    parentKey: null,
    depth: 0,
    kind: 'branch',
    expanded: false,
    title: 'src',
  },
];

function mount(
  treeItems: readonly TreeItem[] = items,
  wrapRow?: React.ComponentProps<typeof Tree>['wrapRow'],
) {
  const context = createSurfaceContext();
  const hostApi = createHostApiStub(context);
  const expanded: Array<[string, boolean]> = [];
  const activated: string[] = [];
  const view = mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={hostApi} context={context}>
      <Tree
        items={treeItems}
        accessibilityLabel="Files"
        onExpandedChange={(key, next) => {
          expanded.push([key, next]);
        }}
        onActivate={(key) => {
          activated.push(key);
        }}
        expandLabel={(item) => `Expand ${item.title}`}
        collapseLabel={(item) => `Collapse ${item.title}`}
        testID="files"
        wrapRow={wrapRow}
      />
    </PluginUiProvider>,
  );
  const row = (key: string) =>
    view.container.querySelector<HTMLElement>(
      `[data-testid="files:row:${key}"]`,
    )!;
  return { view, row, expanded, activated };
}

describe('Tree', () => {
  it('draws each row once inside the host an author surrounds it with, keeping the tree item semantics', async () => {
    const { view, row, activated } = mount(items, (item, element) => (
      <div data-host={item.key}>{element}</div>
    ));
    const hosts = [...view.container.querySelectorAll<HTMLElement>('[data-host]')];
    expect(hosts.map((host) => host.dataset.host)).toEqual(
      items.map((item) => item.key),
    );
    expect(hosts[1]?.contains(row('docs/guide'))).toBe(true);
    expect(view.container.querySelectorAll('[role="treeitem"]')).toHaveLength(
      items.length,
    );
    await act(async () => {
      row('docs/guide').click();
    });
    expect(activated).toEqual(['docs/guide']);
    view.unmount();
  });

  it('keeps a disabled branch from disclosing through its nested control', async () => {
    const { view, row, expanded, activated } = mount(
      items.map((item) => ({ ...item, disabled: true })),
    );
    const chevron = view.container.querySelector<HTMLElement>(
      '[data-testid="files:disclosure:src"]',
    )!;
    await act(async () => {
      chevron.click();
      row('src').click();
      row('src').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(expanded).toEqual([]);
    expect(activated).toEqual([]);
    expect(chevron.getAttribute('aria-disabled')).toBe('true');
    view.unmount();
  });

  it('names a tree of tree items with their level and branch state', () => {
    const { view, row } = mount();
    const tree = view.container.querySelector('[role="tree"]');
    expect(tree?.getAttribute('aria-label')).toBe('Files');
    expect(row('docs').getAttribute('role')).toBe('treeitem');
    expect(row('docs').getAttribute('aria-level')).toBe('1');
    expect(row('docs').getAttribute('aria-expanded')).toBe('true');
    expect(row('docs/guide').getAttribute('aria-level')).toBe('2');
    expect(row('docs/guide').hasAttribute('aria-expanded')).toBe(false);
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    // One roving tab stop.
    expect([
      ...view.container.querySelectorAll('[role="treeitem"][tabindex="0"]'),
    ]).toEqual([row('docs')]);
    view.unmount();
  });

  it('keeps disclosure separate from activation', async () => {
    const { view, row, expanded, activated } = mount();
    const chevron = view.container.querySelector<HTMLElement>(
      '[data-testid="files:disclosure:src"]',
    )!;
    expect(chevron.getAttribute('aria-label')).toBe('Expand src');
    await act(async () => {
      chevron.click();
    });
    expect(expanded).toEqual([['src', true]]);
    expect(activated).toEqual([]);
    await act(async () => {
      row('docs/guide').click();
    });
    expect(activated).toEqual(['docs/guide']);
    expect(expanded).toEqual([['src', true]]);
    view.unmount();
  });

  it('discloses with the arrow keys through the shared tree keyboard', async () => {
    const { view, row, expanded, activated } = mount();
    await act(async () => {
      row('src').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(expanded).toEqual([['src', true]]);
    await act(async () => {
      row('docs').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    expect(expanded).toEqual([
      ['src', true],
      ['docs', false],
    ]);
    await act(async () => {
      row('docs/guide').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(activated).toEqual(['docs/guide']);
    view.unmount();
  });
});
