/**
 * The exact first-party Account API token shapes the Account server mints. The
 * token parsers and the bug-report redactor both derive from these, so a
 * dependency-free leaf owns them.
 */
export const ACCOUNT_API_TOKEN_BEARER_V1_SOURCE =
  'hap_v1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})';

/** An encryption-capable credential: this prefix followed by a base64url payload that embeds the bearer. */
export const ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX = 'hapc_v1_';
