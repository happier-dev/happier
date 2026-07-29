import { describe, expect, it } from 'vitest';

import { Panel, Text } from '../components/index.js';
import { renderPluginUi } from './render.js';

describe('plugin UI test render helper', () => {
  it('renders package primitives for plugin-author assertions without app testkit imports', () => {
    const tree = renderPluginUi(
      <Panel titleKey="review.title">
        <Text valueKey="review.status" />
      </Panel>,
    );

    expect(tree.toJSON()).toMatchObject({
      type: 'happier-plugin-panel',
      props: {
        primitive: 'Panel',
        titleKey: 'review.title',
      },
    });
  });
});
