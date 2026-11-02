import type { BrowserSidecarContextCaptureSurface } from '../sidecar/controlAdapter';
import { BrowserCookieApplyV1Schema, type BrowserProfileLoginsImportResultV1, type BrowserLoginImportRecordV1 } from '@happier-dev/protocol/browser/profile/v1';

export function createBrowserProfileCookieImporter(capture: BrowserSidecarContextCaptureSurface | undefined) {
  return async (input: unknown, signal?: AbortSignal): Promise<BrowserProfileLoginsImportResultV1> => {
    const parsed = BrowserCookieApplyV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'unavailable', code: 'import_failed' };
    if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
    const request = parsed.data;
    const handle = capture?.resolvePageHandle(request);
    if (!capture || !handle) return { status: 'unavailable', code: 'destination_unavailable' };
    const profile = capture.resolveProfile?.(request);
    if (!profile || profile.profileId !== request.profileId || profile.lifecycleState !== 'active') {
      return { status: 'unavailable', code: 'profile_mismatch' };
    }
    const records: BrowserLoginImportRecordV1[] = [];
    for (const cookie of request.cookies) {
      const metadata = { domain: cookie.domain, name: cookie.name };
      if (signal?.aborted) {
        records.push({ ...metadata, status: 'skipped', code: 'canceled' });
        continue;
      }
      try {
        const result = await capture.transport.dispatchPageCommand({ ...handle, signal, method: 'Network.setCookie', params: {
          name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
          ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
          url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
          ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
          ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
        } });
        const refused = typeof result === 'object' && result !== null && 'success' in result && result.success === false;
        records.push({ ...metadata, status: refused ? 'failed' : 'imported',
          ...(refused ? { code: 'import_failed' as const } : {}) });
      } catch {
        // A dropped CDP response cannot establish whether Chromium applied the cookie.
        records.push({ ...metadata, status: 'failed', code: 'import_unknown' });
      }
    }
    return { status: 'completed', records };
  };
}
