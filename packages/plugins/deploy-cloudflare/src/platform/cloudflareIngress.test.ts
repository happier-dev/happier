import { describe, expect, it } from 'vitest';
import { prepareOwnedCloudflareIngress } from './cloudflareIngress.js';

describe('Owned Cloudflare ingress', () => {
  it('leaves an empty native config unchanged when removal has no owned routes', () => {
    const config = { ingress: [] };
    expect(prepareOwnedCloudflareIngress({ config, owned: [], desired: [] })).toEqual({ kind: 'prepared', config });
  });
  const foreign = { hostname: 'foreign.example.test', service: 'http://foreign:8080',
    originRequest: { httpHostHeader: 'foreign.example.test', connectTimeout: 7 }, opaqueVendorOption: ['retained', 2] };
  const fallback = { service: 'http_status:404' };
  const owned = [{ hostname: 'app.example.test', expectedService: 'http://caddy:8080' }];

  it('inserts only the reviewed hostname before the final catch-all and preserves foreign config', () => {
    const config = { ingress: [foreign, fallback], 'warp-routing': { enabled: true }, originRequest: { noTLSVerify: false } };
    expect(prepareOwnedCloudflareIngress({ config, owned: [],
      desired: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }] })).toEqual({ kind: 'prepared', config: {
      ...config, ingress: [foreign, { hostname: 'app.example.test', service: 'http://caddy:8080' }, fallback],
    } });
    expect(config.ingress).toEqual([foreign, fallback]);
  });

  it('removes only the exact owned hostname and native upstream while another consumer remains', () => {
    const config = { ingress: [foreign, { hostname: 'app.example.test', service: 'http://caddy:8080' }, fallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned, desired: [] })).toEqual({ kind: 'prepared', config: {
      ingress: [foreign, fallback],
    } });
  });

  it('refuses changed native upstreams instead of deleting or adopting them', () => {
    const config = { ingress: [{ hostname: 'app.example.test', service: 'http://someone-else:8080' }, fallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned, desired: [] })).toEqual({ kind: 'refused', code: 'route_conflict' });
  });

  it('refuses an existing unowned hostname even if its upstream happens to match', () => {
    const config = { ingress: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }, fallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned: [],
      desired: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }] })).toEqual({ kind: 'refused', code: 'route_conflict' });
  });

  it('retains foreign paths on the same hostname during exact owned route removal', () => {
    const retained = { hostname: 'app.example.test', path: '/private/.*', service: 'http://foreign:8080' };
    const config = { ingress: [retained, { hostname: 'app.example.test', path: '/app/.*', service: 'http://caddy:8080' }, fallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned: [{ ...owned[0]!, path: '/app/.*' }], desired: [] }))
      .toEqual({ kind: 'prepared', config: { ingress: [retained, fallback] } });
  });

  it('refuses a shadowing foreign wildcard instead of claiming the requested hostname is routed', () => {
    const config = { ingress: [{ hostname: '*.example.test', service: 'http://foreign:8080' }, fallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned: [],
      desired: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }] })).toEqual({ kind: 'refused', code: 'route_conflict' });
  });

  it('refuses a preceding foreign whole-host route that shadows an owned path', () => {
    const config = { ingress: [{ hostname: 'app.example.test', service: 'http://foreign:8080' },
      { hostname: 'app.example.test', path: '/app/.*', service: 'http://caddy:8080' }, fallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned: [{ ...owned[0]!, path: '/app/.*' }],
      desired: [{ hostname: 'app.example.test', path: '/app/.*', service: 'http://caddy-next:8080' }] }))
      .toEqual({ kind: 'refused', code: 'route_conflict' });
  });

  it('adds the catch-all for an initially empty new remote configuration', () => {
    expect(prepareOwnedCloudflareIngress({ config: { ingress: [] }, owned: [],
      desired: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }] })).toEqual({ kind: 'prepared', config: {
      ingress: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }, fallback],
    } });
  });

  it.each([
    { ingress: [{ service: 'http_status:404' }, foreign] },
    { ingress: [foreign, { service: 'http_status:404' }, { service: 'http_status:404' }] },
  ])('refuses incompatible catch-all state rather than reordering or replacing foreign rules', config => {
    expect(prepareOwnedCloudflareIngress({ config, owned: [], desired: [] })).toEqual({ kind: 'refused', code: 'route_conflict' });
  });

  it.each(['http_status:403', 'http://foreign-default:8080'])('preserves a valid foreign catch-all %s rather than imposing our empty-config default', service => {
    const retainedFallback = { service, originRequest: { connectTimeout: 13 } };
    const config = { ingress: [foreign, retainedFallback] };
    expect(prepareOwnedCloudflareIngress({ config, owned: [],
      desired: [{ hostname: 'app.example.test', service: 'http://caddy:8080' }] })).toEqual({ kind: 'prepared', config: {
      ingress: [foreign, { hostname: 'app.example.test', service: 'http://caddy:8080' }, retainedFallback],
    } });
  });

  it('preserves retained owned options on a reviewed upstream change and emits no change on equal input', () => {
    const existing = { hostname: 'app.example.test', service: 'http://caddy:8080', originRequest: { httpHostHeader: 'app.example.test' } };
    const config = { ingress: [foreign, existing, fallback] };
    const same = prepareOwnedCloudflareIngress({ config, owned,
      desired: [{ hostname: 'app.example.test', service: existing.service }] });
    expect(same).toEqual({ kind: 'prepared', config });
    if (same.kind === 'prepared') expect(same.config).toBe(config);
    expect(prepareOwnedCloudflareIngress({ config, owned,
      desired: [{ hostname: 'app.example.test', service: 'http://caddy-next:8080' }] })).toEqual({ kind: 'prepared', config: {
      ingress: [foreign, { ...existing, service: 'http://caddy-next:8080' }, fallback],
    } });
  });
});
