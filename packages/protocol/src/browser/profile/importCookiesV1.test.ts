import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from '../../actions/actionExecutor.js';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '../../actions/actionSettings.js';
import { importBrowserProfileCookiesV1 } from './importCookiesV1.js';
import { BrowserProfileLoginsImportV1Schema } from './loginsV1.js';

const request = { kind: 'cookies' as const, machineId: 'vps', browserSessionId: 'session', viewId: 'view', profileId: 'destination',
  sourceMachineId: 'laptop', source: { browser: 'firefox' as const, profileId: 'source' }, sites: ['https://example.test'] };
describe('browser profile login import', () => {
  it.each([request, { kind: 'passkeys' as const, machineId: 'vps', browserSessionId: 'session', viewId: 'view',
    profileId: 'destination', refs: ['happier:shared-secret:v1:key'] }])('admits $kind only after Action approval and rejects material-bearing operands', async request => {
    let imports = 0;
    const records = request.kind === 'passkeys' ? [{ domain: 'example.test', name: 'credential', status: 'failed' as const,
      code: 'source_format_unsupported' as const, reason: 'this passkey tracks a usage counter' as const }] : [];
    // Only the private host/transport boundaries reached by this Action are installed.
    const executor = createActionExecutor({ clientActionExecute: async () => { throw new Error('must not redirect native import'); },
      browserProfileLoginsImport: async () => {
      imports++; return { status: 'completed', records };
    } } as ActionExecutorDeps);
    expect(await executor.execute('browser.profile.logins.import', request,
      { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(imports).toBe(0);
    expect(await executor.execute('browser.profile.logins.import', { ...request, value: 'SECRET' },
      { surface: 'ui', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(imports).toBe(0);
    expect(await executor.execute('browser.profile.logins.import', request,
      { surface: 'ui', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: true, result: { status: 'completed', records } });
    expect(imports).toBe(1);
    const actionsSettings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionId: 'browser.profile.logins.import', surface: 'cli', approvalRequired: false });
    expect(await executor.execute('browser.profile.logins.import', request,
      { surface: 'cli', authority: 'account_automation', actionsSettings })).toMatchObject({ ok: true, result: { status: 'completed', records } });
    expect(imports).toBe(2);
  });
  it('registers one dangerous Action with public metadata operands and a closed material-free result', () => {
    const spec = getActionSpec('browser.profile.logins.import');
    expect(spec.safety).toBe('danger');
    expect(spec.inputSchema.safeParse({ ...request, cookies: [{ value: 'SECRET' }] }).success).toBe(false);
    expect(spec.outputSchema!.safeParse({ status: 'completed', records: [], value: 'SECRET' }).success).toBe(false);
    expect(BrowserProfileLoginsImportV1Schema.safeParse({ ...request, kind: 'unknown' }).success).toBe(false);
  });
  it('moves selected cookies laptop to VPS only on the private Machine RPC path and returns metadata', async () => {
    const calls: { machineId: string; method: string; input: unknown }[] = [];
    const result = await importBrowserProfileCookiesV1(request, async (call) => {
      calls.push(call);
      if (call.machineId === 'vps' && typeof call.input === 'object' && call.input !== null && 'cookies' in call.input
        && Array.isArray(call.input.cookies) && call.input.cookies.length === 0) return { status: 'completed', records: [] };
      if (call.machineId === 'laptop') return { status: 'ready', cookies: [
        { name: 'session', value: 'COOKIE_SENTINEL', domain: 'example.test', path: '/', secure: true, httpOnly: true },
      ], skipped: [] };
      return { status: 'completed', records: [{ name: 'session', domain: 'example.test', status: 'imported' }] };
    });
    expect(calls.map(call => call.machineId)).toEqual(['vps', 'laptop', 'vps']);
    expect(JSON.stringify(calls[0])).not.toContain('COOKIE_SENTINEL');
    expect(calls[2].input).toMatchObject({ profileId: 'destination', cookies: [{ value: 'COOKIE_SENTINEL' }] });
    expect(result).toEqual({ status: 'completed', records: [{ name: 'session', domain: 'example.test', status: 'imported' }] });
    expect(JSON.stringify(result)).not.toContain('COOKIE_SENTINEL');
  });
  it('settles missing selection and canceled imports with zero source reads', async () => {
    let calls = 0;
    const rpc = async () => { calls++; throw new Error('must not read'); };
    expect(await importBrowserProfileCookiesV1({ ...request, source: undefined }, rpc)).toEqual({ status: 'needs_source' });
    expect(await importBrowserProfileCookiesV1(request, rpc, AbortSignal.abort())).toEqual({ status: 'unavailable', code: 'canceled' });
    expect(calls).toBe(0);
  });
  it('reports native Machine permission refusal without exposing transport exception material', async () => {
    const result = await importBrowserProfileCookiesV1(request, async () => {
      throw Object.assign(new Error('COOKIE_SENTINEL /native/path'), { rpcErrorCode: 'RPC_FORBIDDEN' });
    });
    expect(result).toEqual({ status: 'unavailable', code: 'permission_denied' });
    expect(JSON.stringify(result)).not.toContain('COOKIE_SENTINEL');
  });
  it('does not read native source cookies when the destination daemon lacks the private import contract', async () => {
    let sourceReads = 0;
    const result = await importBrowserProfileCookiesV1(request, async call => {
      if (call.machineId === 'laptop') { sourceReads++; return { status: 'ready', cookies: [], skipped: [] }; }
      throw Object.assign(new Error('missing method'), { rpcErrorCode: 'RPC_METHOD_NOT_FOUND' });
    });
    expect(result).toEqual({ status: 'unavailable', code: 'engine_unsupported' });
    expect(sourceReads).toBe(0);
  });
  it('contains private host exceptions before they enter Action history or a transcript', async () => {
    // Unrelated executor ports are deliberately absent from this host-boundary fixture.
    const executor = createActionExecutor({ browserProfileLoginsImport: async () => { throw new Error('COOKIE_SENTINEL /native/path'); } } as ActionExecutorDeps);
    const result = await executor.execute('browser.profile.logins.import', request,
      { surface: 'ui', authority: 'present_user', bypassApprovals: true });
    expect(result).toMatchObject({ ok: true, result: { status: 'unavailable', code: 'import_unknown' } });
    expect(JSON.stringify(result)).not.toContain('COOKIE_SENTINEL');
  });
});
