import { describe, expect, it } from 'vitest';

import {
  decodePluginCollectionLogicalRowV1,
  encodePluginCollectionLogicalValueV1,
  preparePluginCollectionLogicalMutationRequestV1,
  type PluginCollectionLogicalValueV1,
} from './collectionLogicalCodecV1.js';
import {
  measurePluginCollectionMutationRequestDecompositionV1,
  measurePluginCollectionMutationRequestEncodedBytesV1,
  normalizePluginAccountCollectionContractV1,
  openPluginCollectionPrivatePayloadV1,
  sealPluginCollectionPrivatePayloadV1,
} from './collectionsV1.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '../actions/jsonSchemaValidation.js';

/**
 * `bindingId` is deliberately server-readable and NOT required: it is the exact
 * shape the shipped channels collections use for an optional projected field.
 */
const contract = normalizePluginAccountCollectionContractV1({
  pluginId: 'example.channels',
  contribution: {
    id: 'channel-deliveries',
    schemaVersion: 1,
    rowIdField: 'id',
    identityFields: [],
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 256 },
        connectionId: { type: 'string', maxLength: 256 },
        bindingId: { type: 'string', maxLength: 256 },
        attention: { type: 'boolean' },
        privateNote: { type: 'string', maxLength: 256 },
      },
      required: ['id', 'connectionId', 'attention'],
      additionalProperties: false,
    },
    serverReadable: ['connectionId', 'bindingId', 'attention'],
    indexes: [{
      id: 'by-connection',
      fields: [
        { field: 'connectionId', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
    }],
    uiQueries: [],
    relations: [],
    migrations: [],
  },
});

const validate = compilePluginJsonSchema(contract.schema);
const isValidLogicalValue = (
  value: PluginCollectionLogicalValueV1,
): value is PluginCollectionLogicalValueV1 => isValidPluginJsonSchemaValue(validate, value);

const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(5) };
const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(3);

describe('plugin Collection logical row codec', () => {
  it('constructs and measures the exact closed mutation request from logical operations', () => {
    const prepared = preparePluginCollectionLogicalMutationRequestV1({
      contract,
      isValidLogicalValue,
      operations: [
        {
          kind: 'put',
          expectedRevision: 'absent',
          value: {
            id: 'delivery-batch-1',
            connectionId: 'connection-1',
            attention: true,
          },
        },
        { kind: 'assert', rowId: 'delivery-batch-2', expectedRevision: 4 },
      ],
      encryptionMode: 'plain',
      material: null,
      randomBytes,
      absenceEpoch: 0,
    });

    expect(prepared).toMatchObject({
      status: 'prepared',
      request: {
        pluginId: 'example.channels',
        collectionId: 'channel-deliveries',
        writerContext: {
          schemaVersion: 1,
          contractDigest: contract.contractDigest,
        },
        operations: [
          {
            kind: 'put',
            rowId: 'delivery-batch-1',
            expectedRevision: 'absent',
            projection: {
              connectionId: 'connection-1',
              bindingId: null,
              attention: true,
            },
          },
          { kind: 'assert', rowId: 'delivery-batch-2', expectedRevision: 4 },
        ],
      },
    });
    if (prepared.status !== 'prepared') return;
    expect(prepared.encodedBytes).toBe(
      measurePluginCollectionMutationRequestEncodedBytesV1(prepared.request),
    );
    expect(prepared.measurement).toEqual(
      measurePluginCollectionMutationRequestDecompositionV1(prepared.request),
    );
  });

  it('projects an absent optional server-readable field as null and restores it as absent', () => {
    const encoded = encodePluginCollectionLogicalValueV1({
      contract,
      isValidLogicalValue,
      value: {
        id: 'delivery-1',
        connectionId: 'connection-1',
        attention: true,
        privateNote: 'private',
      },
      encryptionMode: 'plain',
      material: null,
      randomBytes,
    });
    expect(encoded).toMatchObject({
      status: 'encoded',
      rowId: 'delivery-1',
      projection: { connectionId: 'connection-1', bindingId: null, attention: true },
    });
    if (encoded.status !== 'encoded') return;

    const decoded = decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: encoded.rowId,
        revision: 4,
        content: encoded.content,
        projection: encoded.projection,
      },
      encryptionMode: 'plain',
      material: null,
    });
    expect(decoded).toEqual({
      status: 'decoded',
      rowId: 'delivery-1',
      revision: 4,
      value: {
        id: 'delivery-1',
        connectionId: 'connection-1',
        attention: true,
        privateNote: 'private',
      },
    });
    if (decoded.status !== 'decoded') return;
    expect(Object.hasOwn(decoded.value, 'bindingId')).toBe(false);
  });

  it('round-trips a present optional server-readable field through the projection', () => {
    const value = {
      id: 'delivery-2',
      connectionId: 'connection-1',
      bindingId: 'binding-9',
      attention: false,
    };
    const encoded = encodePluginCollectionLogicalValueV1({
      contract,
      isValidLogicalValue,
      value,
      encryptionMode: 'plain',
      material: null,
      randomBytes,
    });
    expect(encoded).toMatchObject({
      status: 'encoded',
      projection: { connectionId: 'connection-1', bindingId: 'binding-9', attention: false },
    });
    if (encoded.status !== 'encoded') return;
    expect(encoded.content).toEqual({ t: 'plain', v: {} });

    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: encoded.rowId,
        revision: 1,
        content: encoded.content,
        projection: encoded.projection,
      },
      encryptionMode: 'plain',
      material: null,
    })).toEqual({ status: 'decoded', rowId: 'delivery-2', revision: 1, value });
  });

  it('rejects a row whose projection omits a required server-readable field', () => {
    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: 'delivery-3',
        revision: 1,
        content: { t: 'plain', v: {} },
        projection: { connectionId: null, bindingId: null, attention: true },
      },
      encryptionMode: 'plain',
      material: null,
    })).toEqual({ status: 'failed', reason: 'row-schema-invalid' });
  });

  it('rejects a projection that is not the contract\'s exact server-readable set', () => {
    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: 'delivery-4',
        revision: 1,
        content: { t: 'plain', v: {} },
        projection: { connectionId: 'connection-1', attention: true },
      },
      encryptionMode: 'plain',
      material: null,
    })).toEqual({ status: 'failed', reason: 'projection-mismatch' });
  });

  it('rejects a private payload that shadows an admitted projection field', () => {
    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: 'delivery-5',
        revision: 1,
        content: { t: 'plain', v: { connectionId: 'other-connection' } },
        projection: { connectionId: 'connection-1', bindingId: null, attention: true },
      },
      encryptionMode: 'plain',
      material: null,
    })).toEqual({ status: 'failed', reason: 'private-payload-overlaps-projection' });
  });

  it('seals and opens the private payload for an E2EE Account and refuses a plain envelope', () => {
    const encoded = encodePluginCollectionLogicalValueV1({
      contract,
      isValidLogicalValue,
      value: {
        id: 'delivery-6',
        connectionId: 'connection-1',
        attention: true,
        privateNote: 'sealed',
      },
      encryptionMode: 'e2ee',
      material,
      randomBytes,
    });
    expect(encoded).toMatchObject({ status: 'encoded' });
    if (encoded.status !== 'encoded') return;
    expect(encoded.content.t).toBe('encrypted');
    expect(encoded.content.t === 'encrypted' && openPluginCollectionPrivatePayloadV1({
      material,
      ciphertext: encoded.content.c,
    })).toEqual({ privateNote: 'sealed' });

    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: encoded.rowId,
        revision: 2,
        content: encoded.content,
        projection: encoded.projection,
      },
      encryptionMode: 'e2ee',
      material,
    })).toMatchObject({ status: 'decoded' });

    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: encoded.rowId,
        revision: 2,
        content: encoded.content,
        projection: encoded.projection,
      },
      encryptionMode: 'plain',
      material: null,
    })).toEqual({ status: 'failed', reason: 'content-mode-mismatch' });

    expect(decodePluginCollectionLogicalRowV1({
      contract,
      isValidLogicalValue,
      row: {
        rowId: encoded.rowId,
        revision: 2,
        content: {
          t: 'encrypted',
          c: sealPluginCollectionPrivatePayloadV1({
            material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
            payload: { privateNote: 'other account' },
            randomBytes,
          }),
        },
        projection: encoded.projection,
      },
      encryptionMode: 'e2ee',
      material,
    })).toEqual({ status: 'failed', reason: 'content-mode-mismatch' });
  });

  it('refuses to encode for an E2EE Account without Account-scoped material', () => {
    expect(encodePluginCollectionLogicalValueV1({
      contract,
      isValidLogicalValue,
      value: { id: 'delivery-7', connectionId: 'connection-1', attention: true },
      encryptionMode: 'e2ee',
      material: null,
      randomBytes,
    })).toEqual({ status: 'failed', reason: 'encryption-material-unavailable' });
  });

  it('refuses to encode a value that does not satisfy the admitted schema', () => {
    expect(encodePluginCollectionLogicalValueV1({
      contract,
      isValidLogicalValue,
      value: { id: 'delivery-8', connectionId: 'connection-1' },
      encryptionMode: 'plain',
      material: null,
      randomBytes,
    })).toEqual({ status: 'failed', reason: 'value-schema-invalid' });
  });

  it('refuses to encode a value whose row-identity field is not a valid row id', () => {
    expect(encodePluginCollectionLogicalValueV1({
      contract,
      isValidLogicalValue: () => true,
      value: { id: '', connectionId: 'connection-1', attention: true },
      encryptionMode: 'plain',
      material: null,
      randomBytes,
    })).toEqual({ status: 'failed', reason: 'row-identity-invalid' });
  });
});
