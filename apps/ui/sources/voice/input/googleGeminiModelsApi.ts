import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';

export type GoogleGeminiModelSummary = Readonly<{
  id: string;
  name: string;
  displayName: string;
  description: string | null;
}>;

function normalizeModelId(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('models/')) return trimmed.slice('models/'.length);
  return trimmed;
}

function parseModelCatalog(json: any): GoogleGeminiModelSummary[] {
  const models = Array.isArray(json?.models) ? json.models : [];
  const out: GoogleGeminiModelSummary[] = [];

  for (const m of models) {
    const name = typeof m?.name === 'string' ? m.name.trim() : '';
    if (!name) continue;
    const supported = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    if (!supported.includes('generateContent')) continue;

    const displayName = typeof m?.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : name;
    const description = typeof m?.description === 'string' && m.description.trim() ? m.description.trim() : null;
    out.push({ id: normalizeModelId(name), name, displayName, description });
  }

  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

export async function fetchGoogleGeminiModelCatalog(opts: {
  apiKey: string;
  timeoutMs: number;
}): Promise<GoogleGeminiModelSummary[]> {
  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) return [];

  const url = 'https://generativelanguage.googleapis.com/v1beta/models';
  const init: RequestInit = {
    method: 'GET',
    headers: {
      'x-goog-api-key': apiKey,
    },
  };

  const res = await fetchWithTimeout(url, init, opts.timeoutMs, 'models_timeout');
  if (!res.ok) return [];

  const json = await res.json().catch(() => null);
  return parseModelCatalog(json);
}

