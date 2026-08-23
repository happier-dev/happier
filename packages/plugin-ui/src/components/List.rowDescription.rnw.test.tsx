import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';

/**
 * React Native Web 0.21 has no `accessibilityHint` mapping at all: its
 * `createDOMProps` owner emits `aria-describedby` from an id reference and
 * silently drops the hint. A row description therefore has to reach the DOM
 * through a real described-by relationship, or a web reader hears nothing.
 */
function mountRows(children: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <List accessibilityLabel="Repositories">{children}</List>
    </PluginUiProvider>,
  );
}

function describedText(root: ParentNode, element: HTMLElement | null): string | null {
  const ids = element?.getAttribute('aria-describedby');
  if (!ids) return null;
  return ids
    .split(/\s+/u)
    .map((id) => root.querySelector<HTMLElement>(`#${id}`)?.textContent ?? '')
    .join(' ')
    .trim();
}

describe('plugin-ui List row description on React Native Web', () => {
  it('describes an actionable row through a real DOM description relationship', () => {
    const mount = mountRows(
      <List.Item
        testID="repository-row"
        title="happier"
        accessibilityHint="Opens the repository"
        onPress={() => undefined}
      />,
    );

    const control = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(control, 'the actionable row must render a real pressable').not.toBeNull();
    expect(describedText(mount.container, control)).toBe('Opens the repository');
    // The description never becomes the row's accessible name.
    expect(control?.getAttribute('aria-label')).toBeNull();
    mount.unmount();
  });

  it('describes a static row through the same author contract', () => {
    const mount = mountRows(
      <List.Item
        testID="static-row"
        title="happier"
        accessibilityHint="Archived last week"
      />,
    );

    const row = mount.container.querySelector<HTMLElement>('[role="listitem"]');
    expect(describedText(mount.container, row)).toBe('Archived last week');
    mount.unmount();
  });

  it('adds no description relationship when the author declared none', () => {
    const mount = mountRows(<List.Item testID="plain-row" title="happier" />);

    const row = mount.container.querySelector<HTMLElement>('[role="listitem"]');
    expect(row?.getAttribute('aria-describedby')).toBeNull();
    expect(mount.container.querySelector<HTMLElement>('[role="button"]')).toBeNull();
    mount.unmount();
  });
});
