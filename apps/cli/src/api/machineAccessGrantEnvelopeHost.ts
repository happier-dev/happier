import axios from 'axios';
import { setImmediate } from 'node:timers/promises';
import { MachineAccessRecipientCensusResponseV1Schema, MachineAccessRefusalV1Schema, MachineRecipientKeyEnvelopeCommitInputV1Schema, MachineRecipientKeyEnvelopeCommitResponseV1Schema, type MachineAccessRecipientCensusResponseV1, type MachineKeyPreparationResultV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineDataKeyPreparationErrorV1, prepareMachineDataKeyEnvelopesV1 } from '@happier-dev/protocol/machines/prepareMachineDataKeyEnvelopesV1';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { getRandomBytes } from '@/api/encryption';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { resolvePublishedMachineEncryptionContext } from '@/api/machine/machineDataEncryptionKey';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { Machine } from '@/api/types';

export type PrepareMachineAccessKeyEnvelopesParams = Readonly<{
  credentials: StoredCredentials | undefined;
  serverHttpBaseUrl: string;
  serverId: string;
  machineId: string;
  serverIdentityId?: string;
  signal?: AbortSignal;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  requestHeaders?: (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /** The canonical Machine lifecycle supplies proven transferable material; never an Action input. */
  resolveTransferableMachineDataKey?: (page: MachineAccessRecipientCensusResponseV1) => Promise<Uint8Array | null>;
}>;

export async function prepareMachineAccessKeyEnvelopes(
  params: PrepareMachineAccessKeyEnvelopesParams,
): Promise<MachineKeyPreparationResultV1> {
  const credentials = params.credentials;
  const accountId = credentials ? readAccountIdFromToken(credentials.token) : null;
  let current = true;
  let custodianKey: Machine | null = null;
  const assertCurrent = async () => {
    current = !params.signal?.aborted && (await params.isCredentialCurrent?.()) !== false;
    if (!current) throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
  };
  const path = `/v1/machines/${encodeURIComponent(params.machineId)}/data-key-envelopes`;
  const options = async (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) => {
    await assertCurrent();
    const headers = {
      ...(params.credentials?.token ? { Authorization: `Bearer ${params.credentials.token}` } : {}),
      'Content-Type': 'application/json',
      ...await params.requestHeaders?.(request),
    };
    await assertCurrent();
    return { headers, timeout: configuration.sessionControlHttpTimeoutMs, signal: params.signal, validateStatus: () => true };
  };
  const readResponse = async (response: Readonly<{ status: number; data: unknown }>) => {
    await assertCurrent();
    const refusal = MachineAccessRefusalV1Schema.safeParse(response.data);
    if (refusal.success) throw new MachineDataKeyPreparationErrorV1(refusal.data.code);
    if (response.status === 401 || response.status === 403) throw new MachineDataKeyPreparationErrorV1('access_denied');
    if (response.status === 404 || response.status === 405 || response.status === 501) throw new MachineDataKeyPreparationErrorV1('unsupported_operation');
    if (response.status !== 200) throw new MachineDataKeyPreparationErrorV1('machine_unavailable');
    return response.data;
  };
  return prepareMachineDataKeyEnvelopesV1({
    machineId: params.machineId,
    ...(!params.resolveTransferableMachineDataKey && credentials?.encryption && accountId ? {
      ownerPreparation: {
        accountId,
        observeMachine: async () => {
          const machinePath = `/v1/machines/${encodeURIComponent(params.machineId)}`;
          const payload = await readResponse(await axios.get<unknown>(`${params.serverHttpBaseUrl}${machinePath}`, await options({ method: 'GET', path: machinePath })));
          if (!payload || typeof payload !== 'object' || !('machine' in payload)) throw new MachineDataKeyPreparationErrorV1('machine_unavailable');
          return payload.machine;
        },
        prepareContentKey: async () => {
          const { ApiClient } = await import('@/api/api');
          await assertCurrent();
          const client = await ApiClient.create(credentials);
          custodianKey = await client.prepareMachineContentKey(params.machineId, {
            signal: params.signal, isCurrent: async () => { await assertCurrent(); return current; },
            request: async request => {
              const requestOptions = { ...await options(request), signal: request.signal };
              const response = request.method === 'GET'
                ? await axios.get<unknown>(`${params.serverHttpBaseUrl}${request.path}`, requestOptions)
                : await axios.post<unknown>(`${params.serverHttpBaseUrl}${request.path}`, request.body, requestOptions);
              await assertCurrent();
              return response;
            },
          });
        },
      },
    } : {}),
    transport: {
      fetchPage: async cursor => {
        const query = new URLSearchParams({ state: 'action_required' });
        if (cursor) query.set('cursor', cursor);
        const pagePath = `${path}?${query.toString()}`;
        const response = await axios.get<unknown>(`${params.serverHttpBaseUrl}${pagePath}`, await options({ method: 'GET', path: pagePath }));
        return MachineAccessRecipientCensusResponseV1Schema.parse(await readResponse(response));
      },
      patchPage: async request => {
        const { machineId: _machineId, ...body } = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse(request);
        const response = await axios.patch<unknown>(`${params.serverHttpBaseUrl}${path}`, body, await options({ method: 'PATCH', path, body }));
        return MachineRecipientKeyEnvelopeCommitResponseV1Schema.parse(await readResponse(response));
      },
    },
    resolveTransferableDataKey: async page => {
      await assertCurrent();
      let key = await params.resolveTransferableMachineDataKey?.(page) ?? null;
      if (custodianKey?.encryptionMode === 'e2ee' && custodianKey.encryptionVariant === 'dataKey') {
        const basis = custodianKey.keyBasis;
        if (!basis?.dataEncryptionKey || basis.dataEncryptionKey !== custodianKey.dataEncryptionKey
          || basis.metadataVersion !== page.content.metadataVersion || basis.daemonStateVersion !== page.content.daemonStateVersion
          || page.callerDataEncryptionKey !== basis.dataEncryptionKey
          || computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(basis.dataEncryptionKey)) !== page.machineOwnerEnvelopeFingerprint) {
          throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
        }
        key = custodianKey.encryptionKey;
      }
      if (!params.resolveTransferableMachineDataKey && params.credentials && accountId
        && accountId !== page.custodianAccountId) {
        // This manager-only worklist proved permission and the current caller tuple. A foreign
        // recipient tuple can only be committed after owner preparation; it is not an owner
        // envelope and never permits the historical Account-key fallback.
        const context = resolvePublishedMachineEncryptionContext({
          credentials: params.credentials, machineId: page.machineId, expectedAccountMode: page.encryptionMode,
          publishedDataEncryptionKey: page.callerDataEncryptionKey,
          access: { custodian: { accountId: page.custodianAccountId, displayName: '' }, role: 'manage', resourceMode: page.encryptionMode, accessState: 'ready' },
        });
        if (context.encryptionMode === 'e2ee' && context.encryptionVariant === 'dataKey') key = context.encryptionKey;
      }
      await assertCurrent();
      return key;
    },
    decodeStoredContent: async (key, content) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey' }).decodeStored(content),
    isScopeCurrent: () => current && !params.signal?.aborted,
    randomBytes: getRandomBytes,
    mapRecipients: async (items, prepare) => {
      const prepared = [];
      for (const item of items) {
        await assertCurrent();
        prepared.push(prepare(item));
        await setImmediate();
      }
      return prepared;
    },
  });
}
