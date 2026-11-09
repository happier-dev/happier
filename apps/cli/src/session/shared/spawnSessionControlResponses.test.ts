import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { resolveRequesterLaunchAdmissionFailure } from '@/daemon/lifecycle/requesterWorkAttribution';
import { resolveSessionAutoResumeAdmissionV1, readSessionAutoResumeRefusalV1, writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import {
  projectSpawnSessionControlErrorResponse,
  projectSessionRunnerLaunchAdmissionFailure,
  SpawnSessionControlBadRequestSchema,
  SpawnSessionControlErrorResponseSchema,
  SpawnSessionNonceControlResponseSchema,
} from './spawnSessionContract';

describe('daemon spawn control response serialization', () => {
  it('preserves canonical person-hold refusal through HTTP and nonce settlement', async () => {
    const reason = resolveSessionAutoResumeAdmissionV1({
      metadata: writeSessionExplicitStopV1ToMetadata({}, { v: 1, cause: 'explicit_stop', requestId: 'held', requestedAtMs: 1 }),
      authorityAvailable: true, machineAvailable: true,
    });
    const failure = projectSessionRunnerLaunchAdmissionFailure({ kind: 'launch_error', code: reason, message: 'Automatic Session resume refused' });
    if (!failure) throw new Error('Expected a refused launch');
    const app = fastify();
    app.setSerializerCompiler(serializerCompiler);
    app.get('/failure', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } }, async (_request, reply) => {
      reply.code(500);
      return projectSpawnSessionControlErrorResponse(failure);
    });
    app.get('/resolution', { schema: { response: { 200: SpawnSessionNonceControlResponseSchema } } }, async () => ({
      success: true, status: 'error', errorCode: failure.errorCode, errorMessage: failure.errorMessage, errorDetail: failure.errorDetail,
    }));
    try {
      const response = await app.inject({ method: 'GET', url: '/failure' });
      expect(response.json()).toMatchObject({ errorCode: 'SPAWN_VALIDATION_FAILED' });
      expect(readSessionAutoResumeRefusalV1(response.json().errorDetail)).toBe('held_by_person');
      const resolution = normalizeSpawnSessionNonceResolution((await app.inject({ method: 'GET', url: '/resolution' })).json());
      expect(resolution.status).toBe('error');
      expect(readSessionAutoResumeRefusalV1(resolution.status === 'error' ? resolution.errorDetail : undefined)).toBe('held_by_person');
    } finally { await app.close(); }
  });
  it('carries unavailable requester evidence from the real producer through HTTP and nonce settlement', async () => {
    const failure = await resolveRequesterLaunchAdmissionFailure({ verifyRequesterMachineAdmissionCurrent: async () => {
      throw Object.assign(new Error('Home unavailable'), { response: { status: 503 } });
    } });
    if (!failure) throw new Error('Expected unavailable requester evidence');
    const app = fastify();
    app.setSerializerCompiler(serializerCompiler);
    app.get('/failure', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } }, async (_request, reply) => {
      reply.code(500);
      return projectSpawnSessionControlErrorResponse(failure);
    });
    app.get('/resolution', { schema: { response: { 200: SpawnSessionNonceControlResponseSchema } } }, async () => ({
      success: true, status: 'error', errorCode: failure.errorCode, errorMessage: failure.errorMessage,
      errorDetail: failure.errorDetail,
    }));
    try {
      const response = await app.inject({ method: 'GET', url: '/failure' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ errorCode: 'DAEMON_RPC_UNAVAILABLE',
        errorDetail: { kind: 'requester_home_unavailable' } });
      const resolution = await app.inject({ method: 'GET', url: '/resolution' });
      expect(normalizeSpawnSessionNonceResolution(resolution.json())).toMatchObject({ status: 'error',
        errorCode: 'DAEMON_RPC_UNAVAILABLE', errorDetail: { kind: 'requester_home_unavailable' } });
    } finally { await app.close(); }
  });

  it('keeps ordinary spawn failures compatible without Agent identity', async () => {
    const app = fastify();
    app.setSerializerCompiler(serializerCompiler);
    app.get('/failure', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } }, async (_request, reply) => {
      reply.code(500);
      return projectSpawnSessionControlErrorResponse({ errorCode: 'SPAWN_FAILED', errorMessage: 'Spawn failed.' });
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/failure' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ success: false, errorCode: 'SPAWN_FAILED', error: 'Spawn failed.' });
    } finally {
      await app.close();
    }
  });

  it.each(['agent_cli_missing', 'agent_signed_out'] as const)('retains %s identity through the real failure projection and HTTP serializer', async (errorCode) => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const error = { errorCode, errorMessage: 'Codex requires setup.', agentId: 'codex' };
    const payload = projectSpawnSessionControlErrorResponse(error);
    app.get<{ Querystring: { status?: string } }>('/failure', {
      schema: { response: { 400: SpawnSessionControlBadRequestSchema, 500: SpawnSessionControlErrorResponseSchema } },
    }, async (request, reply) => {
      reply.code(request.query.status === '400' ? 400 : 500);
      return payload;
    });
    try {
      for (const statusCode of [400, 500]) {
        const response = await app.inject({ method: 'GET', url: `/failure?status=${statusCode}` });
        expect(response.statusCode).toBe(statusCode);
        expect(response.json()).toEqual({ success: false, error: error.errorMessage, errorCode, agentId: 'codex' });
      }
    } finally {
      await app.close();
    }
  });

  it.each(['agent_cli_missing', 'agent_signed_out'] as const)('retains %s identity when serialized nonce resolution reaches the canonical reader', async (errorCode) => {
    const app = fastify();
    app.setSerializerCompiler(serializerCompiler);
    const resolution = {
      success: true as const, status: 'error' as const, errorCode,
      errorMessage: 'Codex requires setup.', agentId: 'codex',
    };
    app.get('/resolution', { schema: { response: { 200: SpawnSessionNonceControlResponseSchema } } }, async () => resolution);
    try {
      const response = await app.inject({ method: 'GET', url: '/resolution' });
      expect(response.statusCode).toBe(200);
      expect(normalizeSpawnSessionNonceResolution(response.json())).toEqual({
        status: 'error', errorCode, errorMessage: resolution.errorMessage, agentId: 'codex',
      });
    } finally {
      await app.close();
    }
  });
});
