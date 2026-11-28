import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ManagedServiceNativeLogWatchV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import type { ManagedServiceNativeLogReadForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { createProviderRedactionLease, type ProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

type NativeLogCapture = Pick<Parameters<ProjectNativeToolchainIo['run']>[0],
    'output' | 'maxStdoutBytes' | 'maxStderrBytes' | 'allowTruncatedStdout'>;

type NativeComposeLogSource = Readonly<{
    containerIds: readonly string[];
    observedIds?: readonly string[];
    environment?: boolean;
    redactionLease?: ProviderRedactionLease;
    redactionComplete?: boolean;
    inspectContainerLog?: Readonly<{ id: string; read(text: string): void }>;
    run(args: readonly string[], signal?: AbortSignal, capture?: NativeLogCapture): Promise<Readonly<{ exitCode: number | null }>>;
}>;

function assertRedaction(input: NativeComposeLogSource, allowIncompleteSecretMasking?: true): boolean {
    const missingOriginalMasking = Boolean((input.environment || input.redactionLease) && !input.redactionLease?.isActive());
    const incomplete = input.redactionComplete === false || missingOriginalMasking;
    if (incomplete && !allowIncompleteSecretMasking) {
        throw new PluginError({ code: 'secret_redaction_unavailable',
            message: missingOriginalMasking ? 'Redeploy the Environment to restore service log secret masking'
                : 'Service log secret masking is unavailable',
            ...(missingOriginalMasking ? {
                details: { reason: 'secret_redaction_redeploy_required', remedy: 'redeploy_environment', retryable: false },
                failureCause: { phase: 'service.logs.redaction', errorClass: 'Error',
                    errorCode: 'secret_redaction_redeploy_required', httpStatus: null },
            } : {}),
        });
    }
    return incomplete;
}

function readLogSource(input: NativeComposeLogSource, options: Pick<ManagedServiceNativeLogReadForHost, 'cursor'>):
    Readonly<{ sourceRevision: string; kind?: never }> | Exclude<ManagedServiceNativeLogResultV1, { kind: 'page' }> {
    if (!input.containerIds.length) return { kind: 'unavailable', reason: 'admission_unavailable' };
    const sourceRevision = JSON.stringify([...input.containerIds].sort());
    const observedRevision = input.observedIds ? JSON.stringify([...input.observedIds].sort()) : sourceRevision;
    if (observedRevision !== sourceRevision || options.cursor && options.cursor.sourceRevision !== sourceRevision) {
        return { kind: 'source-changed' as const, sourceRevision: observedRevision };
    }
    return { sourceRevision };
}

/** Warm and cold readers share the same generation page and masking owner. */
export async function readNativeComposeLogsForHost(input: NativeComposeLogSource,
    options: ManagedServiceNativeLogReadForHost): Promise<ManagedServiceNativeLogResultV1> {
    options.signal?.throwIfAborted();
    assertRedaction(input, options.allowIncompleteSecretMasking);
    const source = readLogSource(input, options);
    if (source.kind) return source;
    const { sourceRevision } = source;
    const bytes = Buffer.alloc(options.maxBytes);
    let used = 0;
    let truncated = false;
    let inspection: { start: number; end: number } | undefined;
    const append = (chunk: Uint8Array) => {
        const length = Math.min(chunk.byteLength, bytes.byteLength - used);
        bytes.set(chunk.subarray(0, length), used);
        used += length;
        truncated ||= length < chunk.byteLength;
    };
    // Explicitly permitted incomplete masking still uses the same native
    // streaming boundary, with no secret material invented for that path.
    const temporaryRedaction = input.redactionLease?.isActive() ? undefined : createProviderRedactionLease({ values: [] });
    const redaction = temporaryRedaction ?? input.redactionLease!;
    try {
        for (const [index, id] of input.containerIds.entries()) {
            if (index) append(Buffer.from('\n'));
            // Docker selects lines, whose lengths are unbounded. Only this
            // byte projection retains output; the process result buffers none.
            const start = used;
            const result = await input.run(['logs', '--tail', String(options.maxBytes), id], options.signal, {
                maxStdoutBytes: 0, maxStderrBytes: 0, allowTruncatedStdout: true,
                output: { redaction, onChunk(_stream, chunk) { append(chunk); } },
            });
            if (result.exitCode !== 0) return { kind: 'unavailable', reason: 'unavailable' };
            if (id === input.inspectContainerLog?.id) inspection = { start, end: used };
        }
        options.signal?.throwIfAborted();
        const incomplete = assertRedaction(input, options.allowIncompleteSecretMasking);
        if (inspection && !incomplete) {
            input.inspectContainerLog?.read(new TextDecoder().decode(bytes.subarray(inspection.start, inspection.end), { stream: true }));
        }
        return { kind: 'page', page: { sourceRevision,
            text: new TextDecoder('utf-8').decode(bytes.subarray(0, used), { stream: true }),
            nextCursor: null, truncated,
            ...(incomplete ? { secretMasking: 'incomplete' as const } : {}) } };
    } finally { temporaryRedaction?.close(); }
}

/** Follow the same exact container generation using Docker's push streams. */
export function watchNativeComposeLogsForHost(input: NativeComposeLogSource, options: ManagedServiceNativeLogWatchV1) {
    options.signal?.throwIfAborted();
    assertRedaction(input);
    const source = readLogSource(input, options);
    if (source.kind) {
        options.emit(source);
        return { async dispose() {} };
    }
    const lifetime = new AbortController();
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    const temporaryRedaction = input.redactionLease ? undefined : createProviderRedactionLease({ values: [] });
    const redaction = input.redactionLease ?? temporaryRedaction!;
    let sequence = 0;
    const end = (reason: 'unavailable' | 'secret_redaction_unavailable') => {
        if (signal.aborted) return;
        try { options.emit({ kind: 'unavailable', reason }); }
        finally { lifetime.abort(); }
    };
    const settled = Promise.allSettled(input.containerIds.map(async id => {
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        try {
            await input.run(['logs', '--follow', '--tail', '0', id], signal, {
                maxStdoutBytes: 0, maxStderrBytes: 0, allowTruncatedStdout: true,
                output: { redaction, onChunk(stream, chunk) {
                    if (signal.aborted) return;
                    if (!redaction.isActive()) { end('secret_redaction_unavailable'); return; }
                    for (let offset = 0; offset < chunk.length && !signal.aborted; offset += options.maxBytes) {
                        const text = decoders[stream].decode(chunk.subarray(offset, offset + options.maxBytes), { stream: true });
                        if (text) options.emit({ kind: 'page', page: { sourceRevision: source.sourceRevision,
                            text, nextCursor: null, truncated: false, rowId: String(++sequence) } });
                    }
                } },
            });
        } catch (error) {
            if (error instanceof PluginError && error.code === 'plugin_exec_termination_incomplete') throw error;
        } finally { end('unavailable'); }
    })).finally(() => temporaryRedaction?.close());
    return { async dispose() {
        lifetime.abort();
        const failed = (await settled).find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    } };
}
