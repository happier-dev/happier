import { describe, expect, it } from 'vitest';

import {
  PluginHostedWebSecurityPolicyV1Schema,
  buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
} from './hostedWebSecurity.js';

describe('hostedWebSecurity', () => {
  it('fails closed for top-level navigation when no navigation origins are declared', () => {
    const security = PluginHostedWebSecurityPolicyV1Schema.parse({});

    const csp = buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security);

    expect(csp).toContain("navigate-to 'none'");
  });
});
