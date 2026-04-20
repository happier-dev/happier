const DEFAULT_KOKORO_DAEMON_TTS_PACK_ID = 'kokoro-tts-en-v1';

const LEGACY_BROWSER_KOKORO_TTS_ASSET_IDS = new Set([
    'kokoro-82m-v1.0-onnx-q8-wasm',
    'kokoro-82m-v1.0-onnx-fp32-wasm',
]);

export function resolveKokoroDaemonTtsPackId(assetId: string | null | undefined): string {
    const normalizedAssetId = typeof assetId === 'string' ? assetId.trim() : '';
    if (!normalizedAssetId) {
        return DEFAULT_KOKORO_DAEMON_TTS_PACK_ID;
    }
    if (LEGACY_BROWSER_KOKORO_TTS_ASSET_IDS.has(normalizedAssetId)) {
        return DEFAULT_KOKORO_DAEMON_TTS_PACK_ID;
    }
    return normalizedAssetId;
}
