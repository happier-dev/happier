import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';

type ContentKind = 'credential' | 'configuration' | 'attempt';
type AccountMode = 'plain' | 'e2ee';

/** The captured Account's existing mode admission and connected-content codec. */
export function createUiConnectedAccountContent(account: LazyActionAccountContext) {
    return {
        async resolveAccountMode(usage: 'identity' | 'fresh-authority' = 'identity'): Promise<AccountMode> {
            const { encryption } = await account.resolveAccountEncryption();
            const current = await resolveAccountStorageContext(account.credentials, { encryption, request: account.request, usage });
            account.assertCurrent();
            return current.mode;
        },
        seal(kind: ContentKind, accountMode: AccountMode, payload: unknown): StoredJsonContentEnvelope {
            return accountMode === 'plain'
                ? sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode, payload, randomBytes: getRandomBytes })
                : sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode, payload, randomBytes: getRandomBytes,
                    material: resolveAccountScopedCryptoMaterialFromCredentials(account.credentials) });
        },
        open(kind: ContentKind, accountMode: AccountMode, envelope: StoredJsonContentEnvelope): unknown {
            return accountMode === 'plain'
                ? openQualifiedConnectedAccountContentEnvelope({ kind, accountMode, envelope })
                : openQualifiedConnectedAccountContentEnvelope({ kind, accountMode, envelope,
                    material: resolveAccountScopedCryptoMaterialFromCredentials(account.credentials) });
        },
    };
}
