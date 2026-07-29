import { describe, expect, it } from 'vitest';

import {
  defineDescriptorAction,
  defineDescriptorPanel,
  defineDescriptorText,
} from './primitives.js';

describe('descriptor primitive metadata', () => {
  it('serializes descriptor-friendly primitives without host code execution', () => {
    const descriptor = defineDescriptorPanel({
      titleKey: 'review.title',
      children: [
        defineDescriptorAction({
          id: 'refresh',
          labelKey: 'review.refresh',
          action: { kind: 'hostAction', id: 'reviews.refresh' },
          children: [
            defineDescriptorText({ valueKey: 'review.status' }),
          ],
        }),
      ],
    });

    expect(JSON.parse(JSON.stringify(descriptor))).toEqual({
      kind: 'panel',
      titleKey: 'review.title',
      children: [
        {
          kind: 'action',
          id: 'refresh',
          labelKey: 'review.refresh',
          action: { kind: 'hostAction', id: 'reviews.refresh' },
          children: [
            { kind: 'text', valueKey: 'review.status' },
          ],
        },
      ],
    });
  });
});
