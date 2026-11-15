import { CLAUDE_OAUTH_PROFILE_URL, CLAUDE_OAUTH_TOKEN_URL } from '@happier-dev/protocol/providers/claude/oauth-profile';

// Qualified refresh uses fixed vendor URLs, rather than the legacy token URL
// override. Home and all internal transports remain real.
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const tokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
  if (tokenUrl && (url === CLAUDE_OAUTH_PROFILE_URL || url === CLAUDE_OAUTH_TOKEN_URL)) {
    const target = url === CLAUDE_OAUTH_PROFILE_URL ? new URL('/api/oauth/profile', tokenUrl) : tokenUrl;
    return fetch(new Request(target, new Request(input, init)));
  }
  return fetch(input, init);
};
