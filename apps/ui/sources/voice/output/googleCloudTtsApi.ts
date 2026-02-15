import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';
import { buildGoogleApiKeyRestrictionHeaders } from '@/voice/runtime/googleApiKeyHeaders';

export type GoogleCloudTtsVoice = Readonly<{
  name: string;
  languageCodes: ReadonlyArray<string>;
  ssmlGender: string | null;
  naturalSampleRateHertz: number | null;
}>;

function parseGoogleCloudTtsVoices(json: any): GoogleCloudTtsVoice[] {
  const voices = Array.isArray(json?.voices) ? json.voices : [];
  return voices
    .map((v: any) => {
      const name = typeof v?.name === 'string' ? v.name.trim() : '';
      if (!name) return null;
      const languageCodes = Array.isArray(v?.languageCodes)
        ? v.languageCodes.filter((c: any) => typeof c === 'string' && c.trim()).map((c: string) => c.trim())
        : [];
      const ssmlGender = typeof v?.ssmlGender === 'string' && v.ssmlGender.trim() ? v.ssmlGender.trim() : null;
      const naturalSampleRateHertz =
        typeof v?.naturalSampleRateHertz === 'number' && Number.isFinite(v.naturalSampleRateHertz)
          ? v.naturalSampleRateHertz
          : null;
      return { name, languageCodes, ssmlGender, naturalSampleRateHertz } as const;
    })
    .filter(Boolean) as GoogleCloudTtsVoice[];
}

export async function fetchGoogleCloudTtsVoiceCatalog(opts: {
  apiKey: string;
  androidCertSha1?: string | null;
  languageCode?: string | null;
  timeoutMs?: number;
}): Promise<GoogleCloudTtsVoice[]> {
  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) return [];

  const languageCode = typeof opts.languageCode === 'string' && opts.languageCode.trim() ? opts.languageCode.trim() : '';
  const query = new URLSearchParams({ key: apiKey });
  if (languageCode) query.set('languageCode', languageCode);

  const url = `https://texttospeech.googleapis.com/v1/voices?${query.toString()}`;
  const init: RequestInit = {
    method: 'GET',
    headers: {
      ...buildGoogleApiKeyRestrictionHeaders({ androidCertSha1: opts.androidCertSha1 ?? null }),
    },
  };

  const res = await fetchWithTimeout(url, init, opts.timeoutMs ?? 10_000, 'tts_timeout');
  if (!res.ok) {
    return [];
  }

  const json = await res.json().catch(() => null);
  return parseGoogleCloudTtsVoices(json);
}

