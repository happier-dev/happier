import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import type { ManagedServiceNativeLogReadForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { createProviderRedactionLease, type ProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

type NativeLogCapture = Pick<Parameters<ProjectNativeToolchainIo['run']>[0],
    'output' | 'maxStdoutBytes' | 'maxStderrBytes' | 'allowTruncatedStdout'>;

/** Warm and cold readers share the same generation page and masking owner. */
export async function readNativeComposeLogsForHost(input: Readonly<{
    containerIds: readonly string[];
    observedIds?: readonly string[];
    environment?: boolean;
    redactionLease?: ProviderRedactionLease;
    redactionComplete?: boolean;
    run(args: readonly string[], signal?: AbortSignal, capture?: NativeLogCapture): Promise<Readonly<{ exitCode: number | null }>>;
}>, options: ManagedServiceNativeLogReadForHost): Promise<ManagedServiceNativeLogResultV1> {
    const assertRedaction = () => {
        const missingOriginalMasking = Boolean((input.environment || input.redactionLease) && !input.redactionLease?.isActive());
        const incomplete = input.redactionComplete === false || missingOriginalMasking;
        if (incomplete && !options.allowIncompleteSecretMasking) {
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
    };
    options.signal?.throwIfAborted();
    assertRedaction();
    if (!input.containerIds.length) return { kind: 'unavailable', reason: 'admission_unavailable' };
    const sourceRevision = JSON.stringify([...input.containerIds].sort());
    const observedRevision = input.observedIds ? JSON.stringify([...input.observedIds].sort()) : sourceRevision;
    if (observedRevision !== sourceRevision || options.cursor && options.cursor.sourceRevision !== sourceRevision) {
        return { kind: 'source-changed', sourceRevision: observedRevision };
    }
    const bytes = Buffer.alloc(options.maxBytes);
    let used = 0;
    let truncated = false;
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
            const result = await input.run(['logs', '--tail', String(options.maxBytes), id], options.signal, {
                maxStdoutBytes: 0, maxStderrBytes: 0, allowTruncatedStdout: true,
                output: { redaction, onChunk(_stream, chunk) { append(chunk); } },
            });
            if (result.exitCode !== 0) return { kind: 'unavailable', reason: 'unavailable' };
        }
        options.signal?.throwIfAborted();
        const incomplete = assertRedaction();
        return { kind: 'page', page: { sourceRevision,
            text: new TextDecoder('utf-8').decode(bytes.subarray(0, used), { stream: true }),
            nextCursor: null, truncated,
            ...(incomplete ? { secretMasking: 'incomplete' as const } : {}) } };
    } finally { temporaryRedaction?.close(); }
}
