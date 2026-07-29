import { describe, expect, it } from 'vitest';
import { ProviderEndpointRuntimeStateRecordV1Schema } from '@happier-dev/protocol';

import { selectProviderConnectionRuntimeSummary } from './runtimeSummary';

describe('selectProviderConnectionRuntimeSummary', () => {
  it('uses only exact current endpoint and authorization fingerprints', () => {
    const summary = selectProviderConnectionRuntimeSummary({
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      expectedEndpoints: [{
        endpointTemplateId: 'responses',
        endpointFingerprint: 'endpoint-observation:v1:current',
      }],
      allowedObservationAuthorizationFingerprints: ['observation-authorization:v1:current'],
      endpointHealth: [
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:old', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: { status: 'available', activity: 'idle', observedAt: 90 },
          lastAccessedAt: 90,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:current', observationAuthorizationFingerprint: 'observation-authorization:v1:old',
          },
          state: { status: 'available', activity: 'idle', observedAt: 95 },
          lastAccessedAt: 95,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:current', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: { status: 'unreachable', activity: 'idle', observedAt: 100, errorCode: 'provider_endpoint_unreachable' },
          lastAccessedAt: 100,
        }),
      ],
      modelCount: 12,
    });

    expect(summary).toEqual({
      health: 'unreachable', modelCount: 12, checkedAt: 100,
      endpoints: [{
        endpointTemplateId: 'responses', status: 'unreachable', activity: 'idle',
        observedAt: 100, errorCode: 'provider_endpoint_unreachable', retryAt: null,
      }],
    });
  });

  it('reports not checked when there is no exact authorized observation', () => {
    expect(selectProviderConnectionRuntimeSummary({
      machineId: 'machine-a', connectionId: 'pc_gateway',
      expectedEndpoints: [{ endpointTemplateId: 'responses', endpointFingerprint: 'endpoint-observation:v1:current' }],
      allowedObservationAuthorizationFingerprints: ['observation-authorization:v1:current'],
      endpointHealth: [], modelCount: null,
    })).toEqual({
      health: 'not_checked', modelCount: null, checkedAt: null,
      endpoints: [{
        endpointTemplateId: 'responses', status: 'not_checked', activity: 'idle',
        observedAt: null, errorCode: null, retryAt: null,
      }],
    });
  });

  it('keeps transient activity and settled retry reasons separate in endpoint rows', () => {
    const summary = selectProviderConnectionRuntimeSummary({
      machineId: 'machine-a', connectionId: 'pc_gateway',
      expectedEndpoints: [
        { endpointTemplateId: 'chat', endpointFingerprint: 'endpoint-observation:v1:chat' },
        { endpointTemplateId: 'responses', endpointFingerprint: 'endpoint-observation:v1:responses' },
      ],
      allowedObservationAuthorizationFingerprints: ['observation-authorization:v1:current'],
      endpointHealth: [
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'chat',
            endpointFingerprint: 'endpoint-observation:v1:chat', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: { status: 'not_checked', activity: 'checking' },
          lastAccessedAt: 110,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:responses', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: {
            status: 'rate_limited', activity: 'idle', observedAt: 100,
            errorCode: 'provider_endpoint_rate_limited', retryAt: 200,
          },
          lastAccessedAt: 100,
        }),
      ],
      modelCount: null,
    });
    expect(summary.endpoints).toEqual([
      { endpointTemplateId: 'chat', status: 'not_checked', activity: 'checking', observedAt: null, errorCode: null, retryAt: null },
      { endpointTemplateId: 'responses', status: 'rate_limited', activity: 'idle', observedAt: 100, errorCode: 'provider_endpoint_rate_limited', retryAt: 200 },
    ]);
  });

  it('deduplicates multi-probe endpoints and separates current activity from the latest settled observation', () => {
    const summary = selectProviderConnectionRuntimeSummary({
      machineId: 'machine-a', connectionId: 'pc_gateway',
      expectedEndpoints: [
        { endpointTemplateId: 'responses', endpointFingerprint: 'endpoint-observation:v1:first' },
        { endpointTemplateId: 'responses', endpointFingerprint: 'endpoint-observation:v1:older-checking' },
        { endpointTemplateId: 'responses', endpointFingerprint: 'endpoint-observation:v1:last' },
      ],
      allowedObservationAuthorizationFingerprints: ['observation-authorization:v1:current'],
      endpointHealth: [
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:first', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: { status: 'available', activity: 'idle', observedAt: 200 },
          lastAccessedAt: 200,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:older-checking', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: { status: 'unreachable', activity: 'checking', observedAt: 100, errorCode: 'provider_endpoint_unreachable' },
          lastAccessedAt: 300,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway', endpointTemplateId: 'responses',
            endpointFingerprint: 'endpoint-observation:v1:last', observationAuthorizationFingerprint: 'observation-authorization:v1:current',
          },
          state: {
            status: 'rate_limited', activity: 'idle', observedAt: 200,
            errorCode: 'provider_endpoint_rate_limited', retryAt: 250,
          },
          lastAccessedAt: 200,
        }),
      ],
      modelCount: null,
    });

    expect(summary).toEqual({
      health: 'needs_attention', modelCount: null, checkedAt: 200,
      endpoints: [{
        endpointTemplateId: 'responses', status: 'rate_limited', activity: 'checking',
        observedAt: 200, errorCode: 'provider_endpoint_rate_limited', retryAt: 250,
      }],
    });
  });
});
