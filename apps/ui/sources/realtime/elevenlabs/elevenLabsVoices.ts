import { elevenLabsFetchJson } from './elevenLabsApi';

export type ElevenLabsVoiceSummary = Readonly<{
  voiceId: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
  labels: Readonly<Record<string, string>> | null;
}>;

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => {
      const key = asString(k);
      const val = asString(v);
      if (!key || !val) return [];
      return [[key, val]] as const;
    });
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoiceSummary[]> {
  const json = await elevenLabsFetchJson({ apiKey, path: '/voices', init: { method: 'GET' } });
  const voices = (json as any)?.voices;
  if (!Array.isArray(voices)) return [];

  const result = voices.flatMap((raw: any) => {
    const voiceId = asString(raw?.voice_id);
    const name = asString(raw?.name);
    if (!voiceId || !name) return [];
    const previewUrl = asString(raw?.preview_url) ?? asString(raw?.previewUrl);
    const category = asString(raw?.category);
    const labels = asStringRecord(raw?.labels);
    return [{ voiceId, name, category, previewUrl, labels } satisfies ElevenLabsVoiceSummary];
  });

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

