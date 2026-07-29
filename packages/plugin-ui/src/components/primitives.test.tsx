import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
  Action,
  List,
  Panel,
  State,
  Text,
} from './index.js';

describe('portable primitives', () => {
  it('render as package-owned marker elements without host app imports', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(
        <Panel titleKey="review.title">
          <State resource={{ status: 'ready', value: { statusKey: 'review.ready' } }}>
            {(summary) => (
              <Action action={{ kind: 'hostAction', id: 'reviews.refresh' }}>
                <Text valueKey={String(summary.statusKey)} />
              </Action>
            )}
          </State>
          <List items={[{ id: 'a', labelKey: 'review.item' }]} renderItem={(item) => (
            <Text valueKey={item.labelKey} />
          )} />
        </Panel>,
      );
    });

    const json = tree?.toJSON();
    expect(json).toMatchObject({
      type: 'happier-plugin-panel',
      props: {
        primitive: 'Panel',
        titleKey: 'review.title',
      },
    });
    expect(JSON.stringify(json)).toContain('"primitive":"Action"');
    expect(JSON.stringify(json)).toContain('"action":{"kind":"hostAction","id":"reviews.refresh"}');
    expect(JSON.stringify(json)).toContain('"primitive":"List"');
  });
});
