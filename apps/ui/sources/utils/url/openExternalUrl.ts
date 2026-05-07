import { Linking, Platform } from 'react-native';

const SAFE_EXTERNAL_URL_SCHEME_PATTERN = /^(https?:\/\/|mailto:)/i;

export async function openExternalUrl(
  url: string,
  opts?: Readonly<{ platformOS?: string }>,
): Promise<boolean> {
  const normalized = String(url ?? '').trim();
  if (!SAFE_EXTERNAL_URL_SCHEME_PATTERN.test(normalized)) return false;

  const platformOS = String(opts?.platformOS ?? Platform.OS ?? '').toLowerCase();
  if (platformOS === 'web') {
    try {
      const openFn = (globalThis as unknown as { open?: unknown }).open;
      if (typeof openFn === 'function') {
        (openFn as (url: string, target?: string, features?: string) => unknown)(
          normalized,
          '_blank',
          'noopener,noreferrer',
        );
        return true;
      }
    } catch {
      // fall through
    }
  }

  try {
    await Linking.openURL(normalized);
    return true;
  } catch {
    return false;
  }
}
