export const CRYPTO_GOLDEN_VECTORS = {
  schema: 'happier.cryptoGoldenVectors.v1',
  boxBundle: {
    directSecretKey: {
      recipientSecretKeyOrSeed: {
        hex: '0909090909090909090909090909090909090909090909090909090909090909',
      },
      recipientPublicKey: {
        hex: '57db4b359f23ae5e146e4e2512056704722506348c150c14753d0c933d04d421',
      },
      plaintext: {
        hex: '0303030303030303030303030303030303030303030303030303030303030303',
      },
      bundle: {
        hex: '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f30313233343536373859c1c234f45efd03c1ab22b9b03f8b3feb1276a05a7868f0c6a9c8bfcd0423033d6aea6e047523bc7413ee42040d1677',
      },
    },
    compatibilitySeed: {
      recipientSecretKeyOrSeed: {
        hex: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
      },
      recipientPublicKey: {
        hex: '4bbe6e226acfc43639d01ed291b5c65746c660d046071ca76eacc518bdae0819',
      },
      plaintext: {
        hex: '0707070707070707070707070707070707070707070707070707070707070707',
      },
      bundle: {
        hex: '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f303132333435363738f427df224168af852aee33ba83373277a78e69b82653cae4c31bf92707cc7d03dfd549ca06b072d61318b94ad3ff8c80',
      },
    },
    malformedBundle: {
      hex: '010203',
    },
  },
  encryptedDataKeyEnvelopeV1: {
    directSecretKey: {
      recipientSecretKeyOrSeed: {
        hex: '0909090909090909090909090909090909090909090909090909090909090909',
      },
      recipientPublicKey: {
        hex: '57db4b359f23ae5e146e4e2512056704722506348c150c14753d0c933d04d421',
      },
      dataKey: {
        hex: '0404040404040404040404040404040404040404040404040404040404040404',
      },
      envelope: {
        hex: '0007a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f3031323334353637387c08c8f85db24be438ff0be65a8f9599ec1571a75d7f6ff7c1aecfb8ca0324043a6ded69037224bb7314e945030a1170',
      },
    },
    compatibilitySeed: {
      recipientSecretKeyOrSeed: {
        hex: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
      },
      recipientPublicKey: {
        hex: '4bbe6e226acfc43639d01ed291b5c65746c660d046071ca76eacc518bdae0819',
      },
      dataKey: {
        hex: '0101010101010101010101010101010101010101010101010101010101010101',
      },
      envelope: {
        hex: '0007a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f3031323334353637387e1905a028d044ade8c2bec4c04b6973a1886fbe2055cce2c51dff2101ca7b05d9d34fcc00b674d0151ebf4cd5f98a86',
      },
    },
    malformedEnvelope: {
      hex: '000102',
    },
    unsupportedVersionEnvelope: {
      hex: '630102',
    },
  },
  serializedJsonValue: [
    {
      name: 'object',
      serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":{"ok":true,"count":2,"nested":["a",null]}}',
    },
    {
      name: 'array',
      serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":["x",1,false]}',
    },
    {
      name: 'string',
      serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":"hello"}',
    },
    {
      name: 'number',
      serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":42}',
    },
    {
      name: 'nullValue',
      serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":null}',
    },
    {
      name: 'undefinedValue',
      serialized: '{"__happierSerializedJsonValueV1":true,"type":"undefined"}',
    },
  ],
} as const;

export type CryptoGoldenVectors = typeof CRYPTO_GOLDEN_VECTORS;
