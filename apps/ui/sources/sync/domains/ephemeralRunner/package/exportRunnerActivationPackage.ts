import { Platform } from 'react-native';
import { createWebDownloadFileSink } from '@/hooks/workspaces/transfers/webDownloadFileSink';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { assembleRunnerActivationPackage, type RunnerPackageAssemblyInput } from './assembleRunnerActivationPackage';
import { readRunnerActivationExportFile } from '../runnerActivationCustody';
import type { BulkTransferFileDestination } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/bulkTransferFileDestination';

export type RunnerPackageExportInput = Omit<RunnerPackageAssemblyInput, 'destination' | 'activationFile'>
    & Parameters<typeof readRunnerActivationExportFile>[0];

function resolveZipFormatBound(input: RunnerPackageAssemblyInput['artifactMetadata'], activationBytes: number): number {
    const outputNames = new Set<string>();
    for (const entry of input.entries) {
        outputNames.add(entry.kind === 'directory' ? `${entry.path}/` : entry.path);
        const parts = entry.path.split('/');
        for (let count = 1; count < parts.length; count += 1) outputNames.add(`${parts.slice(0, count).join('/')}/`);
    }
    outputNames.add('happier-runner.activation.json');
    const expandedPayloadBytes = input.entries
        .filter((entry) => entry.kind !== 'directory')
        .reduce((sum, entry) => sum + entry.sizeBytes, 0);
    // EOCD + its 16-bit comment maximum + the fixed ZIP64 EOCD/locator emitted
    // by the selected writer when ZIP64 is required.
    let total = activationBytes + expandedPayloadBytes + 65_633;
    for (const name of outputNames) {
        const nameBytes = new TextEncoder().encode(name).byteLength;
        // ZIP format maxima per output entry: local header (30), central header
        // (46), both 16-bit extra fields, the central 16-bit comment, a ZIP64
        // data descriptor (24), and the exact encoded name in both headers.
        total += 196_705 + (2 * nameBytes);
    }
    if (!Number.isSafeInteger(total)) throw new Error('runner_package_output_size_unsupported');
    return total;
}

function boundedDestination(destination: BulkTransferFileDestination & { cleanup: () => Promise<void> }, maxBytes: number) {
    let written = 0;
    return { ...destination, writeBytes: async (bytes: Uint8Array) => {
        written += bytes.byteLength;
        if (written > maxBytes) {
            await destination.cleanup();
            throw new Error('runner_package_output_size_unsupported');
        }
        await destination.writeBytes(bytes);
    } };
}

/** Export stays on the creator device; Home receives neither the ZIP nor signing key. */
export async function exportRunnerActivationPackage(input: RunnerPackageExportInput): Promise<void> {
    const activation = await readRunnerActivationExportFile(input);
    const outputMaxBytes = resolveZipFormatBound(input.artifactMetadata, new TextEncoder().encode(JSON.stringify(activation)).byteLength);
    const fileName = `temporary-computer-${activation.activation.artifact.target}.zip`;
    if (Platform.OS === 'web') {
        const sink = await createWebDownloadFileSink({ expectedSizeBytes: outputMaxBytes, maxBytes: outputMaxBytes, requireFileBacked: true });
        let handedOff = false;
        try {
            await assembleRunnerActivationPackage({ ...input, activationFile: activation, destination: boundedDestination(sink, outputMaxBytes) });
            if (input.signal?.aborted) throw new Error('runner_package_canceled');
            const file = await sink.getFile();
            downloadWebFile(file, fileName, sink.cleanup);
            handedOff = true;
        } finally {
            if (!handedOff) await sink.cleanup();
        }
        return;
    }
    const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName });
    if (!sink.ok) throw new Error('runner_package_export_unavailable');
    let retainCacheFile = false;
    try {
        await assembleRunnerActivationPackage({ ...input, activationFile: activation, destination: boundedDestination(sink, outputMaxBytes) });
        if (input.signal?.aborted) throw new Error('runner_package_canceled');
        const result = await shareNativeCacheFile({
            fileUri: sink.fileUri, name: fileName, mimeType: 'application/zip', UTI: 'public.zip-archive',
            isCurrent: () => !input.signal?.aborted,
        });
        if (result.status === 'canceled') throw new Error('runner_package_canceled');
        if (result.status === 'unavailable') throw new Error('runner_package_export_unavailable');
        retainCacheFile = result.retainCacheFile;
    } finally {
        if (!retainCacheFile) await sink.cleanup();
    }
}
