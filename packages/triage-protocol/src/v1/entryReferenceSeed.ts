/** Stable finite derivation/example identity; it grants no source authority. */
export const SOURCE_CONTRIBUTION = Object.freeze({
    pluginId: 'happier.example.source',
    localId: 'example-forge',
});

export const LOCAL_REF = Object.freeze({
    kindId: 'pull-request',
    collisionScope: 'example:41231',
    entryId: '17',
});

export const ENTRY_REF = Object.freeze({ source: SOURCE_CONTRIBUTION, ...LOCAL_REF });
