import { expect, it } from 'vitest';
import { ServiceHealthNoticePageV1Schema } from './accountNoticePageV1.js';

it('routes a saved Environment check before target selection and preserves a selected target', () => {
  const page = { kind: 'host', page: 'environment', environment: {
    serverId: 'home', projectSourceId: 'source', environmentId: 'environment',
  } };
  expect(ServiceHealthNoticePageV1Schema.safeParse(page)).toMatchObject({ success: true, data: page });
  expect(ServiceHealthNoticePageV1Schema.parse({ ...page, targetLinkId: 'runtime' }))
    .toEqual({ ...page, targetLinkId: 'runtime' });
  expect(ServiceHealthNoticePageV1Schema.safeParse({ ...page, targetLinkId: '' }).success).toBe(false);
});
