import { createServerUrlComparableKey } from './serverUrlComparableKey.js';

/** The canonical Happier Cloud relay URL. */
export const HAPPIER_CLOUD_SERVER_URL = 'https://api.happier.dev' as const;

const HAPPIER_CLOUD_COMPARABLE_KEY = createServerUrlComparableKey(HAPPIER_CLOUD_SERVER_URL);

/** Whether a full server URL is Happier Cloud, compared by canonical key rather than by spelling. */
export function isHappierCloudServerUrl(serverUrl: string | null | undefined): boolean {
  if (typeof serverUrl !== 'string' || serverUrl.length === 0) return false;
  try {
    return createServerUrlComparableKey(serverUrl) === HAPPIER_CLOUD_COMPARABLE_KEY;
  } catch {
    return false;
  }
}
