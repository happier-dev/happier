// Re-export the hardened shared parser from @happier-dev/plugin-sdk to keep
// SCM hosting plugins on a single rejection policy (no port, no search/hash, no embedded
// credentials on https). Local re-export preserves this file's public surface for
// downstream importers of @happier-dev/plugins-scm-github.
export { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from '@happier-dev/plugin-sdk/scm';
export type { ParsedScmRemoteUrl } from '@happier-dev/plugin-sdk/scm';
