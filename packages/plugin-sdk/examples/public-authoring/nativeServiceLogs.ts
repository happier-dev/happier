import type { Disposable } from '@happier-dev/plugin-sdk';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import type {
    ManagedServiceNativeInstanceV1,
    ManagedServiceNativeLifecycleV1,
    ManagedServiceNativeLogReadV1,
    ManagedServiceNativeLogResultV1,
    ManagedServiceNativeLogWatchV1,
} from '@happier-dev/plugin-sdk/managed-services';

/** Machine-native invocation only; the manifest declares this read-only location.
 * Metadata is a wakeup, never permission to disclose content. The consumer keeps
 * its native generation/redaction checks and bounded log reader. */
export async function withNativeLogMetadata(input: Readonly<{
    fs: Pick<FileSystemService, 'observeMachinePath'>;
    absolutePath: string;
    changed: Parameters<FileSystemService['observeMachinePath']>[1];
    signal: AbortSignal;
    consume(observation: Awaited<ReturnType<FileSystemService['observeMachinePath']>>): Promise<void>;
}>): Promise<void> {
    const observation = await input.fs.observeMachinePath(
        { absolutePath: input.absolutePath }, input.changed, { signal: input.signal },
    );
    try {
        await input.consume(observation);
    } finally {
        await observation.dispose();
    }
}

/** Snapshot-only adapter: the host owns the byte budget and native IO is already redacted. */
export function createBoundedNativeServiceLogs(
    read: (instance: ManagedServiceNativeInstanceV1, signal?: AbortSignal) =>
        Promise<Readonly<{ sourceRevision: string; redactedText: string }>>,
): NonNullable<ManagedServiceNativeLifecycleV1['logs']> {
    function logs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogReadV1): Promise<ManagedServiceNativeLogResultV1>;
    function logs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogWatchV1): Promise<Disposable>;
    async function logs(
        instance: ManagedServiceNativeInstanceV1,
        request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1,
    ): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
        request.signal?.throwIfAborted();
        if (request.kind === 'watch') {
            request.emit({ kind: 'unavailable', reason: 'unsupported' });
            return { dispose() {} };
        }
        const snapshot = await read(instance, request.signal);
        request.signal?.throwIfAborted();
        if (request.cursor && request.cursor.sourceRevision !== snapshot.sourceRevision) {
            return { kind: 'source-changed', sourceRevision: snapshot.sourceRevision };
        }
        const encoder = new TextEncoder();
        const characters: string[] = [];
        let remaining = request.maxBytes;
        for (const character of snapshot.redactedText) {
            const bytes = encoder.encode(character).byteLength;
            if (bytes > remaining) break;
            characters.push(character);
            remaining -= bytes;
        }
        const text = characters.join('');
        return { kind: 'page', page: {
            sourceRevision: snapshot.sourceRevision,
            text,
            nextCursor: null,
            truncated: text.length < snapshot.redactedText.length,
        } };
    }
    return logs;
}
