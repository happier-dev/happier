import { BrowserCookieSourceResultV1Schema, BrowserProfileLoginsImportResultV1Schema, type BrowserProfileLoginsImportV1, type BrowserProfileLoginsImportResultV1 } from './loginsV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';

export type BrowserCookieImportRpcV1 = (call: Readonly<{ machineId: string; method: string; input: unknown }>) => Promise<unknown>;
export function browserProfileImportPermissionRefusedV1(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'rpcErrorCode' in error ? error.rpcErrorCode : 'code' in error ? error.code : undefined;
  return code === 'RPC_FORBIDDEN' || code === 'permission_denied';
}
export async function importBrowserProfileCookiesV1(
  input: Extract<BrowserProfileLoginsImportV1, { kind: 'cookies' }>, rpc: BrowserCookieImportRpcV1, signal?: AbortSignal,
): Promise<BrowserProfileLoginsImportResultV1> {
  if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  if (!input.source) return { status: 'needs_source' };
  const destination = { browserSessionId: input.browserSessionId, viewId: input.viewId, profileId: input.profileId };
  // Resolve the selected live profile before acquiring native material, including on older daemons.
  try {
    const ready = BrowserProfileLoginsImportResultV1Schema.safeParse(await rpc({ machineId: input.machineId,
      method: RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY, input: { ...destination, cookies: [] } }));
    if (!ready.success || ready.data.status === 'needs_source') return { status: 'unavailable', code: 'engine_unsupported' };
    if (ready.data.status === 'unavailable') return ready.data;
  } catch (error) { return { status: 'unavailable', code: signal?.aborted ? 'canceled'
    : browserProfileImportPermissionRefusedV1(error) ? 'permission_denied' : 'engine_unsupported' }; }
  if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  let source;
  try {
    source = BrowserCookieSourceResultV1Schema.safeParse(await rpc({ machineId: input.sourceMachineId,
      method: RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ, input: { source: input.source, sites: input.sites } }));
  } catch (error) { return { status: 'unavailable', code: signal?.aborted ? 'canceled'
    : browserProfileImportPermissionRefusedV1(error) ? 'permission_denied' : 'source_unavailable' }; }
  if (!source.success) return { status: 'unavailable', code: 'source_format_unsupported' };
  if (source.data.status !== 'ready') return source.data;
  if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  if (!source.data.cookies.length) return { status: 'completed', records: source.data.skipped };
  try {
    const result = BrowserProfileLoginsImportResultV1Schema.safeParse(await rpc({ machineId: input.machineId,
      method: RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY, input: { ...destination, cookies: source.data.cookies } }));
    if (!result.success) return { status: 'unavailable', code: 'import_unknown' };
    return result.data.status === 'completed' ? { status: 'completed', records: [...source.data.skipped, ...result.data.records] } : result.data;
  } catch (error) { return { status: 'unavailable', code: browserProfileImportPermissionRefusedV1(error) ? 'permission_denied' : 'import_unknown' }; }
}
