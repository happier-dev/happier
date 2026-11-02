import { describe, expect, it } from 'vitest';
import { createBrowserProfileCookieImporter } from './importCookies';
import type { BrowserSidecarContextCaptureSurface } from '../sidecar/controlAdapter';

const cookie = { name: 'session', value: 'COOKIE_SENTINEL', domain: 'example.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' as const };
const request = { browserSessionId: 'session', viewId: 'view', profileId: 'profile', cookies: [cookie] };
function fixture() {
  const commands: { method: string; params?: Record<string, unknown> }[] = [];
  const surface: BrowserSidecarContextCaptureSurface = {
    resolvePageHandle: view => view.browserSessionId === 'session' && view.viewId === 'view' ? { targetId: 'target', sessionId: 'page' } : null,
    resolveProfile: view => view.browserSessionId === 'session' && view.viewId === 'view'
      ? { profileId: 'profile', storageMode: 'ephemeral', owner: { kind: 'session', id: 'session' }, lifecycleState: 'active', cleanupOnSessionClose: true } : null,
    transport: { dispatchPageCommand: async command => { commands.push(command); return { success: true }; } },
  };
  return { commands, surface, apply: createBrowserProfileCookieImporter(surface) };
}
describe('managed profile cookie insertion', () => {
  it('inserts through the selected live profile with host-only scope and no material in the result', async () => {
    const f = fixture();
    const result = await f.apply(request);
    expect(result).toEqual({ status: 'completed', records: [{ domain: 'example.test', name: 'session', status: 'imported' }] });
    expect(f.commands).toMatchObject([{ method: 'Network.setCookie', params: {
      name: 'session', value: 'COOKIE_SENTINEL', url: 'https://example.test/', secure: true, httpOnly: true, sameSite: 'Strict',
    } }]);
    expect(f.commands[0].params).not.toHaveProperty('domain');
    expect(JSON.stringify(result)).not.toContain('COOKIE_SENTINEL');
  });
  it('denies another profile, Session and a purged profile before sending cookie material', async () => {
    const f = fixture();
    expect(await f.apply({ ...request, profileId: 'other' })).toEqual({ status: 'unavailable', code: 'profile_mismatch' });
    expect(await f.apply({ ...request, browserSessionId: 'other' })).toEqual({ status: 'unavailable', code: 'destination_unavailable' });
    const purged = createBrowserProfileCookieImporter({ ...f.surface, resolveProfile: () => ({
      profileId: 'profile', owner: { kind: 'session', id: 'session' }, storageMode: 'ephemeral', lifecycleState: 'purging', cleanupOnSessionClose: true,
    }) });
    expect(await purged(request)).toEqual({ status: 'unavailable', code: 'profile_mismatch' });
    expect(f.commands).toHaveLength(0);
  });
  it('reports partial insertion and suppresses native exception material', async () => {
    const f = fixture();
    const apply = createBrowserProfileCookieImporter({ ...f.surface, transport: { dispatchPageCommand: async command => {
      if (command.params?.name === 'session') throw new Error('COOKIE_SENTINEL /native/source/path');
      return { success: true };
    } } });
    const result = await apply({ ...request, cookies: [cookie, { ...cookie, name: 'second', domain: '.example.test' }] });
    expect(result).toEqual({ status: 'completed', records: [
      { domain: 'example.test', name: 'session', status: 'failed', code: 'import_unknown' },
      { domain: '.example.test', name: 'second', status: 'imported' },
    ] });
    expect(JSON.stringify(result)).not.toContain('COOKIE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('/native/source/path');
  });
});
