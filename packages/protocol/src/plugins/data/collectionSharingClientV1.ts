import { PluginCollectionSharingClientErrorV1 } from './collectionSharingClientErrorV1.js';
export { PluginCollectionSharingClientErrorV1 } from './collectionSharingClientErrorV1.js';
import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import type { PrincipalRefV1 } from '../../teams/principal.js';
import { prepareResourceRecipientKeyEnvelopesV1, runResourceRecipientKeyPreparationV1 } from '../../teams/resourceRecipientKeyPreparationV1.js';
import { decodePluginCollectionLogicalRowV1, encodePluginCollectionLogicalValueV1,
  type PluginCollectionLogicalValueV1 } from './collectionLogicalCodecV1.js';
import { PluginCollectionRowIdV1Schema, type NormalizedPluginAccountCollectionContractV1 } from './collectionsV1.js';
import {
  PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as paths,
  PluginCollectionSharingCensusResponseV1Schema, PluginCollectionSharingCommitKeysResponseV1Schema, PluginCollectionSharingErrorV1Schema,
  PluginCollectionSharingGrantsResponseV1Schema, PluginCollectionSharingListResponseV1Schema,
  PluginCollectionSharingMutationResponseV1Schema, PluginCollectionSharingResourceV1Schema,
  type PluginCollectionSharingAddressV1, type PluginCollectionSharingResourceV1,
  type PluginCollectionSharingSetGrantRequestV1, type PluginCollectionSharingListRequestV1,
} from './collectionSharingV1.js';

type OperationKind = 'read' | 'mutation';
type OperationOutcome = 'refused' | 'failed' | 'uncertain';
type OperationRefusal = ReturnType<typeof PluginCollectionSharingErrorV1Schema.parse>;


/** Transport and key custody belong to each realm; logical sharing has one owner. */
export type PluginCollectionSharingClientOptionsV1<TValue extends PluginCollectionLogicalValueV1> = Readonly<{
  accountId: string;
  contract: NormalizedPluginAccountCollectionContractV1;
  isValidLogicalValue: (value: PluginCollectionLogicalValueV1) => value is TValue;
  parseStoredLogicalValue: (value: PluginCollectionLogicalValueV1) => TValue | null;
  requireCurrent: () => void | Promise<void>;
  request: (path: string, body: unknown, options: Readonly<{ kind: OperationKind }>) => Promise<Readonly<{ status: number; body: unknown }>>;
  crypto: Readonly<{
    accountMaterial: AccountScopedCryptoMaterial | null;
    randomBytes: (length: number) => Uint8Array;
    openKey: (envelope: string) => Promise<Uint8Array | null>;
  }>;
  createError?: (code: string, outcome: OperationOutcome, details?: OperationRefusal) => Error;
  /** A realm error already classified by its canonical transport is not reinterpreted. */
  isTypedError?: (error: unknown) => boolean;
}>;

export function createPluginCollectionSharingClientV1<TValue extends PluginCollectionLogicalValueV1>(
  options: PluginCollectionSharingClientOptionsV1<TValue>,
) {
  const error = (code: string, outcome: OperationOutcome = 'refused', details?: OperationRefusal) =>
    options.createError?.(code, outcome, details) ?? new PluginCollectionSharingClientErrorV1(code, outcome, details);
  const contract = options.contract;
  const identity = { pluginId: contract.pluginId, collectionId: contract.collectionId };
  const contractRef = { ...identity, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
  const address = (ownerAccountId: string, rowId: string) => ({ ...identity, ownerAccountId, rowId });
  const validateIdentity = (value: PluginCollectionSharingAddressV1, expected?: Readonly<{ ownerAccountId: string; rowId: string }>) => {
    if (value.pluginId !== identity.pluginId || value.collectionId !== identity.collectionId
      || (expected && (value.ownerAccountId !== expected.ownerAccountId || value.rowId !== expected.rowId))) {
      throw error('collection_content_unavailable', 'failed');
    }
  };
  const parse = <T>(schema: Readonly<{ parse: (value: unknown) => T }>, body: unknown, kind: OperationKind = 'read'): T => {
    try { return schema.parse(body); }
    catch { throw error('collection_content_unavailable', kind === 'mutation' ? 'uncertain' : 'failed'); }
  };
  const request = async (path: string, body: unknown, kind: OperationKind = 'read') => {
    await options.requireCurrent();
    let response: Awaited<ReturnType<typeof options.request>>;
    try { response = await options.request(path, body, { kind }); }
    catch (cause) {
      if (cause instanceof PluginCollectionSharingClientErrorV1 || options.isTypedError?.(cause)) throw cause;
      const code = cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
        ? cause.code : 'collection_unavailable';
      throw error(code, kind === 'mutation' ? 'uncertain' : 'failed');
    }
    if (kind === 'read') await options.requireCurrent();
    if (response.status < 200 || response.status >= 300) {
      const refusal = PluginCollectionSharingErrorV1Schema.safeParse(response.body);
      if (refusal.success) throw error(refusal.data.error, 'refused', refusal.data);
      throw error('collection_unavailable', kind === 'mutation' ? 'uncertain' : 'failed');
    }
    return response.body;
  };
  const open = async (resource: PluginCollectionSharingResourceV1, checkCurrent = true) => {
    validateIdentity(resource);
    if (resource.row.rowId !== resource.rowId) throw error('collection_content_unavailable', 'failed');
    let dataKey: Uint8Array | null = null;
    if (resource.encryptionMode === 'plain') {
      if (resource.row.content.t !== 'plain' || resource.encryptedDataKey !== null) throw error('collection_content_mode_mismatch');
    } else if (resource.row.content.t !== 'encrypted') throw error('collection_content_mode_mismatch');
    else if (resource.row.content.k === 'collection') {
      if (!resource.encryptedDataKey) throw error('collection_content_unavailable');
      try { dataKey = await options.crypto.openKey(resource.encryptedDataKey); }
      catch { throw error('collection_content_unavailable'); }
      if (dataKey?.length !== ENCRYPTED_DATA_KEY_V1_BYTES) throw error('collection_content_unavailable');
    } else if (resource.ownerAccountId !== options.accountId || resource.encryptedDataKey !== null) {
      throw error('collection_content_mode_mismatch');
    }
    const decoded = decodePluginCollectionLogicalRowV1({ contract, row: resource.row,
      encryptionMode: resource.encryptionMode, material: options.crypto.accountMaterial,
      ...(dataKey ? { resourceDataKey: dataKey } : {}), parseStoredLogicalValue: options.parseStoredLogicalValue });
    if (decoded.status !== 'decoded') throw error('collection_content_unavailable');
    if (checkCurrent) await options.requireCurrent();
    return { resource, dataKey, logical: { ownerAccountId: resource.ownerAccountId, access: resource.access,
      rowId: decoded.rowId, revision: decoded.revision, value: decoded.value } };
  };
  /**
   * Keyholder-read repair (the Artifact pattern): an editor who holds the row key seals it for every
   * recipient the live census still owes, such as a member who joined the Team after the share.
   * View-only readers cannot commit keys, so they skip it. A failed repair never fails the read.
   */
  const prepareRecipients = async (opened: Awaited<ReturnType<typeof open>>) => {
    const { resource, dataKey } = opened;
    if (!dataKey || resource.encryptionMode !== 'e2ee' || resource.access === 'view') return;
    const target = address(resource.ownerAccountId, resource.rowId);
    try {
      await runResourceRecipientKeyPreparationV1({ dataKey, openedDataEncryptionKey: resource.encryptedDataKey,
        randomBytes: options.crypto.randomBytes,
        readCensus: async () => parse(PluginCollectionSharingCensusResponseV1Schema, await request(paths.census, target)),
        validateIdentity: census => validateIdentity(census, target),
        dataKeyChangedError: () => error('collection_revision_conflict'),
        commit: async body => parse(PluginCollectionSharingCommitKeysResponseV1Schema,
          await request(paths.commitKeys, { ...target, ...body }, 'mutation'), 'mutation'),
      });
    } catch { /* Retried on the next keyholder read. */ }
  };
  const read = async (input: Readonly<{ ownerAccountId: string; rowId: string }>) => {
    const resource = parse(PluginCollectionSharingResourceV1Schema,
      await request(paths.get, { ...address(input.ownerAccountId, input.rowId), readerContext: contractRef }));
    validateIdentity(resource, input);
    return open(resource);
  };
  const encode = (value: TValue, current: Readonly<{ resource: PluginCollectionSharingResourceV1; dataKey: Uint8Array | null }>) => {
    const encoded = encodePluginCollectionLogicalValueV1({ contract, value, isValidLogicalValue: options.isValidLogicalValue,
      encryptionMode: current.resource.encryptionMode, material: options.crypto.accountMaterial,
      ...(current.dataKey ? { resourceDataKey: current.dataKey } : {}), randomBytes: options.crypto.randomBytes });
    if (encoded.status !== 'encoded') throw error('collection_content_unavailable');
    return encoded;
  };
  return {
    get: async (input: Readonly<{ ownerAccountId: string; rowId: string }>) => {
      const opened = await read(input);
      await prepareRecipients(opened);
      return opened.logical;
    },
    put: async (input: Readonly<{ ownerAccountId: string; value: TValue; expectedRevision: number }>) => {
      const rowId = parse(PluginCollectionRowIdV1Schema, input.value[contract.rowIdField]);
      const target = address(input.ownerAccountId, rowId);
      const current = await read(target);
      const encoded = encode(input.value, current);
      const resource = parse(PluginCollectionSharingResourceV1Schema, await request(paths.put, { ...target,
        writerContext: contractRef, expectedRevision: input.expectedRevision, content: encoded.content, projection: encoded.projection }, 'mutation'), 'mutation');
      validateIdentity(resource, target);
      return (await open(resource, false)).logical;
    },
    sharedWithMe: async (input: Readonly<Pick<PluginCollectionSharingListRequestV1, 'cursor' | 'limit' | 'sharedWithTeamId'>> = {}) => {
      const result = parse(PluginCollectionSharingListResponseV1Schema,
        await request(paths.sharedWithMe, { ...identity, readerContext: contractRef,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.sharedWithTeamId === undefined ? {} : { sharedWithTeamId: input.sharedWithTeamId }) }));
      const rows = await Promise.all(result.resources.map(async resource => {
        const opened = await open(resource);
        await prepareRecipients(opened);
        return opened.logical;
      }));
      return { rows, ...(result.nextCursor === null ? {} : { nextCursor: result.nextCursor }) };
    },
    listGrants: async (rowId: string) => {
      const target = address(options.accountId, rowId);
      const result = parse(PluginCollectionSharingGrantsResponseV1Schema, await request(paths.grants, target));
      validateIdentity(result, target);
      return { ownerAccountId: result.ownerAccountId, access: result.access, grants: result.grants };
    },
    revokeGrant: async (rowId: string, input: Readonly<{ principal: PrincipalRefV1 }>) =>
      parse(PluginCollectionSharingMutationResponseV1Schema,
        await request(paths.revokeGrant, { ...address(options.accountId, rowId), principal: input.principal }, 'mutation'), 'mutation'),
    setGrant: async (rowId: string, input: Readonly<{ principal: PrincipalRefV1; accessLevel: 'view' | 'edit'; expectedRevision: number }>) => {
      const target = address(options.accountId, rowId);
      const current = await read(target);
      const body: PluginCollectionSharingSetGrantRequestV1 = { ...target, principal: input.principal,
        accessLevel: input.accessLevel, expectedRevision: input.expectedRevision };
      if (current.resource.encryptionMode === 'e2ee') {
        const census = parse(PluginCollectionSharingCensusResponseV1Schema,
          await request(paths.census, { ...target, principal: input.principal }));
        validateIdentity(census, target);
        const dataKey = current.dataKey ?? options.crypto.randomBytes(ENCRYPTED_DATA_KEY_V1_BYTES);
        const prepared = prepareResourceRecipientKeyEnvelopesV1({ dataKey, recipients: census.recipients,
          randomBytes: options.crypto.randomBytes, replaceExisting: !current.dataKey });
        if (current.dataKey) body.recipientKeyEnvelopes = prepared;
        else {
          const ownerKeyEnvelope = prepared.find(item => item.recipientAccountId === options.accountId);
          if (!ownerKeyEnvelope) throw error('collection_content_unavailable');
          const encoded = encode(current.logical.value, { resource: current.resource, dataKey });
          body.promotion = { expectedRevision: input.expectedRevision, content: encoded.content, ownerKeyEnvelope,
            recipientKeyEnvelopes: prepared.filter(item => item.recipientAccountId !== options.accountId) };
        }
      }
      return parse(PluginCollectionSharingMutationResponseV1Schema, await request(paths.setGrant, body, 'mutation'), 'mutation');
    },
  };
}
