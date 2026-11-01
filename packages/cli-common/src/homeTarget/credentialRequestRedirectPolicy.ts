// Home consumers retain their public facade; release-runtime owns every hop decision.
export {
  CREDENTIAL_REQUEST_REDIRECT_POLICY,
  CredentialRequestRedirectError,
  assertCredentialRequestRedirectAllowed,
  isCredentialRequestHeader,
  resolveCredentialRequestRedirect,
  fetchWithCredentialRedirectRefusal,
} from '@happier-dev/release-runtime/httpRedirects';
