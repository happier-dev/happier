import { describe, expect, it } from 'vitest';
import { assertOrganizationPolicyActionAllowed, assertOrganizationPolicyEndpointAllowed, getOrganizationPolicyLock, parseOrganizationPolicyV1 } from './organizationPolicyV1.js';

describe('organization policy v1', () => {
  it('parses defaults and exposes locks without changing absent policy', () => {
    expect(getOrganizationPolicyLock({ status: 'absent' }, 'home')).toBeNull();
    const result = parseOrganizationPolicyV1(JSON.stringify({ schemaVersion: 1, organization: 'Example', supportUrl: 'https://example.org/help', home: { url: 'https://home.example.org/', locked: true }, personalHome: { value: 'off', locked: false }, features: { deny: ['voice'] } }));
    expect(result.status).toBe('loaded');
    expect(getOrganizationPolicyLock(result, 'home')).toEqual({ organization: 'Example', supportUrl: 'https://example.org/help' });
    expect(() => assertOrganizationPolicyActionAllowed(result, 'home')).toThrow('organization_policy_locked');
    expect(() => assertOrganizationPolicyActionAllowed(result, 'accountService')).not.toThrow();
  });

  it.each([
    '{secret-invalid-json',
    JSON.stringify({ schemaVersion: 2, organization: 'secret-value' }),
    JSON.stringify({ schemaVersion: 1, organization: 'Example', supportUrl: 'secret-value' }),
    JSON.stringify({ schemaVersion: 1, organization: 'Example', secretKey: 'secret-value' }),
    JSON.stringify({ schemaVersion: 1, organization: 'Example', home: { url: 'https://example.org', webappUrl: 'https://secret-value.org' } }),
    JSON.stringify({ schemaVersion: 1, organization: 'Example', accountService: { url: 'https://secret-value@example.org' } }),
    JSON.stringify({ schemaVersion: 1, organization: 'Example', features: { deny: ['secret-value'] } }),
    JSON.stringify({ schemaVersion: 1, organization: 'Example', relays: { policy: 'disabled', urls: ['https://secret-value.org'] } }),
  ])('rejects invalid input with path/code only', (raw) => {
    const result = parseOrganizationPolicyV1(raw);
    expect(result.status).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(() => assertOrganizationPolicyActionAllowed(result, 'accountService')).toThrow('organization_policy_invalid');
  });

  it('removing the lock permits selection; explicit defaults are not locks', () => {
    const result = parseOrganizationPolicyV1(JSON.stringify({ schemaVersion: 1, organization: 'Example', home: { url: 'https://example.org', locked: false } }));
    expect(getOrganizationPolicyLock(result, 'home')).toBeNull();
    expect(() => assertOrganizationPolicyActionAllowed(result, 'home')).not.toThrow();
  });

  it('permits locked endpoint admission only to the configured canonical URL', () => {
    const result = parseOrganizationPolicyV1(JSON.stringify({ schemaVersion: 1, organization: 'Example', home: { url: 'https://home.example.org', locked: true } }));
    expect(() => assertOrganizationPolicyEndpointAllowed(result, 'home', 'https://home.example.org/')).not.toThrow();
    expect(() => assertOrganizationPolicyEndpointAllowed(result, 'home', 'https://outside.example.org')).toThrow('organization_policy_locked');
    expect(() => assertOrganizationPolicyEndpointAllowed({ status: 'invalid', error: { path: '$', code: 'invalid_json' } }, 'home', 'https://home.example.org')).toThrow('organization_policy_invalid');
  });
});
