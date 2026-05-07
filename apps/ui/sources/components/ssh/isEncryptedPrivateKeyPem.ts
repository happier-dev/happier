export function isEncryptedPrivateKeyPem(value: string): boolean {
    const normalized = value.toUpperCase();
    return normalized.includes('BEGIN ENCRYPTED PRIVATE KEY')
        || normalized.includes('PROC-TYPE: 4,ENCRYPTED')
        || normalized.includes('DEK-INFO:');
}
