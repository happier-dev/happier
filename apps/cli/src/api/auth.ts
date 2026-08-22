import axios from 'axios';
import { encodeBase64, encodeBase64Url, authChallenge } from './encryption';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';

/**
 * Note: This function is deprecated. Use readPrivateKey/writePrivateKey from persistence module instead.
 * Kept for backward compatibility only.
 */
export async function getOrCreateSecretKey(): Promise<Uint8Array> {
  throw new Error('getOrCreateSecretKey is deprecated. Use readPrivateKey/writePrivateKey from persistence module.');
}

/**
 * Authenticate with the server and obtain an auth token
 * @param serverUrl - The URL of the server to authenticate with
 * @param secret - The secret key to use for authentication
 * @returns The authentication token
 */
export async function authGetToken(secret: Uint8Array): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret);
  
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.post(`${serverUrl}/v1/auth`, {
    challenge: encodeBase64(challenge),
    publicKey: encodeBase64(publicKey),
    signature: encodeBase64(signature)
  }, {
    headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
  });

  if (!response.data.success || !response.data.token) {
    throw new Error('Authentication failed');
  }

  return response.data.token;
}

/**
 * Generate a URL for the mobile app to connect to the server
 * @param secret - The secret key to use for authentication
 * @returns The URL for the mobile app to connect to the server
 */
export function generateAppUrl(secret: Uint8Array): string {
  const secretBase64Url = encodeBase64Url(secret);
  return `handy://${secretBase64Url}`;
}
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
