import type { ManagedBootstrapCredentialInvocationBinding } from '@happier-dev/protocol/actions/executor/types';

export type ManagedBootstrapCredentialByteLease = Readonly<{
    kind: 'bytes';
    bytes: Uint8Array;
    dispose(): Promise<void>;
}>;

/** One acquisition admission and byte custody owner for Account and daemon hosts. */
export function createManagedBootstrapCredentialByteService(input: Readonly<{
    binding?: ManagedBootstrapCredentialInvocationBinding;
    signal: AbortSignal;
    isCurrent(): boolean;
    retainCleanup(cleanup: Readonly<{ dispose(): Promise<void> }>): void;
    unavailable(): Error;
    registerRawForRedaction?(value: string): void;
}>): Readonly<{
    assertActive(): void;
    materializeBootstrapCredential(): Promise<ManagedBootstrapCredentialByteLease>;
    materializeGuestHostCredential(): Promise<ManagedBootstrapCredentialByteLease>;
}> {
    const assertActive = () => {
        if (input.signal.aborted) throw input.unavailable();
    };
    const admitAcquisition = async () => {
        assertActive();
        if (!input.isCurrent() || !input.binding || !await input.binding.isCurrent()) throw input.unavailable();
        assertActive();
    };
    const materialize = (readCredential: (() => Promise<Uint8Array>) | undefined): Promise<ManagedBootstrapCredentialByteLease> => {
        if (!readCredential) return Promise.reject(input.unavailable());
        let bytes: Uint8Array | null = null;
        let materialization: Promise<ManagedBootstrapCredentialByteLease> | null = null;
        const dispose = async () => {
            // A handler may settle without awaiting its acquisition.
            await materialization?.catch(() => undefined);
            bytes?.fill(0);
        };
        try { input.retainCleanup({ dispose }); }
        catch (error) { return Promise.reject(error); }
        materialization = (async () => {
            try {
                await admitAcquisition();
                bytes = await readCredential();
                assertActive();
                if (bytes.byteLength === 0) throw input.unavailable();
                input.registerRawForRedaction?.(new TextDecoder().decode(bytes));
                return Object.freeze({ kind: 'bytes' as const, bytes, dispose });
            } catch (error) {
                bytes?.fill(0);
                throw error;
            }
        })();
        return materialization;
    };
    return Object.freeze({
        assertActive,
        materializeBootstrapCredential: () => materialize(input.binding?.readBootstrapCredential),
        materializeGuestHostCredential: () => materialize(input.binding?.readGuestHostCredential),
    });
}
