import { describe, expect, it } from 'vitest';

import { buildServiceCheckHref, readServiceCheckRouteParams } from './deploymentNavigation';

describe('a saved Check opens as its own Services page', () => {
  it('addresses one Check trigger under Services, and reads the same Check back from the route', () => {
    const href = buildServiceCheckHref({ automationId: 'automation a/1', triggerId: 'trigger?b' });
    expect(href.startsWith('/projects/deployments/check?')).toBe(true);
    const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
    expect(readServiceCheckRouteParams(params)).toEqual({ automationId: 'automation a/1', triggerId: 'trigger?b' });
  });

  it('an incomplete address names no Check', () => {
    expect(readServiceCheckRouteParams({ automation: 'a' })).toBeNull();
    expect(readServiceCheckRouteParams({ automation: ['a', 'b'], trigger: 't' })).toBeNull();
  });
});
