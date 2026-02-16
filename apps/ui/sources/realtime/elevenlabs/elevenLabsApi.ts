import { runtimeFetch } from '@/utils/system/runtimeFetch';

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function getElevenLabsApiBaseUrl(): string {
  const raw = String(process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL ?? 'https://api.elevenlabs.io/v1').trim();
  return raw.replace(/\/+$/, '');
}

export function getElevenLabsApiTimeoutMs(): number {
  const raw = Number(process.env.PUBLIC_EXPO_ELEVENLABS_API_TIMEOUT_MS ?? 10_000);
  return clampInt(raw, 1_000, 60_000);
}

function withXiApiKey(apiKey: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('xi-api-key', apiKey);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return { ...init, headers };
}

export async function elevenLabsFetchJson(params: {
  apiKey: string;
  path: string;
  init?: RequestInit;
  timeoutMs?: number;
}): Promise<unknown> {
  const baseUrl = getElevenLabsApiBaseUrl();
  const controller = new AbortController();
  const callerSignal = params.init?.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timeoutMs = params.timeoutMs ?? getElevenLabsApiTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await runtimeFetch(`${baseUrl}${params.path}`, {
      ...withXiApiKey(params.apiKey, params.init),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Sanitize: do not include raw provider response text in the error message.
      throw new Error(`ElevenLabs API error (${res.status}) ${params.path}`);
    }
    return res.json();
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`ElevenLabs API request timed out (${params.path})`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    if (callerSignal && !callerSignal.aborted) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}
