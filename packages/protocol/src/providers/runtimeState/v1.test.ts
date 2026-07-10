import { describe, expect, it } from 'vitest';

import {
  deriveProviderConnectionSummaryHealthV1,
  ProviderCatalogRuntimeStateKeyV1Schema,
  ProviderEndpointRuntimeStateKeyV1Schema,
  ProviderEndpointRuntimeStateV1Schema,
} from './v1.js';

describe('provider endpoint runtime state', () => {
  it('accepts only the exact error and timing shape owned by each settled status', () => {
    const valid = [
      { status: 'not_checked', activity: 'idle' },
      { status: 'available', activity: 'checking', observedAt: 10, staleAt: 20 },
      { status: 'unreachable', activity: 'idle', errorCode: 'provider_endpoint_unreachable', observedAt: 10, retryAt: 11 },
      { status: 'temporarily_unavailable', activity: 'idle', errorCode: 'provider_endpoint_unavailable', observedAt: 10 },
      { status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited', observedAt: 10, retryAt: 20 },
      { status: 'unauthorized', activity: 'idle', errorCode: 'provider_endpoint_auth_required', observedAt: 10 },
      { status: 'unauthorized', activity: 'idle', errorCode: 'provider_endpoint_unauthorized', observedAt: 10 },
      { status: 'invalid_response', activity: 'idle', errorCode: 'provider_probe_response_invalid', observedAt: 10 },
    ];
    for (const state of valid) expect(ProviderEndpointRuntimeStateV1Schema.safeParse(state).success).toBe(true);
  });

  it.each([
    { status: 'not_checked', activity: 'idle', errorCode: 'provider_secret_missing' },
    { status: 'available', activity: 'idle', observedAt: 10, errorCode: 'provider_endpoint_unreachable' },
    { status: 'available', activity: 'idle' },
    { status: 'unreachable', activity: 'idle', errorCode: 'provider_endpoint_unavailable', observedAt: 10 },
    { status: 'temporarily_unavailable', activity: 'idle', errorCode: 'provider_endpoint_unavailable' },
    { status: 'unauthorized', activity: 'idle', errorCode: 'provider_endpoint_auth_required', observedAt: 10, retryAt: 20 },
    { status: 'invalid_response', activity: 'idle', errorCode: 'provider_probe_response_invalid', observedAt: 10, retryAt: 20 },
    { status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited', observedAt: 10, retryAt: 9 },
    { status: 'available', activity: 'idle', observedAt: 10, staleAt: 9 },
  ])('rejects an illegal status/error/timing combination: $status', (state) => {
    expect(ProviderEndpointRuntimeStateV1Schema.safeParse(state).success).toBe(false);
  });

  it('derives connection summaries from exact settled states while activity remains orthogonal', () => {
    const parse = (value: unknown) => ProviderEndpointRuntimeStateV1Schema.parse(value);
    const available = parse({ status: 'available', activity: 'checking', observedAt: 10 });
    const rateLimited = parse({
      status: 'rate_limited', activity: 'idle', errorCode: 'provider_endpoint_rate_limited', observedAt: 10, retryAt: 20,
    });
    const unreachable = parse({
      status: 'unreachable', activity: 'idle', errorCode: 'provider_endpoint_unreachable', observedAt: 10,
    });
    expect(deriveProviderConnectionSummaryHealthV1([])).toBe('not_checked');
    expect(deriveProviderConnectionSummaryHealthV1([available])).toBe('available');
    expect(deriveProviderConnectionSummaryHealthV1([available, unreachable])).toBe('partial');
    expect(deriveProviderConnectionSummaryHealthV1([rateLimited])).toBe('needs_attention');
    expect(deriveProviderConnectionSummaryHealthV1([unreachable])).toBe('unreachable');
  });

  it('makes credential rebinding and rotation produce non-current endpoint and catalog cache identities', () => {
    const endpointBase = {
      machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: 'responses',
      endpointFingerprint: 'endpoint-set:v1:a',
    } as const;
    const catalogBase = {
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint: 'catalog:v1:a',
    } as const;
    const oldAuthorization = 'observation-authorization:v1:old';
    const rotatedAuthorization = 'observation-authorization:v1:rotated';
    const oldEndpoint = ProviderEndpointRuntimeStateKeyV1Schema.parse({
      ...endpointBase, observationAuthorizationFingerprint: oldAuthorization,
    });
    const rotatedEndpoint = ProviderEndpointRuntimeStateKeyV1Schema.parse({
      ...endpointBase, observationAuthorizationFingerprint: rotatedAuthorization,
    });
    const oldCatalog = ProviderCatalogRuntimeStateKeyV1Schema.parse({
      ...catalogBase, observationAuthorizationFingerprint: oldAuthorization,
    });
    const rotatedCatalog = ProviderCatalogRuntimeStateKeyV1Schema.parse({
      ...catalogBase, observationAuthorizationFingerprint: rotatedAuthorization,
    });
    expect(rotatedEndpoint).not.toEqual(oldEndpoint);
    expect(rotatedCatalog).not.toEqual(oldCatalog);
    expect(ProviderEndpointRuntimeStateKeyV1Schema.safeParse(endpointBase).success).toBe(false);
    expect(ProviderCatalogRuntimeStateKeyV1Schema.safeParse(catalogBase).success).toBe(false);
  });
});
