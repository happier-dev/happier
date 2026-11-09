import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';
import { readHitAreaReach } from '../interaction/hitArea.testSupport.js';
import { HappierStateDetails } from './InfoState.js';

afterEach(() => vi.unstubAllGlobals());

describe('HappierStateDetails under a finger', () => {
  it('reaches the touch target below and beside the toggle but never up into the action it sits under', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <HappierStateDetails testID="state" label="Details" details="code" renderCaret={() => <i />} renderLabel={(label) => <span>{label}</span>} />
      </HappierUiPlatformProvider>,
    );
    try {
      const toggle = mount.container.querySelector<HTMLElement>('[data-testid="state-details-toggle"]')!;
      const reach = readHitAreaReach(toggle);
      expect(reach).not.toBeNull();
      expect(reach!.top).toBe(0);
      expect(reach!.bottom).toBeGreaterThanOrEqual(0);
    } finally {
      mount.unmount();
    }
  });
});
