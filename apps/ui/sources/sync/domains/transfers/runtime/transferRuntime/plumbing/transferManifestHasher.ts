import { sha256 } from '@noble/hashes/sha2';

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type TransferManifestHasher = Readonly<{
    update: (chunk: Uint8Array) => void;
    digestManifestHash: () => string;
}>;

export function createTransferManifestHasher(): TransferManifestHasher {
    const hasher = sha256.create();
    let finalized = false;

    return {
        update(chunk) {
            if (finalized) {
                throw new Error('Transfer manifest hasher already finalized');
            }
            hasher.update(chunk);
        },
        digestManifestHash() {
            if (finalized) {
                throw new Error('Transfer manifest hasher already finalized');
            }
            finalized = true;
            return `sha256:${bytesToHex(hasher.digest())}`;
        },
    };
}
