import { describe, expect, it } from 'vitest';

import { HappierApprovalFields } from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

describe('approval fields on a page', () => {
  it('reads each value row as an Item: the name leads, the value is the detail on the right', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierApprovalFields density="page" rows={[{ kind: 'value', key: 'channelId', label: 'Webhook id', value: 'release-alerts' }]} />,
    );
    try {
      const innermost = (text: string) => [...mounted.container.querySelectorAll('*')]
        .find(node => node.textContent === text && node.children.length === 0);
      const label = innermost('Webhook id');
      const value = innermost('release-alerts');
      expect(label && value).toBeTruthy();
      expect(label!.compareDocumentPosition(value!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(getComputedStyle(value!).textAlign).toBe('right');
    } finally {
      mounted.unmount();
    }
  });
});
