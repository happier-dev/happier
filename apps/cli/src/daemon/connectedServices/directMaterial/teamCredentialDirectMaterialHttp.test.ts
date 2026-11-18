import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchTeamCredentialDirectMaterial,
  fetchTeamCredentialDirectMaterialPreparation,
  fetchTeamCredentialDirectMaterialCensus,
  withdrawTeamCredentialDirectMaterial,
  TeamCredentialDirectMaterialHttpContractError,
  TeamCredentialDirectMaterialHttpTransportError,
  fetchTeamCredentialNativeBinding,
} from './teamCredentialDirectMaterialHttp';
import tweetnacl from 'tweetnacl';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { computeTeamCredentialNativeBindingReadDigestV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { logger } from '@/ui/logger';

vi.mock('axios', () => ({ default: { defaults: {}, post: vi.fn(), delete: vi.fn(), get: vi.fn() } }));

describe('fetchTeamCredentialDirectMaterial', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.delete).mockReset();
  });

  it('never reinterprets an older direct response as native binding material', async () => {
    const body = { purpose: 'vendor_native_binding' as const, homeId: 'home', teamId: 'team', resourceId: 'resource',
      sessionId: 'session', managedId: 'managed', bindingKey: 'binding', expectedResourceRevision: 1,
      expectedSourceRevision: 'source', expectedProviderTicket: 'ticket', machineId: 'guest', installationId: 'installation' };
    const keys = tweetnacl.sign.keyPair();
    const proof = signMachineInstallationProof({ payload: { version: 1, accountId: 'account',
      machineId: body.machineId, installationId: body.installationId,
      nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(body) } }, privateKey: keys.secretKey });
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { status: 'unavailable', reason: 'preparing' } });
    await expect(fetchTeamCredentialNativeBinding({ token: 'token', request: { ...body, proof } }))
      .rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpContractError);
    const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      for (const status of [404, 503]) {
        vi.mocked(axios.post).mockResolvedValue({ status, data: { error: 'private binding response' } });
        await expect(fetchTeamCredentialNativeBinding({ token: 'token', request: { ...body, proof } }))
          .resolves.toEqual({ status: 'unavailable', reason: 'binding_unavailable' });
        expect(warn).toHaveBeenCalledWith(expect.any(String), { phase: 'providers.team_credential.native_binding_read', httpStatus: status });
      }
      vi.mocked(axios.post).mockRejectedValueOnce(Object.assign(new Error('private binding transport fixture'), { code: 'ECONNRESET' }));
      await expect(fetchTeamCredentialNativeBinding({ token: 'token', request: { ...body, proof } }))
        .rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpTransportError);
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        phase: 'providers.team_credential.native_binding_read', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private binding transport fixture');
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['preparation', 'census', 'withdraw_request', 'withdraw_response'] as const)(
    'uses the existing typed contract failure at the %s boundary', async phase => {
      vi.mocked(axios.get).mockResolvedValue({ data: {} });
      vi.mocked(axios.delete).mockResolvedValue({ data: {} });
      const params = { token: 'fixture-token', teamId: 'team', resourceId: 'resource' };
      const result = phase === 'preparation'
        ? fetchTeamCredentialDirectMaterialPreparation({ ...params, sourceMemberKey: 'member' })
        : phase === 'census'
          ? fetchTeamCredentialDirectMaterialCensus(params)
          : withdrawTeamCredentialDirectMaterial({ ...params, body: {
              sourceMemberKey: phase === 'withdraw_request' ? '' : 'member',
              expectedResourceRevision: 1, expectedPublishedSourceVersion: 'source-v1',
            } });
      await expect(result).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpContractError);
      expect(vi.mocked(axios.delete)).toHaveBeenCalledTimes(phase === 'withdraw_response' ? 1 : 0);
    },
  );

  it('accepts slow valid direct material within its caller lifetime and propagates cancellation', async () => {
    vi.useFakeTimers();
    try {
      // Axios is the network boundary: reproduce its configured timeout and signal behavior.
      vi.mocked(axios.post).mockImplementation((_url, _body, config) => new Promise((resolve, reject) => {
        const finish = setTimeout(() => resolve({ status: 200, data: { status: 'unavailable', reason: 'preparing' } }), 20_000);
        const cutoff = config?.timeout ? setTimeout(() => {
          clearTimeout(finish);
          reject(new Error('Axios timeout'));
        }, config.timeout) : undefined;
        config?.signal?.addEventListener?.('abort', () => {
          clearTimeout(finish);
          if (cutoff !== undefined) clearTimeout(cutoff);
          reject(new Error('Axios canceled'));
        });
      }));
      const controller = new AbortController();
      const input = {
        token: 'token', teamId: 'team', resourceId: 'resource', signal: controller.signal,
        request: { resourceId: 'resource', consumer: { kind: 'session' as const, sessionId: 'session-1' },
          slot: { kind: 'provider_model' as const }, sourceMemberKey: 'member-1' },
      };
      const slow = fetchTeamCredentialDirectMaterial(input).then((value) => value, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await slow).toEqual({ status: 'unavailable', reason: 'preparing' });
      const canceled = fetchTeamCredentialDirectMaterial(input).then((value) => value, (error: unknown) => error);
      controller.abort();
      expect(await canceled).toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws only the exact captured publication through the authenticated material route', async () => {
    vi.mocked(axios.delete).mockResolvedValue({ data: { status: 'withdrawn' } });
    const body = { sourceMemberKey: 'member', expectedResourceRevision: 4, expectedPublishedSourceVersion: 'source-v1' };
    await expect(withdrawTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource', body,
    })).resolves.toEqual({ status: 'withdrawn' });
    expect(vi.mocked(axios.delete).mock.calls[0]).toEqual([
      expect.stringContaining('/v2/teams/team/credential-resources/resource/direct-material'),
      expect.objectContaining({ headers: { Authorization: 'Bearer token' }, data: body }),
    ]);
  });

  it('fetches and strictly parses the authenticated recipient projection', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: {
      status: 'unavailable',
      reason: 'preparing',
    } });
    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token',
      teamId: 'team',
      resourceId: 'resource',
      request: {
        resourceId: 'resource',
        consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'connected_service_purpose', purpose: {
          consumer: { pluginId: 'plugin.acme', localId: 'agent' }, purpose: 'runtime',
        } },
        disclosedMember: { service: { pluginId: 'plugin.acme', localId: 'service' }, accountId: 'account' },
      },
    })).resolves.toEqual({ status: 'unavailable', reason: 'preparing' });
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain(
      '/v2/teams/team/credential-resources/resource/direct-material',
    );
    expect(vi.mocked(axios.post).mock.calls[0]?.[2]).toMatchObject({
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('rejects a non-protocol response', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { status: 'ready', stored: { secret: true } } });
    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource',
      request: {
        resourceId: 'resource',
        consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'connected_service_purpose', purpose: {
          consumer: { pluginId: 'plugin.acme', localId: 'agent' }, purpose: 'runtime',
        } },
        disclosedMember: { service: { pluginId: 'plugin.acme', localId: 'service' }, accountId: 'account' },
      },
    })).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpContractError);
  });

  it('rejects an invalid request before issuing HTTP', async () => {
    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource',
      request: {
        resourceId: '',
        consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'provider_model' },
        sourceMemberKey: 'member-1',
      },
    })).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpContractError);
    expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'team_authentication_required'],
    [503, 'team_authentication_policy_unavailable'],
  ] as const)('strictly preserves a canonical HTTP %s operation error', async (status, error) => {
    vi.mocked(axios.post).mockResolvedValue({ status, data: { error } });

    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource',
      request: {
        resourceId: 'resource',
        consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'connected_service_purpose', purpose: {
          consumer: { pluginId: 'plugin.acme', localId: 'agent' }, purpose: 'runtime',
        } },
        disclosedMember: { service: { pluginId: 'plugin.acme', localId: 'service' }, accountId: 'account' },
      },
    })).resolves.toEqual({ status: 'operation_error', error: { error } });
    expect(vi.mocked(axios.post).mock.calls[0]?.[2]).toMatchObject({
      validateStatus: expect.any(Function),
    });
  });

  it.each([
    { error: 'not_a_team_error' },
    { error: 'team_authentication_required', secret: 'must-not-cross-the-boundary' },
  ])('rejects a malformed non-success response instead of inventing or leaking a domain error', async (body) => {
    vi.mocked(axios.post).mockResolvedValue({ status: 503, data: body });

    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource',
      request: {
        resourceId: 'resource',
        consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'provider_model' },
        sourceMemberKey: 'member-1',
      },
    })).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpContractError);
  });

  it('classifies an Axios rejection without a response as transport failure', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('socket closed'));
    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource',
      request: {
        resourceId: 'resource', consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'provider_model' }, sourceMemberKey: 'member-1',
      },
    })).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpTransportError);
  });

  it('retains a sanitized phase and cause for a recipient material transport failure', async () => {
    const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    vi.mocked(axios.post).mockRejectedValueOnce(Object.assign(new Error('private direct material fixture'), { code: 'ECONNRESET' }));
    try {
      await expect(fetchTeamCredentialDirectMaterial({ token: 'token', teamId: 'team', resourceId: 'resource', request: {
        resourceId: 'resource', consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'provider_model' }, sourceMemberKey: 'member-1',
      } })).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpTransportError);
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        phase: 'providers.team_credential.direct_material_read', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private direct material fixture');
    } finally { warn.mockRestore(); }
  });

  it('preserves abort during Axios instead of classifying it as transport failure', async () => {
    const controller = new AbortController();
    vi.mocked(axios.post).mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(fetchTeamCredentialDirectMaterial({
      token: 'token', teamId: 'team', resourceId: 'resource', signal: controller.signal,
      request: {
        resourceId: 'resource', consumer: { kind: 'session', sessionId: 'session-1' },
        slot: { kind: 'provider_model' }, sourceMemberKey: 'member-1',
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
