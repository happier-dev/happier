// Re-export the hardened shared parser from @happier-dev/plugin-sdk. Azure DevOps
// was the original site of the hardened parser; it now lives in plugin-sdk and is
// shared by all first-party SCM hosting plugins so any future third-party SCM
// hosting plugin can opt into the same rejection policy.
export { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from '@happier-dev/plugin-sdk/experimental/scm/remoteUrl';
export type { ParsedScmRemoteUrl } from '@happier-dev/plugin-sdk/experimental/scm/remoteUrl';
