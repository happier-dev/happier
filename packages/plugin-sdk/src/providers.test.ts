import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  buildBackendTargetKeyV2,
  normalizeProviderCredentialHeaderName,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
  type ProviderConnectionsDescribeRequest,
  type ProviderConnectionMutationRequest,
  type ProviderBindingStatusRequest,
  type ProviderModelLoadRequest,
  type ProviderModelProjectionRequest,
  type ProviderModelsRequest,
  type ProviderModelSettingsMutationRequest,
  type ProviderProbeRequest,
  type ProviderProfileMigrationConfirmRequest,
  type ProviderProfileMigrationConflictConfirmRequest,
  type ProviderProfileMigrationPreviewRequest,
  type ProviderConnectionsService,
  type ProvidersService,
} from './providers.js';

describe('experimental Provider SDK boundary', () => {
  it('reuses protocol-owned endpoint and header validation without a second validator', () => {
    expect(ProviderEndpointUrlSyntaxSchema.safeParse('https://gateway.example/v1').success).toBe(true);
    expect(ProviderEndpointUrlSyntaxSchema.safeParse('file:///tmp/secret').success).toBe(false);
    expect(ProviderPublicHeadersV1Schema.safeParse({ 'x-tenant': 'work' }).success).toBe(true);
    expect(normalizeProviderCredentialHeaderName('X-API-Key')).toBe('x-api-key');
    expect(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' })).toBe('backend:codex');
    expect(SessionModelSelectionV1Schema).toBeDefined();
    expect(resolveSessionModelSelectionIntentV1).toBeTypeOf('function');
    expect(SessionModelSelectionResolutionError).toBeTypeOf('function');
  });

  it('curates host-neutral Provider service requests over the Protocol-owned results', () => {
    expectTypeOf<ProviderConnectionsDescribeRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderConnectionMutationRequest>().not.toHaveProperty('machineId');
    expectTypeOf<Extract<ProviderConnectionMutationRequest, { action: 'startLocal' }>>()
      .not.toHaveProperty('connectionId');
    expectTypeOf<ProviderBindingStatusRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderProbeRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderModelsRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderModelLoadRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderModelProjectionRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderModelSettingsMutationRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderProfileMigrationPreviewRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderProfileMigrationConfirmRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderProfileMigrationConflictConfirmRequest>().not.toHaveProperty('machineId');
    expectTypeOf<ProviderConnectionsService['describe']>()
      .parameter(0)
      .toEqualTypeOf<ProviderConnectionsDescribeRequest>();
    expectTypeOf<ProvidersService>().toHaveProperty('connections');
    expectTypeOf<ProvidersService>().toHaveProperty('catalog');
    expectTypeOf<ProvidersService>().toHaveProperty('migrations');
  });
});
