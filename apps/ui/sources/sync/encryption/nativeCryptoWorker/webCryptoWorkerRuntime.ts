import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

export type WebCryptoWorkerItem = Readonly<{
    envelope: Uint8Array<ArrayBuffer>;
    recipientSecretKeyOrSeed: Uint8Array<ArrayBuffer>;
}>;

export type WebCryptoWorkerResponse = Readonly<{
    status: 'ready';
}> | Readonly<{
    status: 'ok';
    items: readonly (Uint8Array<ArrayBuffer> | null)[];
}> | Readonly<{
    status: 'error';
    error: Readonly<{ name: string; message: string }>;
}>;

export type WebCryptoWorkerPort = {
    onmessage: ((event: MessageEvent<readonly (WebCryptoWorkerItem | null)[]>) => void) | null;
    postMessage: (message: WebCryptoWorkerResponse, transfer: ArrayBuffer[]) => void;
};

/** The transport changes; the authenticated envelope implementation stays canonical. */
export function installWebCryptoWorker(port: WebCryptoWorkerPort): void {
    port.onmessage = ({ data }) => {
        try {
            const items = data.map(item => item
                ? openEncryptedDataKeyEnvelopeV1(item)?.slice() ?? null
                : null);
            port.postMessage({ status: 'ok', items }, items.flatMap(item => item ? [item.buffer] : []));
        } catch (error) {
            port.postMessage({
                status: 'error',
                error: error instanceof Error
                    ? { name: error.name, message: error.message }
                    : { name: 'Error', message: 'Web crypto worker failed' },
            }, []);
        } finally {
            for (const item of data) item?.recipientSecretKeyOrSeed.fill(0);
        }
    };
    port.postMessage({ status: 'ready' }, []);
}
