import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierDivider } from './Foundation.js';

// C77 (phone Workflows, 11-17): every Collection grid row carried its hairline as a `separator`, which a row may not
// own (axe aria-required-children). A row's hairline is drawn decoration; a divider between content stays a separator.
describe('HappierDivider', () => {
  it('is a separator between content, and a decorative hairline is hidden from assistive technology', () => {
    const mount = mountThroughReactNativeWeb(<>
      <HappierDivider color="#000" testID="between" />
      <HappierDivider color="#000" testID="hairline" decorative />
    </>);
    const between = mount.container.querySelector('[data-testid="between"]')!;
    const hairline = mount.container.querySelector('[data-testid="hairline"]')!;
    expect(between.getAttribute('role')).toBe('separator');
    expect([hairline.getAttribute('role'), hairline.getAttribute('aria-hidden')]).toEqual([null, 'true']);
    mount.unmount();
  });
});
