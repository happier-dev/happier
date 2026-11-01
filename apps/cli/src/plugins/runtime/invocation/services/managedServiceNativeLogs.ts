import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeLogReadV1, ManagedServiceNativeLogWatchV1 } from '@happier-dev/plugin-sdk/managed-services';
import { ManagedServiceNativeLogResultV1Schema, type ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { sanitizeExecDiagnosticText } from '../../exec/errors';

export { MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES } from './managedServiceNativeLogBudget';

/** Disclosure choice stays inside the verified CLI host invocation. */
export type ManagedServiceNativeLogReadForHost = ManagedServiceNativeLogReadV1 & Readonly<{
    allowIncompleteSecretMasking?: true;
}>;
export type ManagedServiceNativeLogReadOptionsForHost = Omit<ManagedServiceNativeLogReadForHost, 'kind' | 'maxBytes'>;

/** Read and push share the supervisor's generation, redaction and byte boundary.
 * Subscriptions are cleanup custody of this process observation, never a registry. */
export function createManagedServiceNativeLogs(input: Readonly<{
    signal: AbortSignal;
    maxBytes: number;
    isCurrent(): boolean;
    redactedValues(): readonly string[];
    invoke?(request: ManagedServiceNativeLogReadForHost | ManagedServiceNativeLogWatchV1): Promise<ManagedServiceNativeLogResultV1 | Disposable>;
}>) {
    const watches = new Set<Readonly<{ dispose(): Promise<void> }>>();
    const normalize = (value: unknown, sourceRevision?: string): ManagedServiceNativeLogResultV1 => {
        const result = ManagedServiceNativeLogResultV1Schema.parse(value);
        if (result.kind !== 'page') return result;
        if (sourceRevision !== undefined && result.page.sourceRevision !== sourceRevision)
            return { kind: 'source-changed', sourceRevision: result.page.sourceRevision };
        return { kind: 'page', page: { ...result.page,
            text: sanitizeExecDiagnosticText(result.page.text, input.maxBytes, { redactedValues: input.redactedValues() }),
            truncated: result.page.truncated || Buffer.byteLength(result.page.text, 'utf8') > input.maxBytes,
        } };
    };
    return {
        async read(options?: ManagedServiceNativeLogReadOptionsForHost): Promise<ManagedServiceNativeLogResultV1> {
            if (!input.invoke) return { kind: 'unavailable', reason: 'unsupported' };
            if (!input.isCurrent()) return { kind: 'unavailable', reason: 'admission_unavailable' };
            const signal = AbortSignal.any([input.signal, ...(options?.signal ? [options.signal] : [])]);
            signal.throwIfAborted();
            const result = await input.invoke({ kind: 'read', maxBytes: input.maxBytes,
                ...(options?.cursor ? { cursor: options.cursor } : {}), signal,
                ...(options?.allowIncompleteSecretMasking ? { allowIncompleteSecretMasking: true } : {}) });
            signal.throwIfAborted();
            if (!input.isCurrent()) return { kind: 'unavailable', reason: 'admission_unavailable' };
            return normalize(result, options?.cursor?.sourceRevision);
        },
        async watch(options: Omit<ManagedServiceNativeLogWatchV1, 'kind' | 'maxBytes'>): Promise<Readonly<{ dispose(): Promise<void> }>> {
            const lifetime = new AbortController();
            const signal = AbortSignal.any([input.signal, lifetime.signal, ...(options.signal ? [options.signal] : [])]);
            signal.throwIfAborted();
            if (!input.isCurrent()) throw new PluginError({ code: 'plugin_managed_service_unavailable' });
            let sourceRevision = options.cursor?.sourceRevision;
            let sourceRetired = false;
            const emit = (value: ManagedServiceNativeLogResultV1) => {
                if (signal.aborted || sourceRetired || !input.isCurrent()) return;
                const result = normalize(value, sourceRevision);
                if (result.kind === 'page') sourceRevision ??= result.page.sourceRevision;
                if (result.kind === 'source-changed') sourceRetired = true;
                try { options.emit(result); }
                finally { if (sourceRetired) void watch.dispose().catch(() => {}); }
            };
            if (!input.invoke) {
                emit({ kind: 'unavailable', reason: 'unsupported' });
                return { async dispose() { lifetime.abort(); } };
            }
            let disposal: Promise<void> | undefined;
            let subscription: Promise<Disposable>;
            const watch = { dispose: () => disposal ??= Promise.resolve().then(async () => {
                lifetime.abort();
                signal.removeEventListener('abort', onAbort);
                await (await subscription).dispose();
                watches.delete(watch);
            }) };
            const onAbort = () => { void watch.dispose().catch(() => {}); };
            watches.add(watch);
            // Install cleanup before invoking the producer: it may emit or abort synchronously.
            subscription = Promise.resolve().then(async () => {
                signal.throwIfAborted();
                const result = await input.invoke!({ kind: 'watch', maxBytes: input.maxBytes,
                    ...(options.cursor ? { cursor: options.cursor } : {}), signal, emit });
                if (!('dispose' in result) || typeof result.dispose !== 'function') {
                    throw new PluginError({ code: 'plugin_managed_service_unavailable' });
                }
                return result;
            }).catch(error => {
                // A failed install has no native subscription to retain. In
                // particular, pre-install cancellation must not poison teardown.
                watches.delete(watch);
                throw error;
            });
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                await subscription;
                if (sourceRetired) { await watch.dispose(); return watch; }
                if (signal.aborted || !input.isCurrent()) {
                    await watch.dispose();
                    signal.throwIfAborted();
                    throw new PluginError({ code: 'plugin_managed_service_unavailable' });
                }
                return watch;
            } catch (error) {
                signal.removeEventListener('abort', onAbort);
                if (!disposal) watches.delete(watch);
                throw error;
            }
        },
        async dispose() { await Promise.all([...watches].map(watch => watch.dispose())); },
    };
}
