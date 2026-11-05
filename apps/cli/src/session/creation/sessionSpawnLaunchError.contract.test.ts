import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler } from 'fastify-type-provider-zod';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from './projectSessionSpawnFailure';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { buildConnectedServiceCredentialRefreshSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';

describe('Session launch cause transport', () => {
  it('accepts an existing source-runtime refusal without the optional diagnostic subtype', () => {
    const legacyCause = { kind: 'launch_error' as const, code: 'SOURCE_RUNTIME_RELOAD_REQUIRED',
      message: 'Reload the Stack from current source.' };
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
      errorCode: 'SPAWN_FAILED', errorMessage: legacyCause.message, errorDetail: legacyCause,
    }));
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ type: 'error', launchError: legacyCause });
    expect(response.errorDetail).not.toHaveProperty('subtype');
  });
  it('retains a transient lease cause through strict transport without disclosing attached secrets', () => {
    const secret = 'sk-private-refresh-reason';
    const failure = buildConnectedServiceCredentialRefreshSpawnErrorResult({ agentId: 'claude', error: {
      name: 'ConnectedServiceSpawnCredentialRefreshError', kind: 'transient_refresh_failed',
      serviceId: 'acme.agent/account', profileId: 'waiting',
      reason: `connected_account_refresh_lease_not_acquired; accessToken=${secret}`,
    } });
    if (!failure) throw new Error('Expected lease refusal');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(failure));
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }));
    expect(result).toMatchObject({ code: 'spawn_failed', retryable: true, launchError: {
      code: 'connected_service_credential_refresh_unavailable',
      message: expect.stringContaining('connected_account_refresh_lease_not_acquired'),
    } });
    expect(JSON.stringify({ response, result })).not.toContain(secret);
  });

  it('keeps a rejected connected account actionable through the strict Action result', () => {
    const failure = buildConnectedServiceCredentialRefreshSpawnErrorResult({ agentId: 'claude', error: {
      name: 'ConnectedServiceSpawnCredentialRefreshError', kind: 'reconnect_required',
      serviceId: 'acme.agent/account', profileId: 'revoked',
    } });
    if (!failure) throw new Error('Expected credential failure');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(failure));
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }));
    expect(result).toMatchObject({ code: 'spawn_failed', retryable: false, launchError: {
      code: 'connected_service_credential_reconnect_required',
      message: expect.stringMatching(/reconnect/i),
      uxDiagnostic: { code: 'connected_service_credential_reconnect_required',
        serviceId: 'acme.agent/account', profileId: 'revoked', retryable: false },
    } });
  });
  it('preserves a safe Provider refusal through the daemon control producer and consumer', async () => {
    const failure = buildProviderSpawnErrorResult(createProviderErrorV1('provider_connection_invalid', {
      connectionId: 'pc_gateway', machineId: 'machine-a',
    }));
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(failure));
    expect(response.errorDetail).toEqual(failure.errorDetail);
    expect(normalizeSpawnSessionErrorDetail(response.errorDetail)).toEqual(failure.errorDetail);
    expect(SpawnSessionControlErrorResponseSchema.safeParse({
      ...response,
      errorDetail: { ...failure.errorDetail, secret: 'must-not-cross-control-transport' },
    }).success).toBe(false);
    const app = fastify().setSerializerCompiler(serializerCompiler);
    app.post('/spawn-session', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } },
      (_request, reply) => reply.code(500).send(projectSpawnSessionControlErrorResponse(failure)));
    try {
      const serialized = await app.inject({ method: 'POST', url: '/spawn-session' });
      expect(serialized.statusCode).toBe(500);
      expect(serialized.json()).toEqual(response);
    } finally {
      await app.close();
    }
  });

  it('preserves a typed launch cause through the daemon response and strict public creation result', () => {
    const cause = normalizeSpawnSessionErrorDetail({ kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE',
      message: 'Configured ACP catalog is unavailable: definition-required' });
    expect(cause).toEqual({ kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE',
      message: 'Configured ACP catalog is unavailable: definition-required' });
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
      errorCode: 'SPAWN_FAILED', errorMessage: 'Failed to spawn session', errorDetail: cause,
    }));
    expect(response.errorDetail).toEqual(cause);
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ launchError: cause });
  });

  it('keeps missing Agents typed and gives uncoded failures an explicit cause', () => {
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'agent_cli_missing',
      errorMessage: 'Install the selected Agent', agentId: 'custom-acp' }))).toEqual({
      type: 'error', code: 'agent_cli_missing', agentId: 'custom-acp', retryable: false });
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: '', errorMessage: 'Launch refused' })))
      .toMatchObject({ code: 'spawn_failed', launchError: { code: 'SPAWN_FAILED', message: 'Launch refused' } });
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'agent_cli_missing',
      agentId: 'custom-acp', retryable: false, launchError: { kind: 'launch_error', code: 'ENOENT', message: 'Missing' } }).success).toBe(false);
  });

  it('gives a signed-out Agent safe profile recovery through the strict creation result', () => {
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: 'agent_signed_out', agentId: 'custom-agent',
      errorMessage: 'upstream-private-auth-diagnostic',
    }));
    expect(result).toMatchObject({ type: 'error', code: 'agent_signed_out', agentId: 'custom-agent',
      retryable: false, launchError: { kind: 'launch_error', code: 'agent_signed_out' } });
    if (result.type !== 'error' || result.code !== 'agent_signed_out') throw new Error('Expected signed-out refusal');
    expect(result.launchError?.message).toMatch(/sign in/i);
    expect(result.launchError?.message).toMatch(/select.*connected account profile/i);
    expect(result.launchError?.message).toMatch(/configure.*default profile/i);
    expect(JSON.stringify(result)).not.toContain('upstream-private-auth-diagnostic');
  });
});
