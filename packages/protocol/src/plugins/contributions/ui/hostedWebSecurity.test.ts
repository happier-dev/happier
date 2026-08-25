import { describe, expect, it } from 'vitest';

import {
  PluginHostedWebSecurityPolicyV1Schema,
  buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
} from './hostedWebSecurity.js';

describe('hostedWebSecurity', () => {
  it('rejects CSP source alternatives that cannot change the emitted policy', () => {
    for (const csp of [
      { scriptSrc: 'selfAndDeclared' },
      { styleSrc: 'selfAndDeclared' },
      { imgSrc: 'selfDataBlobAndDeclared' },
      { fontSrc: 'selfAndDeclared' },
    ]) {
      expect(PluginHostedWebSecurityPolicyV1Schema.safeParse({ csp }).success).toBe(false);
    }
  });

  it('keeps declared connects and explicit data/blob booleans as the resource controls', () => {
    const security = PluginHostedWebSecurityPolicyV1Schema.parse({
      allowedConnectOrigins: ['https://api.happier.test'],
      csp: {
        connectSrc: 'declaredOrigins',
        allowDataUrls: true,
        allowBlobUrls: true,
      },
    });

    const csp = buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security);

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' https://api.happier.test");
  });

  it('does not advertise unsupported CSP navigation enforcement', () => {
    const security = PluginHostedWebSecurityPolicyV1Schema.parse({});

    const csp = buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security);

    // CSP does not provide a reliably enforced `navigate-to` directive. Actual
    // top-level navigation authority belongs to each native/web frame adapter.
    expect(csp).not.toContain('navigate-to');
    expect(csp).toContain("form-action 'none'");
  });

  describe('frame-ancestors (§3.12, EU-8)', () => {
    const security = PluginHostedWebSecurityPolicyV1Schema.parse({
      // An author declaring every origin knob it owns must not move the
      // ancestor directive by one character: the host ancestor is not the
      // plugin's to choose.
      allowedNavigationOrigins: ['https://author.example'],
      allowedCallbackOrigins: ['https://author.example'],
      allowedConnectOrigins: ['https://author.example'],
    });

    it('embeds the exact host ancestors it was given rather than refusing every frame', () => {
      const csp = buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security, {
        frameAncestors: ['https://host.happier.test', 'http://127.0.0.1:19364'],
      });

      expect(csp).toContain('frame-ancestors https://host.happier.test http://127.0.0.1:19364');
      expect(csp).not.toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('frame-ancestors *');
      // The author's own origins reach the directives they own and no other.
      expect(csp).not.toContain('navigate-to');
      expect(csp).not.toContain('frame-ancestors https://author.example');
    });

    it('fails closed when no host ancestor is known', () => {
      expect(buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security))
        .toContain("frame-ancestors 'none'");
      expect(buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security, { frameAncestors: [] }))
        .toContain("frame-ancestors 'none'");
    });

    it('drops an ancestor that is not an exact http(s) origin', () => {
      const csp = buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security, {
        frameAncestors: [
          '*',
          'https://*.happier.test',
          'https://host.happier.test/embed',
          'javascript:alert(1)',
          'https://host.happier.test',
        ],
      });

      expect(csp).toContain('frame-ancestors https://host.happier.test');
      expect(csp).not.toContain('*');
      expect(csp).not.toContain('/embed');
      expect(csp).not.toContain('javascript:');
    });

    it('refuses a wildcard host in an AUTHOR-declared origin too', () => {
      // Same owner, same defect: `new URL('https://*.evil.test').origin`
      // round-trips unchanged, so the exactness check has to reject the
      // wildcard host explicitly or a manifest could widen connect/navigate.
      expect(PluginHostedWebSecurityPolicyV1Schema.safeParse({
        allowedConnectOrigins: ['https://*.evil.test'],
      }).success).toBe(false);
      expect(PluginHostedWebSecurityPolicyV1Schema.safeParse({
        allowedConnectOrigins: ['https://api.evil.test'],
      }).success).toBe(true);
    });
  });
});
