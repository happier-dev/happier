import * as React from 'react';
import { Text } from 'react-native';
import { expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierItemGroupBehavior, useHappierItemGroupItemBehavior } from './ItemGroup.js';

it('does not redraw ordinary rows for a changed neighbor, but publishes a changed selection count', async () => {
  let renders = 0;
  const Row = React.memo(function Row() {
    renders++;
    const behavior = useHappierItemGroupItemBehavior({ role: 'button' });
    return <Text testID="count">{behavior.selectableItemCount}</Text>;
  });
  const tree = (neighbor: string, count = 2) => (
    <HappierItemGroupBehavior selectableItemCount={count} renderContent={(children) => children}>
      <Row key="retained" /><Text key="neighbor">{neighbor}</Text>
    </HappierItemGroupBehavior>
  );
  const mount = mountThroughReactNativeWeb(tree('Before'));
  try {
    const initial = renders;
    await mount.render(tree('After'));
    expect(mount.container.textContent).toContain('After');
    expect(renders).toBe(initial);
    await mount.render(tree('After', 3));
    expect(mount.container.querySelector('[data-testid="count"]')?.textContent).toBe('3');
    expect(renders).toBe(initial + 1);
  } finally {
    mount.unmount();
  }
});
