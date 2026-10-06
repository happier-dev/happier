import { SessionImageMediaReferenceV1Schema } from '@happier-dev/protocol/sessions/media/imageReferenceV1';
import type { SessionImageMediaReferenceV1, SessionImageFileReferenceV1 } from '@happier-dev/protocol';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import { persistSessionMedia } from './persistSessionMedia';

export type SessionImageMediaWriterOptions = Readonly<{
    workingDirectory: string;
    storage: 'session' | 'daemon';
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
    accessPolicy?: FilesystemAccessPolicy;
    now?: () => number;
}>;

export type SessionImageMediaWriteResult =
    | Readonly<{ ok: true; media: SessionImageMediaReferenceV1 & { file: SessionImageFileReferenceV1 } }>
    | Readonly<{ ok: false; reason: 'capture_failed'; disabledReason?: string }>;

export type SessionImageMediaWriter = Readonly<{
    write(input: Readonly<{ sessionId: string; captureId: string; png: Buffer }>): Promise<SessionImageMediaWriteResult>;
}>;

/** The caller supplies the Session or daemon storage root; the persistence owner allocates its artifact path. */
export function createSessionImageMediaWriter(options: SessionImageMediaWriterOptions): SessionImageMediaWriter {
    const accessPolicy = options.accessPolicy ?? { kind: 'osUser' as const };
    const now = options.now ?? (() => Date.now());
    return {
        async write(input) {
            try {
                const persisted = await persistSessionMedia({
                    workingDirectory: options.workingDirectory,
                    accessPolicy,
                    sourceAccessPolicy: accessPolicy,
                    pathAllowanceRegistry: options.pathAllowanceRegistry,
                    input: {
                        sessionId: input.sessionId,
                        messageLocalId: input.captureId,
                        role: 'output',
                        category: 'tool-artifact',
                        source: { kind: 'base64', data: input.png.toString('base64'), mimeType: 'image/png',
                            fileNameHint: 'session-image.png' },
                        origin: { source: 'tool-output', toolCallId: input.captureId },
                        suggestedName: 'session-image.png',
                        createdAtMs: now(),
                    },
                });
                if (!persisted.success) return { ok: false, reason: 'capture_failed', disabledReason: persisted.code };
                const { item } = persisted;
                if (item.mediaKind !== 'image' || item.mimeType !== 'image/png'
                    || item.width === undefined || item.height === undefined) {
                    return { ok: false, reason: 'capture_failed', disabledReason: 'screenshot_dimensions_unavailable' };
                }
                const media = SessionImageMediaReferenceV1Schema.required({ file: true }).safeParse({
                    mediaId: item.id, mediaKind: 'image', width: item.width, height: item.height, sizeBytes: item.sizeBytes,
                    file: { sessionId: input.sessionId, storage: options.storage, path: item.path,
                        sha256: item.sha256, mimeType: item.mimeType },
                });
                return media.success ? { ok: true, media: media.data }
                    : { ok: false, reason: 'capture_failed', disabledReason: 'screenshot_media_unavailable' };
            } catch {
                return { ok: false, reason: 'capture_failed' };
            }
        },
    };
}
