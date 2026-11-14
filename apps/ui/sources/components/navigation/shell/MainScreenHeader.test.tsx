import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const { MainScreenHeader } =
  await import('./MainScreenHeader');

describe('MainScreenHeader', () => {
  it("states the page's count line from the owner's counts, one line under the head", async () => {
    const screen = await renderScreen(
      <MainScreenHeader
        testID="machines"
        title="Machines"
        count={['12 Machines', null, '3 online', '']}
      />,
    );
    expect(screen.findByTestId('machines:count')).not.toBeNull();
    expect(screen.getTextContent()).toContain('12 Machines · 3 online');
    await screen.update(
      <MainScreenHeader testID="machines" title="Machines" count={[null]} />,
    );
    expect(screen.findByTestId('machines:count')).toBeNull();
    await screen.unmount();
  });
});
