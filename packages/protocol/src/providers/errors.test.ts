import { describe, expect, it } from 'vitest';

import { ProviderBindingCompatibilityV1Schema } from './compatibility/v1.js';
import { createProviderErrorV1, ProviderErrorV1Schema } from './errors.js';

describe('provider stable errors and compatibility envelopes', () => {
  it('requires evidence for verified compatibility', () => {
    expect(ProviderBindingCompatibilityV1Schema.safeParse({ status: 'verified', selectedProtocol: 'anthropic' }).success).toBe(false);
  });

  it('offers load only when a verified load action exists', () => {
    expect(createProviderErrorV1('provider_model_unloaded').action).toBe('review_connection');
    expect(createProviderErrorV1('provider_model_unloaded', { modelLoadAvailable: true }).action).toBe('load_model');
  });

  it('represents a disabled provider feature independently from connection enablement', () => {
    expect(createProviderErrorV1('provider_feature_disabled')).toEqual({
      v: 1,
      code: 'provider_feature_disabled',
      retryable: false,
      action: 'review_features',
    });
  });

  it('represents malformed settings and invalid connection mutations as stable review errors', () => {
    expect(createProviderErrorV1('provider_settings_invalid')).toMatchObject({
      code: 'provider_settings_invalid', retryable: false, action: 'review_connection',
    });
    expect(createProviderErrorV1('provider_connection_invalid')).toMatchObject({
      code: 'provider_connection_invalid', retryable: false, action: 'review_connection',
    });
  });

  it('represents an invalid Provider RPC response independently from endpoint availability', () => {
    expect(createProviderErrorV1('provider_rpc_response_invalid', {
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_rpc_response_invalid',
      machineId: 'machine-a',
      retryable: true,
      action: 'retry',
    });
  });

  it('requires current-state review when a Provider RPC mutation outcome is unknown', () => {
    expect(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_rpc_mutation_outcome_unknown',
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      retryable: false,
      action: 'review_current_state',
    });
  });

  it('represents an Agent runtime prerequisite refusal without overloading binding continuity', () => {
    expect(createProviderErrorV1('provider_agent_runtime_unsupported', {
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_agent_runtime_unsupported',
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      retryable: false,
      action: 'review_connection',
    });
  });

  it('represents Provider materialization failures without mislabeling them as binding continuity drift', () => {
    expect(createProviderErrorV1('provider_materialization_failed', {
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_materialization_failed',
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      retryable: false,
      action: 'review_connection',
    });
  });

  it('represents a connection revision conflict independently from authorization drift', () => {
    expect(createProviderErrorV1('provider_connection_changed', {
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_connection_changed',
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      retryable: true,
      action: 'review_connection',
    });
  });

  it('represents profile-migration review failures without inventing a connection identity', () => {
    expect(createProviderErrorV1('provider_profile_migration_source_changed', {
      sourceProfileId: 'company-gateway',
    })).toMatchObject({
      code: 'provider_profile_migration_source_changed',
      sourceProfileId: 'company-gateway',
      retryable: false,
      action: 'review_profile_migration',
    });
  });

  it('rejects wire envelopes whose retryability or recovery action contradicts their code', () => {
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_connection_not_found', retryable: true, action: 'retry',
    }).success).toBe(false);
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_secret_missing', retryable: false, action: 'replace_secret',
    }).success).toBe(false);
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_endpoint_rate_limited', retryable: true, action: 'retry', retryAfterMs: 86_400_001,
    }).success).toBe(false);
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_endpoint_unreachable', retryable: true, action: 'retry', retryAfterMs: 10,
    }).success).toBe(false);
  });

  it('accepts exactly the two model-unloaded recovery branches and optional bounded rate-limit delay', () => {
    for (const action of ['review_connection', 'load_model']) {
      expect(ProviderErrorV1Schema.safeParse({
        v: 1, code: 'provider_model_unloaded', retryable: false, action,
      }).success).toBe(true);
    }
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_model_unloaded', retryable: false, action: 'choose_model',
    }).success).toBe(false);
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_endpoint_rate_limited', retryable: true, action: 'retry',
    }).success).toBe(true);
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_endpoint_rate_limited', retryable: true, action: 'retry', retryAfterMs: 1,
    }).success).toBe(true);
  });
});
