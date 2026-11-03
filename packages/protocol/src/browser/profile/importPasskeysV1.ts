import type { SavedSecretResourceContentV1 } from '../../account/settings/savedSecretResourceContentSchemaV1.js';
import { BrowserProfileLoginsImportResultV1Schema, type BrowserProfileLoginsImportV1, type BrowserProfileLoginsImportResultV1 } from './loginsV1.js';
import { browserProfileImportPermissionRefusedV1, type BrowserCookieImportRpcV1 } from './importCookiesV1.js';
import type { SavedSecretPasskeySourceV1 } from '../../account/settings/savedSecretPasskeySourceV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';

/** Resolve the admitted destination before opening Saved Secret key material. */
export async function prepareBrowserProfilePasskeysImportV1(
  input: Extract<BrowserProfileLoginsImportV1, { kind: 'passkeys' }>,
  rpc: BrowserCookieImportRpcV1,
  signal?: AbortSignal,
): Promise<Extract<BrowserProfileLoginsImportResultV1, { status: 'unavailable' }> | null> {
  if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  try {
    const result = BrowserProfileLoginsImportResultV1Schema.safeParse(await rpc({ machineId: input.machineId,
      method: RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY,
      input: { browserSessionId: input.browserSessionId, viewId: input.viewId, profileId: input.profileId, credentials: [] } }));
    if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
    if (!result.success || result.data.status === 'needs_source') return { status: 'unavailable', code: 'engine_unsupported' };
    return result.data.status === 'unavailable' ? result.data : null;
  } catch (error) {
    return { status: 'unavailable', code: signal?.aborted ? 'canceled'
      : browserProfileImportPermissionRefusedV1(error) ? 'permission_denied' : 'engine_unsupported' };
  }
}

/** Consumes only the existing resource reader's admitted transient content. */
export async function importBrowserProfilePasskeysV1(
  input: Extract<BrowserProfileLoginsImportV1, { kind: 'passkeys' }>,
  contents: ReadonlyMap<string, SavedSecretResourceContentV1>,
  rpc: BrowserCookieImportRpcV1,
  signal?: AbortSignal,
): Promise<BrowserProfileLoginsImportResultV1> {
  if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  const credentials: SavedSecretPasskeySourceV1[] = [];
  const records: Extract<BrowserProfileLoginsImportResultV1, { status: 'completed' }>['records'] = [];
  for (const ref of new Set(input.refs)) {
    const content = contents.get(ref);
    if (!content || content.v !== 2 || content.source.kind !== 'passkey') {
      records.push({ domain: '', name: ref, status: 'failed', code: content ? 'source_format_unsupported' : 'source_unavailable' });
    } else credentials.push(content.source);
  }
  if (!credentials.length) return { status: 'completed', records };
  try {
    const result = BrowserProfileLoginsImportResultV1Schema.safeParse(await rpc({ machineId: input.machineId,
      method: RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY,
      input: { browserSessionId: input.browserSessionId, viewId: input.viewId, profileId: input.profileId, credentials } }));
    if (!result.success) return { status: 'unavailable', code: 'import_unknown' };
    return result.data.status === 'completed' ? { status: 'completed', records: [...records, ...result.data.records] } : result.data;
  } catch (error) {
    return { status: 'unavailable', code: signal?.aborted ? 'canceled'
      : browserProfileImportPermissionRefusedV1(error) ? 'permission_denied' : 'import_unknown' };
  }
}
