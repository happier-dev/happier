import { describe, expect, it } from 'vitest';

import {
  ExternalSessionTakeoverPersistRequestSchema,
  ExternalSessionTakeoverPersistResponseSchema,
  ExternalSessionTakeoverRequestSchema,
  ExternalSessionTakeoverResponseSchema,
} from './legacyDirectSessionWireSchemasV1';
import { ExternalSessionsRpcErrorCodeSchema } from './rpcErrorCodes';
import * as externalSessions from './index';

describe('legacy direct-session takeover wire schemas', () => {
  it('preserves the deployed request and response parse behavior after relocation', () => {
    const request = {
      machineId: 'machine-1',
      sessionId: 'session-1',
      forceStop: true,
      futureField: 'preserved',
    };
    expect(ExternalSessionTakeoverRequestSchema.parse(request)).toEqual(request);
    expect(ExternalSessionTakeoverPersistRequestSchema.parse(request)).toEqual(request);
    expect(ExternalSessionTakeoverRequestSchema.safeParse({ ...request, machineId: '' }).success).toBe(false);
    expect(ExternalSessionTakeoverPersistRequestSchema.safeParse({ ...request, forceStop: 'yes' }).success).toBe(false);

    expect(ExternalSessionTakeoverResponseSchema.parse({ ok: true, futureField: 'preserved' })).toEqual({
      ok: true,
      futureField: 'preserved',
    });
    expect(ExternalSessionTakeoverPersistResponseSchema.parse({
      ok: true,
      converted: true,
      futureField: 'preserved',
    })).toEqual({ ok: true, converted: true, futureField: 'preserved' });

    for (const errorCode of ExternalSessionsRpcErrorCodeSchema.options) {
      const failure = { ok: false, errorCode, error: `legacy ${errorCode}` };
      expect(ExternalSessionTakeoverResponseSchema.parse(failure)).toEqual(failure);
      expect(ExternalSessionTakeoverPersistResponseSchema.parse(failure)).toEqual(failure);
    }
    expect(ExternalSessionTakeoverResponseSchema.safeParse({
      ok: false,
      errorCode: 'unknown_error',
      error: 'unknown',
    }).success).toBe(false);
    expect(ExternalSessionTakeoverPersistResponseSchema.safeParse({
      ok: false,
      errorCode: 'internal_error',
      error: '',
    }).success).toBe(false);
  });

  it('keeps the shared RPC error vocabulary exact', () => {
    expect(ExternalSessionsRpcErrorCodeSchema.options).toEqual([
      'invalid_request',
      'machine_offline',
      'agent_unavailable',
      'internal_error',
    ]);
    expect(ExternalSessionsRpcErrorCodeSchema.safeParse('provider_unavailable').success).toBe(false);
    expect(externalSessions.ExternalSessionsRpcErrorCodeSchema).toBe(ExternalSessionsRpcErrorCodeSchema);
    expect(externalSessions.ExternalSessionTakeoverRequestSchema).toBe(ExternalSessionTakeoverRequestSchema);
  });
});
