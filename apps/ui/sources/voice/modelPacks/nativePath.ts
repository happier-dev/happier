/**
 * Converts a `file://` URI from expo-file-system into the plain filesystem path native speech engines take.
 * Installed model pack directories must always go through this so one pack maps to one native engine cache
 * key, which `release` relies on.
 */
export function fileUriToNativePath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}
