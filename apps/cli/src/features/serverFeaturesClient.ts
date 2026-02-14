import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

import { normalizeBaseUrl, withAbortTimeout } from '@/diagnostics/httpClient';
import { parseServerFeatures } from './serverFeaturesParse';

export type CliServerFeaturesSnapshot =
  | Readonly<{ status: 'ready'; features: ServerFeatures }>
  | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' | 'invalid_payload' }>
  | Readonly<{ status: 'error'; reason: 'network' | 'timeout' | 'response_status' }>;

function isEndpointMissing(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

export async function fetchServerFeaturesSnapshot(params: {
  serverUrl: string;
  timeoutMs?: number;
}): Promise<CliServerFeaturesSnapshot> {
  const timeoutMs = params.timeoutMs ?? 6000;

  try {
    const response = await withAbortTimeout(timeoutMs, async (signal) =>
      await fetch(`${normalizeBaseUrl(params.serverUrl)}/v1/features`, {
        method: 'GET',
        signal,
      }),
    );

    if (!response.ok) {
      return isEndpointMissing(response.status)
        ? { status: 'unsupported', reason: 'endpoint_missing' }
        : { status: 'error', reason: 'response_status' };
    }

    const payload: unknown = await response.json();
    const parsed = parseServerFeatures(payload);
    if (!parsed) {
      return { status: 'unsupported', reason: 'invalid_payload' };
    }

    return {
      status: 'ready',
      features: parsed,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      status: 'error',
      reason: isTimeout ? 'timeout' : 'network',
    };
  }
}
