/**
 * Speaker count derived from the native engine for one installed pack directory.
 *
 * `listVoices` is a native round trip that opens the model, so the count is
 * cached per assets directory. That directory path is STABLE across a pack
 * replacement (the installer promotes new bytes into the same live directory),
 * so the cache must be dropped whenever those bytes change — otherwise a
 * replaced pack keeps resolving speaker ids against its predecessor's count and
 * synthesis picks the wrong voice for the rest of the process.
 *
 * This is the single owner of that derived state; callers never keep their own
 * copy.
 */
const speakerCountByAssetsDirPath = new Map<string, number>();

export function readCachedSpeakerCountForAssetsDir(assetsDirPath: string): number | undefined {
  return speakerCountByAssetsDirPath.get(assetsDirPath);
}

export function cacheSpeakerCountForAssetsDir(assetsDirPath: string, count: number): void {
  speakerCountByAssetsDirPath.set(assetsDirPath, count);
}

/** Drop the derived count for a pack directory whose bytes are being replaced or removed. */
export function forgetSpeakerCountForAssetsDir(assetsDirPath: string): void {
  speakerCountByAssetsDirPath.delete(assetsDirPath);
}
