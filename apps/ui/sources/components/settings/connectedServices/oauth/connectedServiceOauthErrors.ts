/** Matches the error codes RFC 6749 defines (`access_denied`, `invalid_scope`, ...). */
const OAUTH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The provider's redirect carried an `error` parameter. That value comes from a pasted URL, so
 * only a plain error code is ever kept for display; anything else is dropped.
 */
export class ConnectedServiceOauthRejectedError extends Error {
  readonly oauthError: string | null;

  constructor(oauthError: string) {
    super('connect_oauth_rejected');
    this.name = 'ConnectedServiceOauthRejectedError';
    this.oauthError = OAUTH_ERROR_CODE.test(oauthError) ? oauthError : null;
    Object.setPrototypeOf(this, ConnectedServiceOauthRejectedError.prototype);
  }
}
