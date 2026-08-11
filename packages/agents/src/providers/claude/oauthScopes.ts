export const CLAUDE_CODE_REQUIRED_OAUTH_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
] as const;

export const CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const;

export const CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE = CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES.join(' ');

// Claude setup tokens authorize model inference only. Adding OAuth-only scopes here would make
// the native credential file claim capabilities that the setup-token grant does not possess.
export const CLAUDE_CODE_SETUP_TOKEN_SCOPES = ['user:inference'] as const;
