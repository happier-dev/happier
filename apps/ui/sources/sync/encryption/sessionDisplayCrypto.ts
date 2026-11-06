import {
    openSessionOwnerDisplayEnvelopeV1,
    openSessionSharedDisplayEnvelopeV1,
    sealSessionOwnerDisplayEnvelopeV1,
    sealSessionSharedDisplayEnvelopeV1,
    type AccountScopedCryptoMaterial,
    type SessionOwnerDisplayV1,
    type SessionSharedDisplayV1,
} from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials, resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

export type SessionDisplayCipher = Readonly<{
    encryptRaw?: (payload: unknown) => Promise<string>;
    decryptRaw?: (ciphertext: string) => Promise<unknown>;
}>;

/** One finite read proves its Account material once; the proof scales with reads, never rows. */
export function createCurrentAccountMaterialReader(params: Readonly<{
    credentials: AuthCredentials;
    accountCurrentness: Pick<AccountEncryptionIdentity, 'mode' | 'contentKeyFingerprint'>;
}>): () => AccountScopedCryptoMaterial | null {
    let proved: { material: AccountScopedCryptoMaterial | null } | null = null;
    return () => (proved ??= { material: resolveCurrentAccountScopedCryptoMaterialSnapshot(params)?.material ?? null }).material;
}

/** Thin adapters to the existing Session and Account key owners; modes are independent. */
export function createSessionDisplayCrypto(params: Readonly<{
    sessionMode: 'plain' | 'e2ee';
    accountMode?: 'plain' | 'e2ee';
    credentials: AuthCredentials;
    sessionEncryption?: SessionDisplayCipher | null;
}>) {
    const material = (): AccountScopedCryptoMaterial | null => {
        if (params.accountMode !== 'e2ee') return null;
        try { return resolveAccountScopedCryptoMaterialFromCredentials(params.credentials); }
        catch { return null; }
    };
    return {
        async encodeSharedDisplay(display: SessionSharedDisplayV1) {
            const sealed = await sealSessionSharedDisplayEnvelopeV1({
                sessionMode: params.sessionMode, display,
                ...(params.sessionEncryption?.encryptRaw ? {
                    encryptPayload: payload => params.sessionEncryption!.encryptRaw!(payload),
                } : {}),
            });
            if (!sealed.ok) throw new Error(`Session shared display unavailable: ${sealed.reason}`);
            return sealed.envelope;
        },
        encodeOwnerDisplay(display: SessionOwnerDisplayV1) {
            if (!params.accountMode) throw new Error('Session owner display Account mode unavailable');
            const sealed = sealSessionOwnerDisplayEnvelopeV1({
                accountMode: params.accountMode, display, material: material(), randomBytes: getRandomBytes });
            if (!sealed.ok) throw new Error(`Session owner display unavailable: ${sealed.reason}`);
            return sealed.envelope;
        },
        openSharedDisplay(envelope: unknown) {
            return openSessionSharedDisplayEnvelopeV1({
                sessionMode: params.sessionMode, envelope,
                ...(params.sessionEncryption?.decryptRaw ? {
                    decryptPayload: ciphertext => params.sessionEncryption!.decryptRaw!(ciphertext),
                } : {}),
            });
        },
        openOwnerDisplay(envelope: unknown, accountCurrentness: AccountEncryptionIdentity,
            readMaterial = createCurrentAccountMaterialReader({ credentials: params.credentials, accountCurrentness })) {
            if (!params.accountMode || params.accountMode !== accountCurrentness.mode) return { ok: false as const, reason: 'crypto_unavailable' as const };
            let currentMaterial: AccountScopedCryptoMaterial | null = null;
            if (accountCurrentness.mode === 'e2ee') {
                currentMaterial = readMaterial();
                if (!currentMaterial) return { ok: false as const, reason: 'crypto_unavailable' as const };
            }
            return openSessionOwnerDisplayEnvelopeV1({
                accountMode: params.accountMode, envelope, material: currentMaterial });
        },
    };
}
