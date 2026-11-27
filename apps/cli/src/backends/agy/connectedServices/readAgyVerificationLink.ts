import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectedServiceQuotaFetchError } from '@/daemon/connectedServices/quotas/types';
import { DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS } from '@/daemon/connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import type { GoogleCodeAssistFetchRuntime } from '@/daemon/connectedServices/quotas/googleCodeAssistRequest';
import { AGY_NATIVE_TOKEN_FILE_SEGMENTS, parseAgyNativeCredential } from '../cloud/nativeCredentials';
import { awaitsGoogleValidation, loadAgyCodeAssistEntitlement, readGoogleValidationUrl } from './codeAssistEntitlement';

export type AgyVerificationLink = Readonly<{ url: string } | { url: null; reason: string }>;

async function readMaterializedAccessToken(geminiHome: string): Promise<string | null> {
  try {
    return parseAgyNativeCredential(JSON.parse(await readFile(join(geminiHome, ...AGY_NATIVE_TOKEN_FILE_SEGMENTS), 'utf8')))?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Google's verification link for the connected account whose turn just failed. The account's
 * credential is the token agy itself used: the materialized profile (`GEMINI_HOME`) token file,
 * which agy keeps refreshed. The entitlement request shares the quota fetch's budget.
 */
export async function readAgyVerificationLink(processEnv: NodeJS.ProcessEnv, deps: Readonly<{ fetchRuntime?: GoogleCodeAssistFetchRuntime }> = {}): Promise<AgyVerificationLink> {
  const geminiHome = processEnv.GEMINI_HOME?.trim();
  if (!geminiHome) return { url: null, reason: 'connected_profile_home_unavailable' };
  const accessToken = await readMaterializedAccessToken(geminiHome);
  if (!accessToken) return { url: null, reason: 'connected_profile_token_unavailable' };
  let load: Record<string, unknown> | null;
  try {
    load = await loadAgyCodeAssistEntitlement({ fetchRuntime: deps.fetchRuntime ?? fetch, accessToken,
      signal: AbortSignal.timeout(DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS) }, null);
  } catch (error) {
    return { url: null, reason: error instanceof ConnectedServiceQuotaFetchError ? error.message : 'entitlement_request_aborted' };
  }
  const url = readGoogleValidationUrl(load);
  if (url) return { url };
  return { url: null, reason: awaitsGoogleValidation(load) ? 'validation_url_not_usable' : 'validation_not_reported' };
}
