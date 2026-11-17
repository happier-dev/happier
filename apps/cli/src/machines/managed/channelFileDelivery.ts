import { finished, pipeline } from 'node:stream/promises';
import { Readable, type Duplex } from 'node:stream';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';

/** Existing managed put-file transport: bytes are stdin, never command arguments.
 * The caller owns guest completion/publication; carrier end alone is not proof. */
export async function writeManagedChannelFile<T extends Duplex>(input: Readonly<{
    path: string;
    bytes: Uint8Array | Readable;
    signal?: AbortSignal;
    openChannel(argv: readonly string[]): T;
    /** SSH exposes guest completion directly; generic provider channels do not. */
    waitForCompletion?(channel: T): Promise<void>;
}>): Promise<T> {
    const source = input.bytes instanceof Readable ? input.bytes : Readable.from([Buffer.from(input.bytes)]);
    try {
        input.signal?.throwIfAborted();
        const channel = input.openChannel(['sh', '-c', `umask 077; cat > ${safeBashSingleQuote(input.path)}`]);
        channel.resume();
        const drained = finished(channel);
        const abort = () => { channel.destroy(); };
        input.signal?.addEventListener('abort', abort, { once: true });
        try {
            await Promise.all([drained, pipeline(source, channel), input.waitForCompletion?.(channel)]);
            input.signal?.throwIfAborted();
            return channel;
        } catch (error) {
            input.signal?.throwIfAborted();
            throw error;
        } finally { input.signal?.removeEventListener('abort', abort); }
    } finally { source.destroy(); }
}
