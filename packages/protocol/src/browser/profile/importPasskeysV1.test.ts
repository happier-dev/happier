import { describe, expect, it } from 'vitest';
import { SavedSecretResourceContentV1Schema } from '../../account/settings/savedSecretResourceContentSchemaV1.js';
import { BrowserPasskeysApplyV1Schema } from './loginsV1.js';
import { importBrowserProfilePasskeysV1, prepareBrowserProfilePasskeysImportV1 } from './importPasskeysV1.js';

const input = { kind: 'passkeys' as const, machineId: 'machine', browserSessionId: 'session', viewId: 'view', profileId: 'profile', refs: ['key'] };
const content = SavedSecretResourceContentV1Schema.parse({ v: 2, name: 'Example passkey', kind: 'other',
  source: { kind: 'passkey', rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG', privateKey: 'BwgJ',
    algorithm: -7, signCount: 0, backupEligibility: true, backupState: true } });

describe('admitted Saved Secret passkey activation', () => {
  it('resolves import support with destination metadata only and preserves the native reason', async () => {
    for (const code of ['passkey_import_unavailable', 'engine_unsupported', 'profile_mismatch'] as const) {
      const requests: unknown[] = [];
      expect(await prepareBrowserProfilePasskeysImportV1(input, async call => {
        requests.push(call.input);
        return { status: 'unavailable', code };
      })).toEqual({ status: 'unavailable', code });
      expect(requests).toEqual([{ browserSessionId: 'session', viewId: 'view', profileId: 'profile', credentials: [] }]);
    }
    expect(await prepareBrowserProfilePasskeysImportV1(input, async () => ({ status: 'completed', records: [] }))).toBeNull();
  });

  it('settles absent support, permission denial and cancellation before key acquisition', async () => {
    expect(await prepareBrowserProfilePasskeysImportV1(input, async () => ({})))
      .toEqual({ status: 'unavailable', code: 'engine_unsupported' });
    expect(await prepareBrowserProfilePasskeysImportV1(input, async () => { throw { rpcErrorCode: 'RPC_FORBIDDEN' }; }))
      .toEqual({ status: 'unavailable', code: 'permission_denied' });
    const canceled = new AbortController();
    expect(await prepareBrowserProfilePasskeysImportV1(input, async () => {
      canceled.abort();
      return { status: 'completed', records: [] };
    }, canceled.signal)).toEqual({ status: 'unavailable', code: 'canceled' });
  });

  it('transfers the actual key through the private native schema and returns only metadata', async () => {
    const requests: unknown[] = [];
    const result = await importBrowserProfilePasskeysV1(input, new Map([['key', content]]), async call => {
      requests.push(call);
      expect(BrowserPasskeysApplyV1Schema.parse(call.input).credentials).toEqual([content.v === 2 ? content.source : null]);
      return { status: 'completed', records: [{ domain: 'example.com', name: 'AQID', status: 'imported' }] };
    });
    expect(result).toEqual({ status: 'completed', records: [{ domain: 'example.com', name: 'AQID', status: 'imported' }] });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('BwgJ');
  });
  it('settles missing, scalar and canceled sources without a native mutation', async () => {
    const calls: unknown[] = [];
    const rpc = async (call: unknown) => { calls.push(call); return {}; };
    expect(await importBrowserProfilePasskeysV1(input, new Map(), rpc)).toMatchObject({ status: 'completed',
      records: [{ status: 'failed', code: 'source_unavailable' }] });
    const scalar = SavedSecretResourceContentV1Schema.parse({ v: 1, name: 'Token', kind: 'token', value: 'token' });
    expect(await importBrowserProfilePasskeysV1(input, new Map([['key', scalar]]), rpc)).toMatchObject({ status: 'completed',
      records: [{ status: 'failed', code: 'source_format_unsupported' }] });
    const canceled = new AbortController(); canceled.abort();
    expect(await importBrowserProfilePasskeysV1(input, new Map([['key', content]]), rpc, canceled.signal)).toEqual({ status: 'unavailable', code: 'canceled' });
    expect(calls).toEqual([]);
  });
  it('keeps permission denial typed and strips native exceptions containing key bytes', async () => {
    const contents = new Map([['key', content]]);
    expect(await importBrowserProfilePasskeysV1(input, contents, async () => { throw { rpcErrorCode: 'RPC_FORBIDDEN', message: 'BwgJ' }; }))
      .toEqual({ status: 'unavailable', code: 'permission_denied' });
    expect(await importBrowserProfilePasskeysV1(input, contents, async () => { throw new Error('BwgJ'); }))
      .toEqual({ status: 'unavailable', code: 'import_unknown' });
  });
  it('preserves the closed usage-counter reason for the import result row', async () => {
    const unsupported = { status: 'completed', records: [{ domain: 'example.com', name: 'AQID', status: 'failed',
      code: 'source_format_unsupported', reason: 'this passkey tracks a usage counter' }] };
    expect(await importBrowserProfilePasskeysV1(input, new Map([['key', content]]), async () => unsupported))
      .toEqual(unsupported);
  });
});
