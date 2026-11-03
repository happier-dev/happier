import { importBrowserProfilePasskeysV1, prepareBrowserProfilePasskeysImportV1, type BrowserProfileLoginsImportV1, type BrowserProfileLoginsImportResultV1, type BrowserCookieImportRpcV1 } from '@happier-dev/protocol/browser/profile/v1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import type { SavedSecretResourceContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

export async function importCliSavedSecretPasskeysForOperation(params: Readonly<{
  input: Extract<BrowserProfileLoginsImportV1, { kind: 'passkeys' }>;
  expectedScopeKey: string;
  operationContext?: SavedSecretOperationContextV1;
  rpc: BrowserCookieImportRpcV1;
  signal?: AbortSignal;
}>): Promise<BrowserProfileLoginsImportResultV1> {
  if (params.signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  if (!params.input.refs.length) return importBrowserProfilePasskeysV1(params.input, new Map(), params.rpc, params.signal);
  const unavailable = await prepareBrowserProfilePasskeysImportV1(params.input, params.rpc, params.signal);
  if (unavailable) return unavailable;
  try {
    const { materializer } = await readSavedSecretMaterializerForOperation({ expectedScopeKey: params.expectedScopeKey,
      refreshCatalog: true, references: params.input.refs.map(ref => ({ ref, required: false })), sourceKind: 'inline',
      operationContext: params.operationContext, signal: params.signal });
    const contents = new Map<string, SavedSecretResourceContentV1>();
    for (const ref of new Set(params.input.refs)) {
      const resolved = materializer.resolveContent(ref);
      if (resolved.status === 'ready') contents.set(ref, resolved.content);
    }
    return await importBrowserProfilePasskeysV1(params.input, contents, params.rpc, params.signal);
  } catch {
    return { status: 'unavailable', code: params.signal?.aborted ? 'canceled' : 'source_unavailable' };
  }
}
