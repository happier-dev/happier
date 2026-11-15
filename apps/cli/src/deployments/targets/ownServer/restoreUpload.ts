import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentRestoreDestinationV1, DeploymentRestoreNativeRequestV1, DeploymentRestoreNativeResultV1 } from '@happier-dev/deployments';
import type { DeploymentRestoreUploadFormatV1 } from '@happier-dev/deployment-protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { configuration } from '@/configuration';
import { readTransferPayloadChunk, type TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { AdmittedDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
import { admitPsqlInput } from './dataQuery';

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
    async function* chunks() {
        let offset = 0;
        while (offset < input.upload.sizeBytes) {
            input.signal.throwIfAborted();
            const chunk = await readTransferPayloadChunk({ source, offset,
                length: Math.min(configuration.filesTransferChunkBytes, input.upload.sizeBytes - offset) });
            if (!chunk.length) throw new PluginError({ code: 'restore_upload_unavailable',
                message: 'The admitted upload reader ended before its complete payload' });
            offset += chunk.length;
            yield chunk;
        }
    }
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
    await admitPsqlInput(chunks(), 'dump');
    return 'postgresSql';
}
