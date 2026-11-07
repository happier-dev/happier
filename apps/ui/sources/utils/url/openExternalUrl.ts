import { Linking, Platform } from 'react-native';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

const SAFE_EXTERNAL_URL_SCHEME_PATTERN = /^(https?:\/\/|mailto:)/i;

export async function openExternalUrl(
  url: string,
  opts?: Readonly<{ platformOS?: string; webTarget?: '_blank' | '_self' }>,
): Promise<boolean> {
  const normalized = String(url ?? '').trim();
  if (!SAFE_EXTERNAL_URL_SCHEME_PATTERN.test(normalized)) return false;

  const platformOS = String(opts?.platformOS ?? Platform.OS ?? '').toLowerCase();
  if (platformOS === 'web' && isTauriDesktop()) {
    try {
      await invokeTauri('plugin:opener|open_url', { url: normalized });
      return true;
    } catch {
      console.error('Tauri could not open an external URL');
      return false;
    }
  }
  if (platformOS === 'web') {
    try {
      const openFn = (globalThis as unknown as { open?: unknown }).open;
      if (typeof openFn === 'function') {
        (openFn as (url: string, target?: string, features?: string) => unknown)(
          normalized,
          opts?.webTarget ?? '_blank',
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
