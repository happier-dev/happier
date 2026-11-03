import { importBrowserProfileCookiesV1, importBrowserProfilePasskeysV1, prepareBrowserProfilePasskeysImportV1, type BrowserCookieImportRpcV1, type BrowserProfileLoginsImportV1,
    type BrowserProfileLoginsImportResultV1 } from '@happier-dev/protocol/browser/profile/v1';
import { readSavedSecretContentsInContext } from '@/sync/api/account/apiSavedSecretCatalog';

/** Private host port reached only after the shared Action admits this selection. */
export async function importBrowserProfileLoginsInContext(
    context: Parameters<typeof readSavedSecretContentsInContext>[0] | null,
    input: BrowserProfileLoginsImportV1,
    rpc: BrowserCookieImportRpcV1,
    signal?: AbortSignal,
): Promise<BrowserProfileLoginsImportResultV1> {
    if (input.kind === 'cookies') return importBrowserProfileCookiesV1(input, rpc, signal);
    if (!context) return { status: 'unavailable', code: signal?.aborted ? 'canceled' : 'source_unavailable' };
    return importSavedSecretPasskeysInContext(context, input, rpc, signal);
}

export async function importSavedSecretPasskeysInContext(
    context: Parameters<typeof readSavedSecretContentsInContext>[0],
    input: Extract<BrowserProfileLoginsImportV1, { kind: 'passkeys' }>,
    rpc: BrowserCookieImportRpcV1,
    signal?: AbortSignal,
): Promise<BrowserProfileLoginsImportResultV1> {
    const references = [...new Set(input.refs)];
    if (!references.length) return importBrowserProfilePasskeysV1(input, new Map(), rpc, signal);
    const unavailable = await prepareBrowserProfilePasskeysImportV1(input, rpc, signal);
    if (unavailable) return unavailable;
    const read = await readSavedSecretContentsInContext(context, references, signal);
    if (!read.ok) return { status: 'unavailable', code: signal?.aborted ? 'canceled' : 'source_unavailable' };
    return importBrowserProfilePasskeysV1(input,
        new Map([...read.contents].map(([ref, material]) => [ref, material.content])), rpc, signal);
}
