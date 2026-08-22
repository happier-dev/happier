/**
 * Conversions between the `file://` URIs the Expo filesystem API hands out and
 * the plain absolute paths the native voice modules expect for `assetsDir`.
 *
 * One owner for both directions: the pack directory reached through
 * `expo-file-system` is a URI, while every native engine is keyed by the bare
 * path, and the two must agree exactly or a cache keyed on one form silently
 * misses the other.
 */
export function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  return uri;
}

export function filePathToUri(pathOrUri: string): string {
  if (pathOrUri.startsWith('file://')) return pathOrUri;
  if (pathOrUri.startsWith('/')) return `file://${pathOrUri}`;
  return pathOrUri;
}
