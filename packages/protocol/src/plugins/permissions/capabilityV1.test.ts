import { describe, expect, it } from 'vitest';

import {
  PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1,
  PluginPermissionCapabilityV1Schema,
} from './capabilityV1';

describe('enforced plugin permission capabilities', () => {
  it('advertises only capabilities with a grant reader and enforcer', () => {
    expect(PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1).toEqual([
      'reviews.comments.write.direct',
      'credentials.materialize.raw',
    ]);
    expect(PluginPermissionCapabilityV1Schema.safeParse('filesystem.read').success).toBe(false);
    expect(PluginPermissionCapabilityV1Schema.safeParse('process.spawn').success).toBe(false);
    expect(PluginPermissionCapabilityV1Schema.safeParse('reviews.comments.write.direct').success).toBe(true);
    expect(PluginPermissionCapabilityV1Schema.safeParse('credentials.materialize.raw').success).toBe(true);
  });
});
