import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { readCurrentAccountMachinePreparationCleanupHost } from './resolveCurrentAccountMachineTarget';

afterEach(() => vi.restoreAllMocks());

function response(data: unknown, status = 200): AxiosResponse<unknown> {
  return { status, data, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } };
}

it('reads only original Machine facts through the admitted requester and classifies permanent unavailability before offline', async () => {
  const keys = nacl.sign.keyPair();
  const target = { kind: 'machine' as const, machineId: 'installed-custodian' };
  const envelope = { v: 1 as const, requestId: 'original-archive', target,
    input: { homeId: 'srv_archive', id: 'preset', expectedRevision: 7 } };
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-requester-proof', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'srv_archive',
    machineId: target.machineId, custodianAccountId: 'different-machine-owner', installationId: 'installed-custodian-key',
    actionId: 'machines.presets.archive', requestId: envelope.requestId, target,
    presetPreparationAdmission: envelope.input, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    accountEncryptionMode: 'plain',
  } });
  const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root, target,
    serverId: 'requester-home', serverIdentityId: 'srv_archive', serverHttpBaseUrl: 'https://requester-home.test',
    installationId: root.binding.installationId, privateKey: keys.secretKey, rootAdmitted: true });
  if (!authorization) throw new Error('Expected the admitted requester HTTP projection');
  const originalId = 'original-prepare-host';
  const path = `/v1/machines/${originalId}`;
  const row = { id: originalId, managedMachineRef: null, active: false, revokedAt: null as number | null,
    replacedByMachineId: null as string | null };
  const get = vi.spyOn(axios, 'get');
  const input = { authorization, machineId: originalId, serverHttpBaseUrl: 'https://requester-home.test' };
  for (const [facts, expected] of [
    [{ ...row, revokedAt: 123 }, 'machine_revoked'],
    [{ ...row, replacedByMachineId: 'current-host' }, 'machine_replaced'],
    [row, undefined],
  ] as const) {
    // HTTP is the boundary; inventory parsing, canonical readiness and signing remain real.
    get.mockResolvedValue(response({ machine: facts }));
    expect(await readCurrentAccountMachinePreparationCleanupHost(input)).toEqual({
      host: expect.objectContaining({ id: originalId }), unavailable: expected });
    const [url, config] = get.mock.calls.at(-1)!;
    expect(url).toBe(`https://requester-home.test${path}`);
    expect(config?.headers).toMatchObject({ Accept: 'application/json;happier-machine-projection=host-facts' });
    expect(config?.headers).not.toHaveProperty('Authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: root.binding.actionId,
      target, installationId: root.binding.installationId, requestId: root.binding.requestId, method: 'GET', path,
      publicKey: keys.publicKey, signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
  }
  get.mockResolvedValue(response({ error: 'Machine not found' }, 404));
  expect(await readCurrentAccountMachinePreparationCleanupHost(input)).toEqual({ host: undefined, unavailable: undefined });
  const post = vi.spyOn(axios, 'post').mockResolvedValue(response({ results: [
    { machineId: originalId, status: 'found', machine: { ...row, revokedAt: 123,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
  ] }));
  expect(await readCurrentAccountMachinePreparationCleanupHost({ machineId: originalId,
    token: 'direct-requester', serverHttpBaseUrl: input.serverHttpBaseUrl })).toMatchObject({
      host: { id: originalId }, unavailable: 'machine_revoked' });
  expect(post).toHaveBeenCalledWith('https://requester-home.test/v1/machines/read-batch', { machineIds: [originalId] },
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer direct-requester' }) }));
  const abort = new AbortController();
  get.mockImplementation(async () => {
    abort.abort();
    return response({ machine: { ...row, revokedAt: 123 } });
  });
  await expect(readCurrentAccountMachinePreparationCleanupHost({ ...input, signal: abort.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
});
