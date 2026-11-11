import type { AttachmentsUploadFileSource, AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { describeAttachmentUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { resolveUploadRelativePath } from '@/sync/domains/transfers/uploadRelativePath';
import { randomUUID } from '@/platform/randomUUID';
import { openLocalUploadSourceReader, resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import {
    isTransferFinalizeRecoveryFailure,
    createTransferFinalizeRecovery,
    retainTransferFinalizeRecovery,
    settleTransferFinalizeRecovery,
    type TransferFinalizeRecoveryFailure,
    uploadDaemonSessionAttachmentFromReader,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import type { SessionAttachmentsUploadFinalizeResponse, SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';

export type AttachmentsUploadLocation = 'workspace' | 'os_temp';
export type VcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentsUploadConfig = Readonly<{
    uploadLocation: AttachmentsUploadLocation;
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: VcsIgnoreStrategy;
    vcsIgnoreWritesEnabled: boolean;
    maxFileBytes: number;
}>;

export type AttachmentsUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

export type SessionAttachmentsUploadFileResult =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string; attachmentHandle?: SessionAttachmentHandleV1 }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
    | TransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>;

function parseOptionalPositiveInt(value: unknown): number | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : undefined;
}

function resolveUploadPreflightSizeTimeoutMs(): number {
    const raw = parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_UPLOAD_PREFLIGHT_SIZE_TIMEOUT_MS);
    const fallback = 2_000;
    const resolved = raw ?? fallback;
    return Math.min(20_000, Math.max(100, resolved));
}

async function resolveSizeBytesWithTimeout(source: AttachmentsUploadFileSource): Promise<
    | Readonly<{ ok: true; value: number | null }>
    | Readonly<{ ok: false; error: string }>
> {
    const timeoutMs = resolveUploadPreflightSizeTimeoutMs();
    return await new Promise((resolve) => {
        const timeoutId = setTimeout(
            () => resolve({ ok: false, error: 'Upload preflight size resolution timed out' } as const),
            timeoutMs,
        );

        resolveLocalUploadSourceSizeBytes(source).then(
            (value) => {
                clearTimeout(timeoutId);
                resolve({ ok: true, value } as const);
            },
            (error) => {
                clearTimeout(timeoutId);
                resolve({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Upload preflight failed to resolve file size',
                } as const);
            },
        );
    });
}

type SessionAttachmentUploadArgs = Readonly<{
    sessionId: string;
    sessionTarget?: ExactSessionMachineTargetIdentity;
    transferContext?: SessionAttachmentTransferContext;
    file: AttachmentUploadSource;
    /** Tray identity is retained in the issued descriptor and scopes a folder's root. */
    attachmentId?: string;
    relativePath?: string;
    directoryEntries?: readonly string[];
    messageLocalId: string;
    config: AttachmentsUploadConfig;
    onProgress?: (progress: AttachmentsUploadProgress) => void;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>;

export async function sessionAttachmentsUploadFile(args: SessionAttachmentUploadArgs): Promise<SessionAttachmentsUploadFileResult> {
    const isCurrent = () => !args.signal?.aborted && (args.isCurrent?.() ?? true);
    const assertCurrent = () => {
        if (!isCurrent()) throw new Error('Upload canceled');
    };
    try {
        assertCurrent();
        if (args.file.kind === 'folder') {
            const folder = args.file;
            const root = resolveUploadRelativePath(args.attachmentId ?? randomUUID(), folder.name);
            if (!root) return { success: false, error: 'Invalid attachment relativePath', errorCode: 'attachment_source_unavailable' };
            const entries = folder.entries.map(entry => ({ ...entry, path: resolveUploadRelativePath(root, entry.relativePath) }));
            if (entries.some(entry => !entry.path)) return { success: false, error: 'Invalid attachment relativePath', errorCode: 'attachment_source_unavailable' };
            let totalBytes = 0;
            for (const entry of entries) {
                const size = await resolveLocalUploadSourceSizeBytes(entry.source);
                assertCurrent();
                if (size == null || size < 0) return { success: false, error: 'Unknown attachment size', errorCode: 'attachment_source_unavailable' };
                if (size > args.config.maxFileBytes) return { success: false, error: 'File exceeds maximum allowed size', errorCode: 'attachment_too_large' };
                totalBytes += size;
            }
            const directories = folder.directories ?? [];
            if (directories.some(directory => !resolveUploadRelativePath(root, directory))) return { success: false, error: 'Invalid attachment directory path', errorCode: 'attachment_source_unavailable' };
            let completedBytes = 0;
            const uploadNext = async (start: number, recovered?: SessionAttachmentsUploadFinalizeResponse): Promise<SessionAttachmentsUploadFileResult> => {
                for (let index = start; index <= entries.length; index += 1) {
                    const entry = entries[index];
                    const result = recovered ?? await sessionAttachmentsUploadFile({ ...args,
                        file: entry ? entry.source : { kind: 'memory', name: folder.name, bytes: new Uint8Array(0) },
                        attachmentId: entry ? undefined : args.attachmentId,
                        relativePath: entry ? entry.path! : root,
                        ...(entry ? {} : { directoryEntries: directories }),
                        onProgress: progress => args.onProgress?.({ uploadedBytes: completedBytes + progress.uploadedBytes, totalBytes }) });
                    recovered = undefined;
                    assertCurrent();
                    if (!result.success) {
                        if (!isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(result)) return result;
                        let activeRecovery = result.recovery;
                        let resumeIndex: number | null = index;
                        return { ...result, recovery: createTransferFinalizeRecovery<SessionAttachmentsUploadFinalizeResponse>({
                            expiresAt: activeRecovery.expiresAt,
                            retryFinalize: async (signal) => {
                                const outcome = await activeRecovery.invoke('retry_finalize', signal);
                                if (outcome.status !== 'finalized' || resumeIndex === null) return activeRecovery.isActionable()
                                    ? retainTransferFinalizeRecovery(outcome) : settleTransferFinalizeRecovery(outcome);
                                const remaining = await uploadNext(resumeIndex, outcome.response);
                                if (remaining.success) return settleTransferFinalizeRecovery({ status: 'finalized', response: remaining });
                                if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(remaining)) {
                                    activeRecovery = remaining.recovery;
                                    resumeIndex = null;
                                    return retainTransferFinalizeRecovery({ status: 'recovery_required', error: remaining.error });
                                }
                                return settleTransferFinalizeRecovery({ status: 'unavailable', reason: 'session_unavailable', error: remaining.error });
                            },
                            discard: async (signal) => {
                                const outcome = await activeRecovery.invoke('discard_staged', signal);
                                return activeRecovery.isActionable() ? retainTransferFinalizeRecovery(outcome) : settleTransferFinalizeRecovery(outcome);
                            },
                        }) };
                    }
                    if (!entry) return { ...result, path: result.path, sizeBytes: completedBytes, sha256: '' };
                    completedBytes += result.sizeBytes;
                }
                throw new Error('Directory upload did not finalize');
            };
            return await uploadNext(0);
        }
        const sourceDescription = describeAttachmentUploadFileSource(args.file);
        let described = { ...sourceDescription, sizeBytes: sourceDescription.sizeBytes ?? -1 };
        if (described.sizeBytes < 0) {
            const resolved = await resolveSizeBytesWithTimeout(args.file);
            assertCurrent();
            if (!resolved.ok) {
                return { success: false, error: resolved.error, errorCode: 'attachment_source_unavailable' };
            }
            if (resolved.value != null) {
                described = { ...described, sizeBytes: resolved.value };
            }
        }

        if (described.sizeBytes < 0) {
            return { success: false, error: 'Unknown attachment size', errorCode: 'attachment_source_unavailable' };
        }
        if (described.sizeBytes > args.config.maxFileBytes) {
            return { success: false, error: 'File exceeds maximum allowed size', errorCode: 'attachment_too_large' };
        }

        const reader = await openLocalUploadSourceReader(args.file);
        let readerClosed = false;
        const closeReaderOnce = async () => {
            if (readerClosed) {
                return;
            }
            readerClosed = true;
            await reader.close();
        };
        try {
            assertCurrent();
            const transferContext = args.transferContext
                ?? (await import('@/sync/sync')).sync.getSessionAttachmentTransferContext(args.sessionId,
                    args.sessionTarget ? { purpose: 'attachmentUpload', target: args.sessionTarget } : undefined);
            assertCurrent();
            if (args.sessionTarget && !transferContext) {
                return { success: false, error: 'Session attachment scope is unavailable', errorCode: 'attachment_session_unavailable' };
            }
            const bulkUpload = await uploadDaemonSessionAttachmentFromReader({
                session: args.sessionTarget ?? args.sessionId,
                transferContext,
                fileReader: {
                    sizeBytes: described.sizeBytes,
                    readBytes: async (offset, length) => {
                        assertCurrent();
                        const bytes = await reader.readBytes(offset, length);
                        assertCurrent();
                        return bytes;
                    },
                    close: async () => await closeReaderOnce(),
                },
                request: {
                    messageLocalId: args.messageLocalId,
                    fileName: described.name,
                    ...(args.attachmentId === undefined ? {} : { attachmentId: args.attachmentId }),
                    ...(args.relativePath === undefined ? {} : { relativePath: args.relativePath }),
                    ...(args.directoryEntries === undefined ? {} : { directoryEntries: [...args.directoryEntries] }),
                    sizeBytes: described.sizeBytes,
                    uploadLocation: args.config.uploadLocation,
                    workspaceRelativeDir: args.config.workspaceRelativeDir,
                    vcsIgnoreStrategy: args.config.vcsIgnoreStrategy,
                    vcsIgnoreWritesEnabled: args.config.vcsIgnoreWritesEnabled,
                },
                onProgress: args.onProgress
                    ? (progress) => {
                        if (!isCurrent()) return;
                        try {
                            args.onProgress?.(progress);
                        } catch {
                            // ignore
                        }
                    }
                    : null,
                ...(args.signal ? { signal: args.signal } : {}),
            });
            assertCurrent();

            if (bulkUpload.success !== true) {
                if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(bulkUpload)) {
                    return bulkUpload;
                }
                return { success: false, error: bulkUpload.error ?? 'Upload failed', errorCode: bulkUpload.errorCode };
            }

            return { success: true, path: bulkUpload.path, sizeBytes: bulkUpload.sizeBytes, sha256: bulkUpload.sha256,
                ...(bulkUpload.attachmentHandle ? { attachmentHandle: bulkUpload.attachmentHandle } : {}) };
        } finally {
            try {
                await closeReaderOnce();
            } catch {
                // ignore
            }
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
