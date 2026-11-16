import { posix } from 'node:path';
import { Parser, type ReadEntry } from 'tar';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentRestoreDestinationV1, DeploymentRestoreNativeRequestV1, DeploymentRestoreNativeResultV1 } from '@happier-dev/deployments';
import type { DeploymentRestoreUploadFormatV1 } from '@happier-dev/deployment-protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { configuration } from '@/configuration';
import { readTransferPayloadChunk, type TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { AdmittedDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
import { admitPsqlInput } from './dataQuery';

async function* readUploadChunks(upload: AdmittedDeploymentRestoreUpload, signal: AbortSignal) {
    const source: TransferPayloadSource = { kind: 'native', sizeBytes: upload.sizeBytes,
        manifestHash: `sha256:${upload.sha256}`, readChunk: upload.readChunk };
    let offset = 0;
    while (offset < upload.sizeBytes) {
        signal.throwIfAborted();
        const chunk = await readTransferPayloadChunk({ source, offset,
            length: Math.min(configuration.filesTransferChunkBytes, upload.sizeBytes - offset) });
        if (!chunk.length) throw new PluginError({ code: 'restore_upload_unavailable',
            message: 'The admitted upload reader ended before its complete payload' });
        offset += chunk.length;
        yield chunk;
    }
}

const escapesRoot = (path: string) => posix.isAbsolute(path) || path.split('/').includes('..');

/** A workload writes its own volume, so its archive is untrusted. The image's
 * tar sanitizes names in both its listing and extraction, which hides hostile
 * members, so admission reads the raw headers before any native reader runs.
 * Strict parsing fails on headers it cannot read, and an ignored entry (an
 * unknown type or an oversized extension header) fails too: the native tar
 * might apply it. */
async function admitVolumeArchiveMembers(upload: AdmittedDeploymentRestoreUpload, signal: AbortSignal): Promise<void> {
    let refused = false;
    const parser = new Parser({ strict: true });
    const settled = new Promise<void>((resolve, reject) => {
        const check = (entry: ReadEntry) => {
            entry.resume();
            const path = entry.path.replace(/\/+$/u, '');
            const link = entry.linkpath;
            if (entry.ignore || escapesRoot(path)
                || entry.type === 'Link' && (!link || escapesRoot(link))
                || entry.type === 'SymbolicLink' && (!link || escapesRoot(posix.join(posix.dirname(path), link))
                    || posix.isAbsolute(link))) refused = true;
            if (refused) reject(new Error('archive member refused'));
        };
        parser.on('entry', check);
        parser.on('ignoredEntry', check);
        parser.on('error', reject);
        parser.on('end', () => resolve());
    });
    settled.catch(() => { refused = true; });
    for await (const chunk of readUploadChunks(upload, signal)) {
        if (refused) break;
        parser.write(chunk);
    }
    if (!refused) parser.end();
    await settled.catch(() => {
        throw new PluginError({ code: 'backup_integrity_failed', message: 'The archive has a member that cannot be restored inside its volume' });
    });
}

/** Finite transfer owns bytes and scope. The destination's actual tool/grammar
 * owns format admission, before a safety backup or destination mutation. */
export async function admitOwnServerRestoreUpload(input: Readonly<{
    upload: AdmittedDeploymentRestoreUpload; operationId: string;
    destination: DeploymentRestoreDestinationV1;
    signal: AbortSignal;
    execute(request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1>;
}>): Promise<DeploymentRestoreUploadFormatV1> {
    if (input.destination.adapter === 'sqlite-v1') {
        const result = await input.execute({ kind: 'sqliteStage', destination: input.destination, operationId: input.operationId,
            source: { kind: 'upload', transferId: input.upload.transferId, sizeBytes: input.upload.sizeBytes, sha256: input.upload.sha256 } });
        if (result.kind !== 'completed') throw new PluginError({ code: 'outcome_unknown', message: 'The SQLite preflight did not settle' });
        if (result.exitCode !== 0) throw new PluginError({ code: 'backup_integrity_failed', message: 'The SQLite API refused the uploaded database' });
        return 'sqlite';
    }
    if (input.destination.adapter === 'volume-v1') {
        await admitVolumeArchiveMembers(input.upload, input.signal);
        const result = await input.execute({ kind: 'volumeArchive', mode: 'list', source: { kind: 'upload',
            transferId: input.upload.transferId, sizeBytes: input.upload.sizeBytes, sha256: input.upload.sha256 } });
        if (result.kind !== 'completed') throw new PluginError({ code: 'outcome_unknown', message: 'The archive preflight did not settle' });
        if (result.exitCode !== 0) throw new PluginError({ code: 'backup_integrity_failed', message: 'The native TAR reader refused the archive',
            details: projectNativeJsonValueForTransport({ nativeFailure: { exitCode: result.exitCode, stderr: result.stderr, stderrTruncated: result.stderrTruncated } }) });
        return 'volumeTar';
    }
    if (input.destination.adapter !== 'postgres-v1') throw new PluginError({ code: 'unsupported_action',
        message: 'The selected destination has no native upload adapter' });
    const source: TransferPayloadSource = { kind: 'native', sizeBytes: input.upload.sizeBytes,
        manifestHash: `sha256:${input.upload.sha256}`, readChunk: input.upload.readChunk };
    // This prefix only selects the proving tool; it is never format proof.
    const prefixChunks: Buffer[] = [];
    const prefixLength = Math.min(5, input.upload.sizeBytes);
    let prefixOffset = 0;
    while (prefixOffset < prefixLength) {
        input.signal.throwIfAborted();
        const chunk = await readTransferPayloadChunk({ source, offset: prefixOffset, length: prefixLength - prefixOffset });
        if (!chunk.length) throw new PluginError({ code: 'restore_upload_unavailable',
            message: 'The admitted upload reader ended before its complete payload' });
        prefixChunks.push(chunk);
        prefixOffset += chunk.length;
    }
    const prefix = Buffer.concat(prefixChunks);
    if (prefix.equals(Buffer.from('PGDMP'))) {
        const result = await input.execute({ kind: 'restoreUpload', source: { kind: 'upload',
            transferId: input.upload.transferId, sizeBytes: input.upload.sizeBytes, sha256: input.upload.sha256 },
            consumer: { mode: 'exec', service: input.destination.service, argv: ['pg_restore', '--list'], environmentOverrides: {} } });
        if (result.kind !== 'completed') throw new PluginError({ code: 'outcome_unknown',
            message: 'The archive format preflight did not settle' });
        if (result.exitCode !== 0) throw new PluginError({ code: 'backup_integrity_failed',
            message: 'The native archive reader refused the uploaded archive',
            details: projectNativeJsonValueForTransport({ nativeFailure: { exitCode: result.exitCode, stderr: result.stderr, stderrTruncated: result.stderrTruncated } }) });
        return 'postgresCustom';
    }
    await admitPsqlInput(readUploadChunks(input.upload, input.signal), 'dump');
    return 'postgresSql';
}
