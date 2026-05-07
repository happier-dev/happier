export const UI_CRYPTO_GOLDEN_VECTORS = {
    schema: 'happier.uiCryptoGoldenVectors.v1',
    secretboxJson: {
        keyHex: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
        nonceHex: '0102030405060708090a0b0c0d0e0f101112131415161718',
        values: [
            {
                name: 'object',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":{"ok":true,"count":2,"nested":["a",null]}}',
                encryptedHex: '0102030405060708090a0b0c0d0e0f101112131415161718ec7239217f41ee89265c8d1af610834cbb153ce1d84a2dd0577b0180665a535624695cc2a522842454646c5aff339f9856c16f1fc54a8dade256abb7cd4538625d88be1f8b915d1d7891965c3380c1ccf3ddf0bb5d5fd3c8bf6c5e39399c34b297dbde000f155d8d7a6eac89953c8645bbbefbde296da0',
            },
            {
                name: 'array',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":["x",1,false]}',
                encryptedHex: '0102030405060708090a0b0c0d0e0f101112131415161718a136ae596a8dc390b2a9aa04d495c92fbb153ce1d84a2dd0577b0180665a535624695cc2a522842454646c5aff339f9856c16f1fc54a8dade256abb7cd4538625d88be1f8b915d1d7891965c33a0c1dbbad3fbe3494bda97f8524c',
            },
            {
                name: 'string',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":"hello"}',
                encryptedHex: '0102030405060708090a0b0c0d0e0f101112131415161718a7f9dbcf4dfdb4c1c924db8bace89fe9bb153ce1d84a2dd0577b0180665a535624695cc2a522842454646c5aff339f9856c16f1fc54a8dade256abb7cd4538625d88be1f8b915d1d7891965c33d98bc6f493a5ed52',
            },
            {
                name: 'number',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":42}',
                encryptedHex: '0102030405060708090a0b0c0d0e0f10111213141516171820f7e18b7328829aff44169f16058fc4bb153ce1d84a2dd0577b0180665a535624695cc2a522842454646c5aff339f9856c16f1fc54a8dade256abb7cd4538625d88be1f8b915d1d7891965c33cfd1de',
            },
            {
                name: 'nullValue',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":null}',
                encryptedHex: '0102030405060708090a0b0c0d0e0f101112131415161718807442aa2075aeab816fc54679959a55bb153ce1d84a2dd0577b0180665a535624695cc2a522842454646c5aff339f9856c16f1fc54a8dade256abb7cd4538625d88be1f8b915d1d7891965c339596cff482',
            },
            {
                name: 'undefinedValue',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"undefined"}',
                encryptedHex: '0102030405060708090a0b0c0d0e0f1011121314151617182891dd85457636072d4180f65a11ce6cbb153ce1d84a2dd0577b0180665a535624695cc2a522842454646c5aff339f9856c16f1fc54a8dade256abb7cd45387d4083b55bcedd4e183699',
            },
        ],
    },
    aesGcmJson: {
        keyHex: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d',
        ivHex: '0102030405060708090a0b0c',
        values: [
            {
                name: 'object',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":{"ok":true,"count":2,"nested":["a",null]}}',
                encryptedPayloadHex: '000102030405060708090a0b0cf1211e9915dd5068a37d3aa5eeffe6b4e0a675417d5c052fafd461661c36dd0cf1f2b1a76b8e3174bbcb8a675c3cbdcfa2406b41a3adc39f41fc6676ff6a0eef40119f6f8a950b1751fa184596c2c00ae8724ddc77e2f1075b0db40dd53ba92df0425fa462e0724ed315f4d00cc4ca20d2fb6796216fca',
                nativeBase64Payload: 'AQIDBAUGBwgJCgsM8SEemRXdUGijfTql7v/mtOCmdUF9XAUvr9RhZhw23Qzx8rGna44xdLvLimdcPL3PokBrQaOtw59B/GZ2/2oO70ARn2+KlQsXUfoYRZbCwArock3cd+LxB1sNtA3VO6kt8EJfpGLgck7TFfTQDMTKINL7Z5Yhb8o=',
            },
            {
                name: 'array',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":["x",1,false]}',
                encryptedPayloadHex: '000102030405060708090a0b0cf1211e9915dd5068a37d3aa5eeffe6b4e0a675417d5c052fafd461661c36dd0cf1f2b1a76b8e3174bbcb8a675c3cbdcfa2406b41a3adc39f41fc6676ff4a0ef8091f94379e81024816c40a25cdc0acb890c544b34d71fb4bda3501',
                nativeBase64Payload: 'AQIDBAUGBwgJCgsM8SEemRXdUGijfTql7v/mtOCmdUF9XAUvr9RhZhw23Qzx8rGna44xdLvLimdcPL3PokBrQaOtw59B/GZ2/0oO+AkflDeegQJIFsQKJc3ArLiQxUSzTXH7S9o1AQ==',
            },
            {
                name: 'string',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":"hello"}',
                encryptedPayloadHex: '000102030405060708090a0b0cf1211e9915dd5068a37d3aa5eeffe6b4e0a675417d5c052fafd461661c36dd0cf1f2b1a76b8e3174bbcb8a675c3cbdcfa2406b41a3adc39f41fc6676ff3344e5475fca3985ed10e738b26e68aa7472efe7d3425417',
                nativeBase64Payload: 'AQIDBAUGBwgJCgsM8SEemRXdUGijfTql7v/mtOCmdUF9XAUvr9RhZhw23Qzx8rGna44xdLvLimdcPL3PokBrQaOtw59B/GZ2/zNE5UdfyjmF7RDnOLJuaKp0cu/n00JUFw==',
            },
            {
                name: 'number',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":42}',
                encryptedPayloadHex: '000102030405060708090a0b0cf1211e9915dd5068a37d3aa5eeffe6b4e0a675417d5c052fafd461661c36dd0cf1f2b1a76b8e3174bbcb8a675c3cbdcfa2406b41a3adc39f41fc6676ff251efd88f96e6b7ec09ac2ceed212d0e92fa19',
                nativeBase64Payload: 'AQIDBAUGBwgJCgsM8SEemRXdUGijfTql7v/mtOCmdUF9XAUvr9RhZhw23Qzx8rGna44xdLvLimdcPL3PokBrQaOtw59B/GZ2/yUe/Yj5bmt+wJrCzu0hLQ6S+hk=',
            },
            {
                name: 'nullValue',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"json","value":null}',
                encryptedPayloadHex: '000102030405060708090a0b0cf1211e9915dd5068a37d3aa5eeffe6b4e0a675417d5c052fafd461661c36dd0cf1f2b1a76b8e3174bbcb8a675c3cbdcfa2406b41a3adc39f41fc6676ff7f59ec474e4e0ecb7c9518ba0a6f9acd79e0a44986',
                nativeBase64Payload: 'AQIDBAUGBwgJCgsM8SEemRXdUGijfTql7v/mtOCmdUF9XAUvr9RhZhw23Qzx8rGna44xdLvLimdcPL3PokBrQaOtw59B/GZ2/39Z7EdOTg7LfJUYugpvms154KRJhg==',
            },
            {
                name: 'undefinedValue',
                serialized: '{"__happierSerializedJsonValueV1":true,"type":"undefined"}',
                encryptedPayloadHex: '000102030405060708090a0b0cf1211e9915dd5068a37d3aa5eeffe6b4e0a675417d5c052fafd461661c36dd0cf1f2b1a76b8e3174bbcb8a675c3cbdd0bf4b6005e6e1d09a0ff4e7f63bc9564ea75a9a276b06d2ab10e9',
                nativeBase64Payload: 'AQIDBAUGBwgJCgsM8SEemRXdUGijfTql7v/mtOCmdUF9XAUvr9RhZhw23Qzx8rGna44xdLvLimdcPL3Qv0tgBebh0JoP9Of2O8lWTqdamidrBtKrEOk=',
            },
        ],
    },
} as const;

export type UiCryptoGoldenVectors = typeof UI_CRYPTO_GOLDEN_VECTORS;
