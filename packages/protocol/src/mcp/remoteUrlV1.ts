import { z } from 'zod';

const MCP_CREDENTIAL_KEYS = new Set([
  'auth',
  'authentication',
  'authorization',
  'credential',
  'credentials',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'clientpassword',
  'password',
  'passwd',
  'pat',
  'proxyauthentication',
  'proxyauthorization',
]);
const MCP_BEARER_VALUE_PATTERN = /\bbearer\s+\S+/i;

function isMcpCredentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return MCP_CREDENTIAL_KEYS.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('apikey')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('passwd')
    || normalized.endsWith('authorization')
    || normalized.endsWith('authentication')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials');
}

export const McpRemoteUrlV1Schema = z.string().url().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const credentialBearingParameter = [...url.searchParams.entries()].some(([key, parameterValue]) => (
    isMcpCredentialKey(key)
    || MCP_BEARER_VALUE_PATTERN.test(parameterValue)
  ));
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || credentialBearingParameter
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'MCP remote URLs cannot contain fragments, credentials, or secret query parameters.',
    });
  }
});
