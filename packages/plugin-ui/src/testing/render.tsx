import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';

export function renderPluginUi(element: ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(element);
  });

  if (!tree) {
    throw new Error('Plugin UI test renderer did not create a tree.');
  }

  return tree;
}
