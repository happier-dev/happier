export type WebCryptoMissingPrimitive =
    | 'crypto'
    | 'subtle'
    | 'digest'
    | 'importKey'
    | 'encrypt'
    | 'decrypt';

export type WebCryptoSupportSnapshot = Readonly<{
    supported: boolean;
    origin: string | null;
    isSecureContext: boolean | null;
    missing: ReadonlyArray<WebCryptoMissingPrimitive>;
}>;

function isBrowserLikeEnvironment(): boolean {
    if (typeof window === 'undefined') return false;
    if (typeof document === 'undefined') return false;
    return true;
}

function readOriginSafe(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        return typeof window.location?.origin === 'string' ? window.location.origin : null;
    } catch {
        return null;
    }
}

function readIsSecureContextSafe(): boolean | null {
    try {
        return typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : null;
    } catch {
        return null;
    }
}

function computeMissingWebCryptoPrimitives(): ReadonlyArray<WebCryptoMissingPrimitive> {
    const missing: WebCryptoMissingPrimitive[] = [];
    const cryptoObj = (globalThis as any).crypto as Crypto | undefined;
    if (!cryptoObj) {
        missing.push('crypto');
        return missing;
    }
    const subtle = (cryptoObj as any).subtle as SubtleCrypto | undefined;
    if (!subtle) {
        missing.push('subtle');
        return missing;
    }
    if (typeof (subtle as any).digest !== 'function') missing.push('digest');
    if (typeof (subtle as any).importKey !== 'function') missing.push('importKey');
    if (typeof (subtle as any).encrypt !== 'function') missing.push('encrypt');
    if (typeof (subtle as any).decrypt !== 'function') missing.push('decrypt');
    return missing;
}

export function readWebCryptoSupportSnapshot(): WebCryptoSupportSnapshot {
    if (!isBrowserLikeEnvironment()) {
        return {
            supported: true,
            origin: null,
            isSecureContext: null,
            missing: [],
        };
    }

    const missing = computeMissingWebCryptoPrimitives();
    return {
        supported: missing.length === 0,
        origin: readOriginSafe(),
        isSecureContext: readIsSecureContextSafe(),
        missing,
    };
}
