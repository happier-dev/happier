/** Prepared outputs are regenerated before Expo reads live or captured source. */
export const SOURCE_UI_ASSET_OUTPUT_PATHS = Object.freeze({
    locales: 'sources/text/localeAssets.generated.js',
    shiki: 'sources/components/ui/code/highlighting/shiki/generatedShikiGrammarAssets.js',
    // Git-ignored compiler outputs of UI sources: a checkout copy can come from
    // another lane's uncommitted edit, so they are prepared like the others.
    atmosphereWorklet: 'sources/components/atmosphere/backdropWorkletCore.generated.js',
    atmosphereWorker: 'public/happier-atmosphere-worker.js',
    cryptoWorker: 'public/happier-crypto-worker.js',
    passwordKdfWorker: 'public/happier-password-kdf-worker.js',
});

export const SOURCE_UI_ASSET_RECORD_FILENAME = 'source-assets.json';
