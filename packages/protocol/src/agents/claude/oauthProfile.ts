import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CALLBACK_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
} from '../../providers/claude/oauthProfile.js';

/** Public, nonsecret OAuth metadata shared by Claude Subscription authors. */
export const CLAUDE_SUBSCRIPTION_OAUTH_PROFILE: Readonly<{
  authorizeUrl: string;
  callbackUrl: string;
  clientId: string;
  tokenUrl: string;
}> = Object.freeze({
  authorizeUrl: CLAUDE_OAUTH_AUTHORIZE_URL,
  callbackUrl: CLAUDE_OAUTH_CALLBACK_URL,
  clientId: CLAUDE_OAUTH_CLIENT_ID,
  tokenUrl: CLAUDE_OAUTH_TOKEN_URL,
});
