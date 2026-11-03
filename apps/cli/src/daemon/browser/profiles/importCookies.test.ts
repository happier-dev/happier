import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { importBrowserProfileCookiesV1 } from '@happier-dev/protocol/browser/profile/v1';
import { uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import type { ReverseCaptureMachineRpcClient } from '../recording/reverseChannel/desktopReverseCaptureUiCall';
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


describe('native profile import through the admitted Action', () => {
  it('uses the same destination binding and approval before copying values over the private native continuation', async () => {
    const nativeRequests: unknown[] = [];
    let sourceReads = 0;
    let admissions = 0;
    const client: ReverseCaptureMachineRpcClient = { callConnectedClientRpc: async (method, payload, options) => {
      expect(method).toBe(uiBrowserAutomationDispatchMethod(request));
      expect(options?.answeringClient).toEqual({ requireSingle: true });
      nativeRequests.push(payload);
      options?.onIssued?.();
      return { ok: true, result: { status: 'completed', records: nativeRequests.length === 1 ? []
        : [{ name: cookie.name, domain: cookie.domain, status: 'imported' }] } };
    } };
    const apply = createBrowserProfileCookieImporter(undefined, { getNativeClient: () => client });
    const input = { kind: 'cookies' as const, machineId: 'desktop', browserSessionId: request.browserSessionId,
      viewId: request.viewId, profileId: request.profileId, sourceMachineId: 'laptop',
      source: { browser: 'firefox' as const, profileId: 'source' }, sites: ['https://example.test'] };
    const executor = createActionExecutor({ browserProfileLoginsImport: async ({ input, context }) => {
      admissions++;
      if (input.kind !== 'cookies') throw new Error('cookie fixture');
      return importBrowserProfileCookiesV1(input, async call => {
        if (call.machineId === 'laptop') { sourceReads++; return { status: 'ready', cookies: [cookie], skipped: [] }; }
        return apply(call.input, context.signal);
      }, context.signal);
    } } as ActionExecutorDeps);
    expect(await executor.execute('browser.profile.logins.import', input,
      { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(sourceReads).toBe(0);
    expect(nativeRequests).toEqual([]);
    const result = await executor.execute('browser.profile.logins.import', input,
      { surface: 'ui', authority: 'present_user', bypassApprovals: true });
    expect(result).toMatchObject({ ok: true, result: { status: 'completed', records: [{ name: 'session', status: 'imported' }] } });
    expect(admissions).toBe(1);
    expect(sourceReads).toBe(1);
    expect(nativeRequests).toEqual([{ ...request, cookies: [] }, request]);
    expect(JSON.stringify(result)).not.toContain(cookie.value);
  });

  it('retains the managed destination owner and never forwards a mismatched managed profile to a native view', async () => {
    const f = fixture();
    let nativeCalls = 0;
    const apply = createBrowserProfileCookieImporter(f.surface, { getNativeClient: () => ({
      callConnectedClientRpc: async () => { nativeCalls++; throw new Error('must not redirect an owned view'); },
    }) });
    expect(await apply({ ...request, profileId: 'other' })).toEqual({ status: 'unavailable', code: 'profile_mismatch' });
    expect(await apply(request)).toMatchObject({ status: 'completed', records: [{ status: 'imported' }] });
    expect(nativeCalls).toBe(0);
  });

  it('reports ambiguous/unavailable receivers before disclosure and uncertain issued writes as metadata only', async () => {
    const unavailable = createBrowserProfileCookieImporter(undefined, { getNativeClient: () => ({
      callConnectedClientRpc: async () => ({ ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS' }),
    }) });
    expect(await unavailable({ ...request, cookies: [] })).toEqual({ status: 'unavailable', code: 'destination_unavailable' });
    const uncertain = createBrowserProfileCookieImporter(undefined, { getNativeClient: () => ({
      callConnectedClientRpc: async (_method, _payload, options) => {
        options?.onIssued?.(); throw new Error('COOKIE_SENTINEL /native/path');
      },
    }) });
    const result = await uncertain(request);
    expect(result).toEqual({ status: 'completed', records: [{ domain: cookie.domain, name: cookie.name,
      status: 'failed', code: 'import_unknown' }] });
    expect(JSON.stringify(result)).not.toContain(cookie.value);
    expect(JSON.stringify(result)).not.toContain('/native/path');
  });
});
