import { describe, expect, it } from 'vitest';

import { ProviderBindingCompatibilityV1Schema } from './compatibility/v1.js';
import { createProviderErrorV1, ProviderErrorV1Schema, providerErrorFromRpcFailure } from './errors.js';
import { ProfileRecordIdV1Schema } from '../profiles/v2/profileId.js';
import { RPC_ERROR_CODES, RpcError } from '../rpc/errors.js';

describe('provider stable errors and compatibility envelopes', () => {
  it('retains the shared Action cause and request identity through Provider failure normalization', () => {
    const failure = { ok: false, errorCode: 'action_failed', error: 'private vendor prose', requestId: 'request-provider-read',
      failureCause: { phase: 'providers.connections.describe', errorClass: 'Error', errorCode: 'provider_endpoint_unreachable', httpStatus: null } };
    expect(providerErrorFromRpcFailure(failure, { connectionId: 'pc_a', machineId: 'machine-a' })).toMatchObject({
      code: 'provider_endpoint_unreachable', requestId: failure.requestId, connectionId: 'pc_a', machineId: 'machine-a', retryable: true,
    });
    expect(JSON.stringify(providerErrorFromRpcFailure(failure))).not.toContain(failure.error);
  });

  it('retains an Action request ID alongside the typed Provider detail and transport cause', () => {
    const failure = { ok: false, errorCode: 'provider_connection_invalid', error: 'private text', requestId: 'request-provider-detail',
      details: createProviderErrorV1('provider_connection_invalid', { connectionId: 'pc_a', reason: 'managed_purpose_bindings_missing' }) };
    expect(providerErrorFromRpcFailure(failure)).toMatchObject({ ...failure.details, requestId: failure.requestId });
    expect(providerErrorFromRpcFailure({ ...failure, details: undefined, errorCode: 'ECONNREFUSED' })).toMatchObject({
      code: 'machine_offline', requestId: failure.requestId,
    });
  });

  it('keeps a typed daemon cause that has no Provider recovery code in the shared failure carrier', () => {
    const caught = Object.assign(new Error('private daemon prose'), {
      code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE', requestId: 'request-daemon-provider',
    });
    const error = providerErrorFromRpcFailure(caught);
    expect(error).toMatchObject({ code: 'agent_error', requestId: caught.requestId,
      failureCause: { errorCode: caught.code, phase: 'dispatch' } });
    expect(providerErrorFromRpcFailure({ ok: false, errorCode: 'agent_error', error: 'unavailable',
      requestId: 'request-action-provider', details: error,
      failureCause: { phase: 'providers.connections.describe', errorClass: 'Error', errorCode: 'agent_error', httpStatus: null },
    })).toMatchObject({ requestId: 'request-action-provider', failureCause: { errorCode: caught.code } });
    expect(JSON.stringify(error)).not.toContain(caught.message);
  });

  it('keeps a Machine RPC access refusal distinct from an Agent failure', () => {
    const context = { connectionId: 'pc_a', machineId: 'machine-a' };
    expect(providerErrorFromRpcFailure(new RpcError('private refusal text', RPC_ERROR_CODES.FORBIDDEN), context))
      .toEqual(createProviderErrorV1('provider_machine_grant_stale', context));
  });
  it('offers Retry when Machine transport discovery cannot reach a Provider read', () => {
    const failure = new RpcError('transport unavailable', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
    expect(providerErrorFromRpcFailure(failure, { machineId: 'machine-a' })).toEqual(
      createProviderErrorV1('provider_machine_unavailable', { machineId: 'machine-a' }),
    );
  });
  it('keeps an explicit unsupported model option refusal non-retryable through the wire reader', () => {
    const error = { v: 1, code: 'provider_model_config_option_unsupported',
      retryable: false, action: 'choose_model', connectionId: 'pc_a' };
    expect(ProviderErrorV1Schema.safeParse(error).success).toBe(true);
    expect(providerErrorFromRpcFailure(error)).toEqual(error);
    expect(ProviderErrorV1Schema.safeParse({ ...error, retryable: true }).success).toBe(false);
  });
  it('keeps an unavailable Account catalog retryable without treating it as an Agent failure', () => {
    const failure = Object.assign(new Error('provider_catalog_unavailable'), {
      code: 'provider_catalog_unavailable', details: { status: 'unavailable', reason: 'unreachable' },
    });
    expect(providerErrorFromRpcFailure(failure, { connectionId: 'pc_a' })).toMatchObject({
      code: 'provider_catalog_unavailable', connectionId: 'pc_a', retryable: true, action: 'retry',
    });
  });
  it('classifies unwrapped machine transport failures without hiding unknown causes', () => {
    for (const failure of [new Error('offline'), new Error('machine_offline')]) {
      expect(providerErrorFromRpcFailure(failure)).toMatchObject({ code: 'machine_offline', retryable: true, action: 'retry' });
    }
    expect(providerErrorFromRpcFailure(new Error('unexpected projection failure')))
      .toMatchObject({ code: 'agent_error', retryable: false, action: 'review_connection' });
  });
  it('distinguishes direct Run inheritance refusal from an unsupported credential format', () => {
    expect(ProviderErrorV1Schema.safeParse({
      v: 1, code: 'provider_run_credential_selection_required',
      retryable: false, action: 'choose_connection',
    }).success).toBe(true);
    expect(createProviderErrorV1('provider_credential_transport_unavailable').action).toBe('review_credential_transport');
  });
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

  it('preserves a closed invalid-connection reason through the wire reader without changing recovery', () => {
    const error = { ...createProviderErrorV1('provider_connection_invalid', { connectionId: 'pc_gateway' }),
      reason: 'managed_purpose_bindings_missing' };
    expect(ProviderErrorV1Schema.parse(error)).toEqual(error);
    expect(providerErrorFromRpcFailure(error)).toEqual(error);
    expect(ProviderErrorV1Schema.safeParse({ ...error, reason: 'raw provider failure' }).success).toBe(false);
    expect(ProviderErrorV1Schema.safeParse({ ...error, code: 'provider_connection_not_found', action: 'choose_connection' }).success).toBe(false);
  });

  it('carries the Saved Secret owner admission reason only on Saved Secret refusals', () => {
    const error = { ...createProviderErrorV1('provider_secret_missing', { connectionId: 'pc_gateway' }),
      savedSecretReason: 'reference_deleted' };
    expect(ProviderErrorV1Schema.parse(error)).toEqual(error);
    expect(providerErrorFromRpcFailure(error)).toEqual(error);
    expect(createProviderErrorV1('provider_secret_unavailable', { savedSecretReason: 'reference_unavailable' }))
      .toMatchObject({ code: 'provider_secret_unavailable', savedSecretReason: 'reference_unavailable' });
    expect(createProviderErrorV1('provider_binding_changed', { savedSecretReason: 'reference_stale' }))
      .toMatchObject({ code: 'provider_binding_changed', savedSecretReason: 'reference_stale' });
    expect(ProviderErrorV1Schema.safeParse({ ...error, savedSecretReason: 'raw failure' }).success).toBe(false);
    expect(ProviderErrorV1Schema.safeParse({ ...createProviderErrorV1('provider_endpoint_unreachable'),
      savedSecretReason: 'reference_deleted' }).success).toBe(false);
  });

  it('keeps a temporarily unavailable Provider credential distinct from authoritative absence', () => {
    expect(createProviderErrorV1('provider_secret_unavailable', {
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_secret_unavailable',
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      retryable: true,
      action: 'retry',
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

  it('reuses external-session transport outcomes for Provider RPC failures', () => {
    expect(createProviderErrorV1('machine_offline')).toMatchObject({ retryable: true, action: 'retry' });
    expect(createProviderErrorV1('agent_unavailable')).toMatchObject({ retryable: false, action: 'review_connection' });
    expect(createProviderErrorV1('agent_timeout')).toMatchObject({ retryable: true, action: 'retry' });
    expect(createProviderErrorV1('agent_error')).toMatchObject({ retryable: false, action: 'review_connection' });
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

  it('preserves uncertain Account catalogue writes as non-retryable current-state review', () => {
    const code = 'provider_catalog_outcome_unknown';
    expect(providerErrorFromRpcFailure(Object.assign(new Error(code), { code }), { connectionId: 'pc_a' }))
      .toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', { connectionId: 'pc_a' }));
  });

  it('keeps an Account catalogue CAS conflict distinct from an Agent failure', () => {
    expect(providerErrorFromRpcFailure(Object.assign(new Error('provider_catalog_conflict'), {
      code: 'provider_catalog_conflict',
    }), { connectionId: 'pc_a' })).toEqual(createProviderErrorV1('provider_connection_changed', { connectionId: 'pc_a' }));
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

  it('keeps machine transport and managed-daemon launch refusals distinct from endpoint failures', () => {
    expect(createProviderErrorV1('provider_machine_unavailable', {
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_machine_unavailable',
      machineId: 'machine-a',
      retryable: true,
      action: 'retry',
    });
    expect(createProviderErrorV1('provider_managed_requires_daemon', {
      connectionId: 'pc_managed',
      machineId: 'machine-a',
    })).toEqual({
      v: 1,
      code: 'provider_managed_requires_daemon',
      connectionId: 'pc_managed',
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

  it('preserves an admitted long untrimmed Profile identity in migration failure responses', () => {
    const sourceProfileId = `  retained-${'x'.repeat(270)}  `;
    expect(ProfileRecordIdV1Schema.parse(sourceProfileId)).toBe(sourceProfileId);
    const error = createProviderErrorV1('provider_profile_migration_source_changed', { sourceProfileId });
    expect(error).toEqual({ v: 1, code: 'provider_profile_migration_source_changed', sourceProfileId,
      retryable: false, action: 'review_profile_migration' });
    expect(ProviderErrorV1Schema.parse(error).sourceProfileId).toBe(sourceProfileId);
    expect(ProviderErrorV1Schema.safeParse({ ...error, sourceProfileId: '' }).success).toBe(false);
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
    }).success).toBe(true);
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
