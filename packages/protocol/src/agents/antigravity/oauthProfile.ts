import {
  AGY_OAUTH_ALLOW_RAW_AUTHORIZATION_CODE,
  AGY_OAUTH_AUTHORIZE_URL,
  AGY_OAUTH_CALLBACK_URL,
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_CLIENT_SECRET,
  AGY_OAUTH_SCOPES,
  AGY_OAUTH_TOKEN_URL,
  AGY_OAUTH_USERINFO_URL,
} from '../../providers/agy/oauth.js';

/** Registered installed-app facts shared by Antigravity OAuth and native materialization. */
export const ANTIGRAVITY_OAUTH_PROFILE: Readonly<{
  allowRawAuthorizationCode: true;
  authorizeUrl: string;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: readonly string[];
}> = Object.freeze({
  allowRawAuthorizationCode: AGY_OAUTH_ALLOW_RAW_AUTHORIZATION_CODE,
  authorizeUrl: AGY_OAUTH_AUTHORIZE_URL,
  callbackUrl: AGY_OAUTH_CALLBACK_URL,
  clientId: AGY_OAUTH_CLIENT_ID,
  clientSecret: AGY_OAUTH_CLIENT_SECRET,
  tokenUrl: AGY_OAUTH_TOKEN_URL,
  userinfoUrl: AGY_OAUTH_USERINFO_URL,
  scopes: AGY_OAUTH_SCOPES,
});
